// test/ask-mcp-off.test.mjs — MCP registry §9.4/§12: the `mcpOff` body field (PATCH and the
// first message) — null clears; sets are set ids, members `<setId>|<serverId>`; ≤100 each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMcpOff, MCP_OFF_MAX } from '../src/core/ask/mcp.mjs';

test('validateMcpOff: null clears, missing arrays default empty, duplicates dropped, every server id form accepted', () => {
  assert.deepEqual(validateMcpOff(null), { ok: true, value: null });
  assert.deepEqual(validateMcpOff({}), { ok: true, value: { sets: [], members: [] } });
  assert.deepEqual(validateMcpOff({ sets: ['general', 'billing', 'billing', 'team-acme-platform-9333'], members: [
    'billing|plugin:acme-tools/sentry', 'shop|manual:postgres-ro', 'team-acme-platform-9333|policy:acme/platform/github', 'shop|manual:postgres-ro',
  ] }), { ok: true, value: {
    sets: ['general', 'billing', 'team-acme-platform-9333'],
    members: ['billing|plugin:acme-tools/sentry', 'shop|manual:postgres-ro', 'team-acme-platform-9333|policy:acme/platform/github'],
  } });
  assert.equal(MCP_OFF_MAX, 100);
});

test('validateMcpOff refuses every malformed shape', () => {
  const bad = [
    undefined, 'general', ['general'], 5,
    { sets: 'general' }, { sets: ['Billing'] }, { sets: ['9lives'] }, { sets: [1] },
    { sets: Array.from({ length: 101 }, (_, i) => `s${i}`) },
    { members: 'billing|manual:x' }, { members: ['billing'] }, { members: ['billing|'] }, { members: ['|manual:x'] },
    { members: ['billing|manual:X'] }, { members: ['billing|manual:a_b'] }, { members: ['billing|other:x'] },
    { members: ['billing|plugin:acme-tools'] }, { members: ['billing|policy:x'] },
    { members: Array.from({ length: 101 }, (_, i) => `s|manual:m${i}`) },
  ];
  for (const raw of bad) assert.equal(validateMcpOff(raw).ok, false, JSON.stringify(raw));
  assert.match(validateMcpOff({ members: ['billing'] }).error, /mcpOff\.members/);
  assert.match(validateMcpOff({ sets: ['Billing'] }).error, /mcpOff\.sets/);
});
