// src/core/redact.mjs
// Broker spawn tokens in agent output (plans/credential-broker-design.html §6.10).
// A token only works on the broker's private port and only while its spawn lives,
// but an agent can still print its own env into a transcript every teammate sees.
// The `wbt_` prefix makes it recognisable; this removes it wherever worca stores or
// shows agent output. Pure, cheap on text without the prefix.

export const BROKER_TOKEN_RE = /\bwbt_[A-Za-z0-9_-]{20,}/g;
export const REDACTED_TOKEN = 'wbt_[redacted]';

/** `text` with every broker token replaced. Non-strings come back unchanged. */
export function redactSecrets(text) {
  if (typeof text !== 'string' || !text.includes('wbt_')) return text;
  return text.replace(BROKER_TOKEN_RE, REDACTED_TOKEN);
}

/** Deep copy of a JSON-like value with every string passed through `fn` (with `o.keys`, every key too; past the
 *  depth cap, `o.deepest` of the rest, else the rest as it is). */
function mapStrings(value, fn, depth = 0, o = {}) {
  if (typeof value === 'string') return fn(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 32) return o.deepest ? o.deepest(value) : value;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn, depth + 1, o));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[o.keys ? fn(k) : k] = mapStrings(v, fn, depth + 1, o);
  return out;
}

/** Deep copy of a JSON-like value with every string redacted (events, tool results). */
export function redactDeep(value, depth = 0) {
  return mapStrings(value, redactSecrets, depth);
}

/** A PEM armor line is the same in every key: as a form it would hide nothing and mangle every mention of one. */
const PEM_ARMOR_RE = /^-----(BEGIN|END) [A-Z0-9 ]+-----$/;

/** The forms a secret value reaches output in: as stored, trimmed, and each line trimmed — tool results, stderr and
 *  log lines arrive trimmed and one line at a time — and each of those JSON-escaped (inside a raw stream line, or a
 *  tool's JSON text). */
const valueForms = (v) => [v, v.trim(), ...v.split(/\r\n|\r|\n/).map((l) => l.trim()).filter((l) => !PEM_ARMOR_RE.test(l))]
  .flatMap((f) => [f, JSON.stringify(f).slice(1, -1)]);

/**
 * Value-based redaction (MCP registry §5.5.3): a spawn's registry secrets are known values, so every form of each
 * (valueForms) of ≥8 chars (shorter ones would mangle ordinary text) becomes `[redacted]`, longest first, then
 * redactSecrets runs. `deep` also redacts object keys, and whatever lies past the depth cap as JSON text.
 * @param {string[]} values
 * @returns {{ text: (s: *) => *, deep: (v: *) => * }}
 */
export function createRedactor(values) {
  const list = [...new Set((Array.isArray(values) ? values : []).filter((v) => typeof v === 'string').flatMap(valueForms)
    .filter((v) => v.length >= 8))].sort((a, b) => b.length - a.length);
  const text = (s) => {
    if (typeof s !== 'string') return s;
    let out = s;
    for (const v of list) if (out.includes(v)) out = out.split(v).join('[redacted]');
    return redactSecrets(out);
  };
  const deepest = (v) => { try { return text(JSON.stringify(v)); } catch { return '[redacted]'; } };
  return { text, deep: (v) => mapStrings(v, text, 0, { keys: true, deepest }) };
}
