// api-openapi: OpenAPI 3.x / Swagger 2.0 documents (YAML or JSON, any file name).
//   provides  http '<METHOD> <path>' for every paths × method (the `paths` key as written —
//             server / basePath prefixes go in `detail`, so a consumer's longer URL still
//             suffix-matches)
//   consumes  the same operations when the document describes ANOTHER member's API: a
//             `servers[].url` (or Swagger `host`) that names another member (key, name or
//             directory basename) under P1's host rule — an internal-shaped host by its first DNS
//             label, a public dotted host only as a whole — and is not one of THIS member's own
//             name words (`http://billing:8080` in billing-api's spec is its own API). Those facts
//             carry target = that host.
// A spec under third_party/, thirdparty/, external/ or vendor*/ describes a third party's API:
// no facts, one `unresolved` item (a vendored Stripe spec is not what this member serves).
import { basename } from 'node:path';
import { splitLines, fact, blankComments, onePerKey, cleanUnresolved } from './lib/text.mjs';
import { loadYaml, nodeAt, entries } from './lib/yaml.mjs';
import { splitAuthority, aliasOf, internalHost } from './lib/urls.mjs';
import { hostName } from '../../../shared/workspace-map/keys.mjs';
import { LIMITS } from '../../../shared/workspace-map/limits.mjs';

const METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const GATE_RE = /(?:^|[{,])[ \t]*["']?(openapi|swagger)["']?[ \t]*:[ \t]*["']?[23]\./m;
const SKIP_RE = /(^|\/)(package(-lock)?\.json|tsconfig[\w.-]*\.json|composer\.(json|lock)|[\w.-]*\.lock|pnpm-lock\.yaml|yarn\.lock)$/i;
const VENDORED_RE = /(^|\/)(third[_-]?party|external|vendor[^/]*)\//i;

/** Lower-cased names a member goes by (key, name, dir / projectDir basenames). */
const namesOf = (m) => [m?.key, m?.name, m?.dir && basename(m.dir), m?.projectDir && basename(m.projectDir)]
  .filter((x) => typeof x === 'string' && x).map((x) => x.toLowerCase());

/** The member (≠ own) a server host names under P1's host rule, else null: an internal-shaped
 *  host by its first DNS label, a public dotted host only as a whole; never a label that is one of
 *  this member's own name words (billing-api's own spec served as `billing`). */
function otherMemberForHost(ctx, host) {
  const whole = hostName(host);
  if (!whole) return null;
  const label = internalHost(whole) ? aliasOf(host) : whole;
  if (!label) return null;
  const own = new Set(namesOf(ctx.member).flatMap((n) => [n, ...n.split(/[-_.]+/)]));
  if (own.has(label)) return null;
  for (const m of ctx.members || []) {
    if (m.key !== ctx.member?.key && namesOf(m).includes(label)) return m;
  }
  return null;
}

function detect({ rel, text }, ctx) {
  if (!GATE_RE.test(text)) return undefined;
  if (VENDORED_RE.test(rel)) return { unresolved: cleanUnresolved(ctx?.state, rel, [{ kind: 'http', raw: rel, file: rel, line: 1, reason: 'third-party spec (vendored)' }]) };
  const lines = splitLines(text);
  const json = /\.json$/i.test(rel);
  const y = loadYaml(json ? blankComments(text, { slash: true, quotes: '"' }) : text, { json, maxBytes: LIMITS.MAX_FILE_BYTES });
  const unresolved = y.errors.length ? [{ kind: 'http', raw: rel, file: rel, line: 1, reason: `parse error: ${y.errors[0]}` }] : [];
  const facts = [];
  for (const { doc, root, js } of y.docs) {
    if (!js || typeof js !== 'object' || (!js.openapi && !js.swagger)) continue;
    const serverUrls = Array.isArray(js.servers) ? js.servers.map((s) => s?.url).filter((u) => typeof u === 'string') : [];
    if (typeof js.host === 'string') serverUrls.push(`http://${js.host}${typeof js.basePath === 'string' ? js.basePath : ''}`);
    let target = null;
    let prefix = typeof js.basePath === 'string' ? js.basePath : '';
    for (const u of serverUrls) {
      const m = /^[a-z][a-z0-9+.-]*:\/\/(.*)$/i.exec(u);
      const { host, path } = m ? splitAuthority(m[1]) : { host: '', path: u.startsWith('/') ? u : '' };
      if (!prefix && path && path !== '/') prefix = path;
      if (!target && host && otherMemberForHost(ctx, host)) target = host;
    }
    const dir = target ? 'consumes' : 'provides';
    for (const p of entries(doc, nodeAt(doc, root, ['paths']))) {
      if (!p.key.startsWith('/')) continue;
      const line = y.lineOf(p.keyNode);
      for (const op of entries(doc, p.value)) {
        if (!METHODS.has(op.key.toLowerCase())) continue;
        const method = op.key.toUpperCase();
        const opId = nodeAt(doc, op.value, ['operationId']);
        const detail = [js.swagger ? 'Swagger' : 'OpenAPI', prefix && `prefix ${prefix}`, opId?.value && `operationId ${opId.value}`].filter(Boolean).join(', ');
        facts.push(fact({ kind: 'http', dir, key: `${method} ${p.key}`, rel, lines, line, needle: p.key, detail, target: target || undefined, confidence: 'exact' }));
      }
    }
  }
  return { facts: onePerKey(facts), unresolved: cleanUnresolved(ctx?.state, rel, unresolved) };
}

export default Object.freeze({
  id: 'api-openapi',
  claims: (rel) => /\.(ya?ml|json)$/i.test(rel) && !SKIP_RE.test(rel),
  detect,
});
