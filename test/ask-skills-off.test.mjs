// test/ask-skills-off.test.mjs — skills registry §4.4/§7: the per-chat choices (`mcpOff`) carry skill memberships
// too — `<setId>|skill:plugin:<plugin>/<name>` and `<setId>|skill:library:<name>` (the widened MEMBERSHIP_KEY_RE).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMcpOff } from '../src/core/ask/mcp.mjs';

test('validateMcpOff: skill memberships are accepted next to server memberships, duplicates dropped', () => {
  assert.deepEqual(validateMcpOff({ sets: ['general'], members: [
    'billing|skill:plugin:acme/deploy-checklist', 'general|skill:library:release-notes', 'billing|plugin:acme-tools/sentry',
    'billing|skill:plugin:acme/deploy-checklist',
  ] }), { ok: true, value: { sets: ['general'], members: [
    'billing|skill:plugin:acme/deploy-checklist', 'general|skill:library:release-notes', 'billing|plugin:acme-tools/sentry',
  ] } });
});

test('validateMcpOff: a malformed skill membership is refused and the error names both member kinds', () => {
  for (const m of ['billing|skill:bogus', 'billing|skill:library:Bad_Name', 'billing|skill:plugin:acme', 'billing|skill:library:', '|skill:library:x']) {
    const r = validateMcpOff({ members: [m] });
    assert.equal(r.ok, false, m);
    assert.equal(r.error, 'mcpOff.members must be an array of at most 100 "<setId>|<serverId>" or "<setId>|<skillId>" entries');
  }
});
