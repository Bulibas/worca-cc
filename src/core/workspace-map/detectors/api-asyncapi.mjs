// api-asyncapi: AsyncAPI 2.x and 3.x documents (YAML or JSON, any file name).
// Direction is from the DESCRIBED APPLICATION's point of view (AsyncAPI spec text; spec §6.1):
//   2.x  channels.<name>.subscribe = "messages produced by the application"  → provides topic
//        channels.<name>.publish   = "messages consumed by the application"  → consumes topic
//   3.x  operations.<id>.action send → provides, receive → consumes; the topic is the
//        referenced channel's `address` (else the channel key)
import { splitLines, fact, blankComments, onePerKey, cleanUnresolved } from './lib/text.mjs';
import { loadYaml, nodeAt, entries } from './lib/yaml.mjs';
import { LIMITS } from '../../../shared/workspace-map/limits.mjs';

const GATE_RE = /(?:^|[{,])[ \t]*["']?asyncapi["']?[ \t]*:[ \t]*["']?[23]\./m;
const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

function detect({ rel, text }, ctx) {
  if (!GATE_RE.test(text)) return undefined;
  const lines = splitLines(text);
  const json = /\.json$/i.test(rel);
  const y = loadYaml(json ? blankComments(text, { slash: true, quotes: '"' }) : text, { json, maxBytes: LIMITS.MAX_FILE_BYTES });
  const facts = [];
  const unresolved = y.errors.length ? [{ kind: 'topic', raw: rel, file: rel, line: 1, reason: `parse error: ${y.errors[0]}` }] : [];
  for (const { doc, root, js } of y.docs) {
    const version = String(js?.asyncapi ?? '');
    if (!/^[23]\./.test(version)) continue;
    const channels = entries(doc, nodeAt(doc, root, ['channels']));
    if (version.startsWith('2.')) {
      for (const ch of channels) {
        const line = y.lineOf(ch.keyNode);
        for (const op of entries(doc, ch.value)) {
          const dir = op.key === 'subscribe' ? 'provides' : op.key === 'publish' ? 'consumes' : null;
          if (!dir) continue;
          const opId = nodeAt(doc, op.value, ['operationId'])?.value;
          facts.push(fact({ kind: 'topic', dir, key: ch.key, rel, lines, line, needle: ch.key, detail: ['AsyncAPI 2', op.key, opId].filter(Boolean).join(' '), confidence: 'exact' }));
        }
      }
      continue;
    }
    const address = new Map();
    for (const ch of channels) {
      const a = nodeAt(doc, ch.value, ['address']);
      address.set(ch.key, { name: typeof a?.value === 'string' ? a.value : ch.key, line: y.lineOf(a) || y.lineOf(ch.keyNode) });
    }
    for (const op of entries(doc, nodeAt(doc, root, ['operations']))) {
      const action = nodeAt(doc, op.value, ['action'])?.value;
      const dir = action === 'send' ? 'provides' : action === 'receive' ? 'consumes' : null;
      const ref = nodeAt(doc, op.value, ['channel', '$ref'])?.value;
      const chKey = typeof ref === 'string' ? decode(ref.replace(/^#\/channels\//, '')).replace(/~1/g, '/').replace(/~0/g, '~') : null;
      const ch = chKey ? address.get(chKey) : null;
      if (!dir || !ch) {
        unresolved.push({ kind: 'topic', raw: `operations.${op.key}`, file: rel, line: y.lineOf(op.keyNode) || 1, reason: dir ? 'unresolved channel $ref' : 'unknown action' });
        continue;
      }
      facts.push(fact({ kind: 'topic', dir, key: ch.name, rel, lines, line: ch.line, needle: ch.name, detail: `AsyncAPI 3 ${action} ${op.key}`, confidence: 'exact' }));
    }
  }
  return { facts: onePerKey(facts), unresolved: cleanUnresolved(ctx?.state, rel, unresolved) };
}

export default Object.freeze({
  id: 'api-asyncapi',
  claims: (rel) => /\.(ya?ml|json)$/i.test(rel),
  detect,
});
