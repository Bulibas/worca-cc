// test/redact-values.test.mjs
// MCP registry §5.5.3: value-based redaction of a spawn's registry secrets, composed with the wbt_ pattern.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRedactor, REDACTED_TOKEN } from '../src/core/redact.mjs';

test('createRedactor: every value of ≥8 chars (longest first) becomes [redacted], then broker tokens; deep keeps the shape', () => {
  const r = createRedactor(['short', 'abcdefgh', 'abcdefgh-longer', 'abcdefgh', 42, null]);
  assert.equal(r.text('x abcdefgh-longer y abcdefgh z short'), 'x [redacted] y [redacted] z short');
  assert.equal(r.text(`token wbt_${'a'.repeat(24)}`), `token ${REDACTED_TOKEN}`);
  assert.deepEqual(r.deep({ a: ['abcdefgh', 1, { b: 'pre abcdefgh post' }], n: null }), { a: ['[redacted]', 1, { b: 'pre [redacted] post' }], n: null });
  assert.equal(r.text(7), 7);
  assert.equal(createRedactor([]).text('abcdefgh'), 'abcdefgh');
  assert.equal(createRedactor(undefined).deep({ v: 'abcdefgh' }).v, 'abcdefgh');
});

test('createRedactor: the forms a value reaches output in — trimmed, one line at a time, JSON-escaped — and keys and past the depth cap', () => {
  const r = createRedactor(['ghp_abcdefgh12345678\n', '-----BEGIN KEY-----\n  line-two-BBBBBBBB\n', 'q"uo\\te-value']);
  assert.equal(r.text('t ghp_abcdefgh12345678.'), 't [redacted].', 'stored with a trailing newline, printed trimmed');
  assert.equal(r.text('stderr: line-two-BBBBBBBB'), 'stderr: [redacted]', 'one line of a multi-line value');
  assert.equal(r.text(JSON.stringify({ k: 'q"uo\\te-value' })), '{"k":"[redacted]"}', 'inside a raw JSON line');
  assert.deepEqual(r.deep({ 'ghp_abcdefgh12345678': 1 }), { '[redacted]': 1 }, 'an object key');
  let nested = 'ghp_abcdefgh12345678';
  for (let i = 0; i < 40; i++) nested = { k: nested };
  assert.ok(!JSON.stringify(r.deep(nested)).includes('ghp_abcdefgh'), 'past the depth cap');
});

test('createRedactor: trimmed or one line, THEN JSON-escaped (a pasted JSON credential printed inside JSON)', () => {
  const sa = '{\n  "type": "service_account",\n  "private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\n-----END PRIVATE KEY-----\\n"\n}\n';
  const j = createRedactor([sa, 'q"uo\\te-value\n']);
  assert.ok(!j.text(JSON.stringify({ c: sa.trim() })).includes('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'), 'trimmed, then JSON-escaped');
  assert.ok(!j.text(JSON.stringify({ line: sa.split('\n')[2].trim() })).includes('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'), 'one line, then JSON-escaped');
  assert.equal(j.text(JSON.stringify({ k: 'q"uo\\te-value' })), '{"k":"[redacted]"}', 'a pasted trailing newline, JSON-escaped');
});

test('createRedactor: PEM armor lines are no redaction form; the key body still is', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n';
  const r = createRedactor([pem]);
  assert.equal(r.text('checks for -----BEGIN PRIVATE KEY----- first'), 'checks for -----BEGIN PRIVATE KEY----- first');
  assert.equal(r.text('body MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'), 'body [redacted]');
  assert.equal(r.text(pem.trim()), '[redacted]');
});
