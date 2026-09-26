// api-graphql: GraphQL SDL and operations.
//   provides  every field of the root types (Query / Mutation / Subscription, or the names a
//             `schema { query: … }` block declares; `extend type` included) → key
//             '<Root>.<field>' with the canonical root name, from .graphql/.graphqls/.gql files
//             and from SDL inside gql`…` / graphql`…` templates in code (Apollo typeDefs)
//   consumes  every ROOT field an operation selects (query → Query.<field>, mutation →
//             Mutation.<field>, subscription → Subscription.<field>; aliases resolved to the
//             field name) from operation documents and gql`…` / graphql(`…`) / gql("""…""")
// A document is SDL when a definition keyword stands at depth 0 (a selected field named `type` is
// not SDL). Code-first schemas (resolver decorators) are not read here; a minified JS bundle is skipped.
import { splitLines, fact, lineIndex, isMinified, onePerKey } from './lib/text.mjs';

const DOC_EXT_RE = /\.(graphql|graphqls|gql)$/i;
const CODE_EXT_RE = /\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte|py)$/i;
const ROOTS = { query: 'Query', mutation: 'Mutation', subscription: 'Subscription' };
const SDL_RE = /(^|[\s}])(?:extend\s+)?(?:type|schema|interface|input|enum|scalar|union|directive)\s+[@\w{]/;

/** Blank "strings", """block strings""" and # comments (newlines kept, offsets stable). */
export function blankGraphql(text) {
  const t = String(text ?? '');
  let out = '';
  let i = 0;
  const sp = (s) => s.replace(/[^\r\n]/g, ' ');
  while (i < t.length) {
    if (t.startsWith('"""', i)) { const j = t.indexOf('"""', i + 3); const e = j === -1 ? t.length : j + 3; out += sp(t.slice(i, e)); i = e; continue; }
    if (t[i] === '"') { let j = i + 1; while (j < t.length && t[j] !== '"' && t[j] !== '\n') j += t[j] === '\\' ? 2 : 1; const e = Math.min(t.length, j + 1); out += sp(t.slice(i, e)); i = e; continue; }
    if (t[i] === '#') { const j = t.indexOf('\n', i); const e = j === -1 ? t.length : j; out += sp(t.slice(i, e)); i = e; continue; }
    out += t[i]; i += 1;
  }
  return out;
}

/** Index just past the brace matching the '{' at `open` (or text end). */
function closeOf(t, open) {
  let depth = 0;
  for (let i = open; i < t.length; i += 1) { if (t[i] === '{') depth += 1; else if (t[i] === '}') { depth -= 1; if (depth === 0) return i + 1; } }
  return t.length;
}

/** Keep only depth-0 characters of a block body: nested (...) and {...} contents blanked. */
function depth0(body) {
  let out = '';
  let paren = 0;
  let brace = 0;
  for (const c of body) {
    if (c === '(') { paren += 1; out += paren === 1 && brace === 0 ? c : ' '; continue; }
    if (c === ')') { out += paren === 1 && brace === 0 ? c : ' '; paren = Math.max(0, paren - 1); continue; }
    if (c === '{') { brace += 1; out += ' '; continue; }
    if (c === '}') { brace = Math.max(0, brace - 1); out += ' '; continue; }
    out += paren || brace ? (c === '\n' || c === '\r' ? c : ' ') : c;
  }
  return out;
}

/** The body of the first `schema @dir(…)* { … }` block, or null. One forward scan: directive
 *  arguments and the body close with indexOf, a `schema` token inside an already-scanned stretch
 *  is skipped, and an unclosed '(' ends the search — never a regex re-scanning the rest of the
 *  text from every `schema` (quadratic). */
function schemaBlock(t) {
  let scanned = 0;
  for (const m of t.matchAll(/\bschema\b/g)) {
    if (m.index < scanned) continue;
    let i = m.index + 6;
    const ws = () => { while (i < t.length && /\s/.test(t[i])) i += 1; };
    ws();
    while (t[i] === '@') {
      i += 1;
      while (i < t.length && /\w/.test(t[i])) i += 1;
      ws();
      if (t[i] === '(') { const c = t.indexOf(')', i); if (c === -1) return null; i = c + 1; }
      ws();
    }
    scanned = i;
    if (t[i] !== '{') continue;
    const close = t.indexOf('}', i);
    return close === -1 ? null : t.slice(i + 1, close);
  }
  return null;
}

/** After an operation keyword at `i`: optional name, one balanced `( … )` (variable defaults may
 *  hold braces), directives with balanced arguments → { name, open: the selection '{' | -1, end }.
 *  One forward scan; an unclosed '(' ends at the text end. */
function opHeader(t, i) {
  const n = t.length;
  const ws = () => { while (i < n && /\s/.test(t[i])) i += 1; };
  const balanced = () => { // t[i] === '(' → i just past its matching ')'; false when never closed
    for (let depth = 0; i < n; i += 1) {
      if (t[i] === '(') depth += 1;
      else if (t[i] === ')' && --depth === 0) { i += 1; return true; }
    }
    return false;
  };
  ws();
  const s = i;
  while (i < n && /\w/.test(t[i])) i += 1;
  const name = t.slice(s, i);
  ws();
  if (t[i] === '(' && !balanced()) return { name, open: -1, end: n };
  ws();
  while (t[i] === '@') {
    i += 1;
    while (i < n && /\w/.test(t[i])) i += 1;
    ws();
    if (t[i] === '(' && !balanced()) return { name, open: -1, end: n };
    ws();
  }
  return { name, open: t[i] === '{' ? i : -1, end: i };
}

/** SDL → [{ key: 'Query.invoice', field, offset }] (offset into t). A `schema { … }` block
 *  makes ONLY the types it names roots; without one, Query / Mutation / Subscription are. */
export function sdlFields(t) {
  const renamed = {};
  const schemaBody = schemaBlock(t);
  if (schemaBody !== null) for (const m of schemaBody.matchAll(/\b(query|mutation|subscription)\s*:\s*(\w+)/g)) renamed[m[2]] = ROOTS[m[1]];
  const custom = Object.keys(renamed).length > 0;
  const rootOf = (name) => (custom ? renamed[name] || null : Object.values(ROOTS).includes(name) ? name : null);
  const out = [];
  let lastEnd = 0;
  for (const m of t.matchAll(/\b(?:extend\s+)?type\s+(\w+)\b[^{]{0,500}?\{/g)) {
    const open = m.index + m[0].length - 1;
    if (open < lastEnd) continue; // inside the previous type's body
    const close = closeOf(t, open);
    lastEnd = close;
    const root = rootOf(m[1]);
    if (!root) continue;
    const body = depth0(t.slice(open + 1, close - 1));
    for (const f of body.matchAll(/(?<![@\w$.])([_A-Za-z]\w*)\s*[(:]/g)) out.push({ key: `${root}.${f[1]}`, field: f[1], offset: open + 1 + f.index });
  }
  return out;
}

/** Operation document → [{ key: 'Query.invoice', field, offset, op }] (offset into t).
 *  Only top-level operations: a '{' inside an earlier operation is never a new one, and an
 *  anonymous '{' counts only at the top level (preceded by nothing or a closing '}'). */
export function operationFields(t) {
  const out = [];
  if (!t.includes('{')) return out;
  // An operation keyword (its header read by opHeader) or a top-level anonymous '{'.
  const OP_RE = /(^|[\s}])(query|mutation|subscription)\b|(^|\n)[ \t]*\{/g;
  let lastEnd = 0;
  let scanned = 0; // a header stretch already read is never re-read from a later keyword
  for (const m of t.matchAll(OP_RE)) {
    let open;
    let name = '';
    if (m[2]) {
      const at = m.index + m[0].length;
      if (at < Math.max(lastEnd, scanned)) continue;
      const h = opHeader(t, at);
      scanned = Math.max(scanned, h.end);
      if (h.open === -1) { if (h.end >= t.length) break; continue; }
      open = h.open;
      name = h.name;
    } else {
      open = m.index + m[0].length - 1;
      if (open < Math.max(lastEnd, scanned)) continue;
      let k = m.index - 1;
      while (k >= 0 && /\s/.test(t[k])) k -= 1;
      if (k >= 0 && t[k] !== '}') continue;
    }
    const kind = m[2] || 'query';
    const end = closeOf(t, open);
    lastEnd = end;
    const body = depth0(t.slice(open + 1, end - 1)).replace(/\.\.\.\s*on\s+\w+/g, (s) => ' '.repeat(s.length)).replace(/\.\.\.\s*\w+/g, (s) => ' '.repeat(s.length));
    for (const f of body.matchAll(/(?<![@\w$.])([_A-Za-z]\w*)(?:\s*:\s*([_A-Za-z]\w*))?/g)) {
      const field = f[2] || f[1];
      const offset = open + 1 + f.index + (f[2] ? f[0].lastIndexOf(f[2]) : 0);
      out.push({ key: `${ROOTS[kind]}.${field}`, field, offset, op: `${kind}${name ? ` ${name}` : ''}` });
    }
  }
  return out;
}

/** gql`…`, graphql`…`, gql(`…`), graphql(`…`), gql("""…"""), gql('''…''') → [{ start, body }]. */
export function templates(text) {
  const out = [];
  const OPEN_RE = /\b(?:gql|graphql)(?:\s*\(\s*|[ \t]*)(`|"""|''')/g;
  for (const m of text.matchAll(OPEN_RE)) {
    const start = m.index + m[0].length;
    const close = text.indexOf(m[1], start);
    if (close === -1) break;
    out.push({ start, body: text.slice(start, close).replace(/\$\{[^}]{0,500}\}/g, (s) => ' '.repeat(s.length)) });
  }
  return out;
}

function fromDocument(t, rel, lines, lineOf, base, facts) {
  const clean = blankGraphql(t);
  if (SDL_RE.test(depth0(clean))) { // definitions stand at depth 0: a selected field named `type` is no SDL
    for (const f of sdlFields(clean)) facts.push(fact({ kind: 'graphql', dir: 'provides', key: f.key, rel, lines, line: lineOf(base + f.offset), needle: f.field, detail: 'GraphQL schema', confidence: 'exact' }));
    return;
  }
  for (const f of operationFields(clean)) facts.push(fact({ kind: 'graphql', dir: 'consumes', key: f.key, rel, lines, line: lineOf(base + f.offset), needle: f.field, detail: f.op, confidence: 'exact' }));
}

function detect({ rel, text }) {
  if (isMinified(rel, text)) return { facts: [] }; // a bundle's gql templates belong to third-party code
  const lines = splitLines(text);
  const lineOf = lineIndex(text);
  const facts = [];
  if (DOC_EXT_RE.test(rel)) fromDocument(text, rel, lines, lineOf, 0, facts);
  else if (/gql|graphql/.test(text)) for (const tpl of templates(text)) fromDocument(tpl.body, rel, lines, lineOf, tpl.start, facts);
  return { facts: onePerKey(facts) };
}

export default Object.freeze({
  id: 'api-graphql',
  claims: (rel) => DOC_EXT_RE.test(rel) || CODE_EXT_RE.test(rel),
  detect,
});
