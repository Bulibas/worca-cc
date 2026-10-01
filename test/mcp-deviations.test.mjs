// test/mcp-deviations.test.mjs — MCP registry §11.4: one off-policy finding per `mcp.required`
// entry that does not start in this run, read off the resolver result (policy/effective.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpDeviations } from '../src/core/policy/effective.mjs';

const TEAM = 'team-acme-platform-9333';
const fields = { 'mcp.required': { kind: 'soft', value: [
  { name: 'github', type: 'stdio', command: 'npx' },
  { plugin: 'acme-tools', server: 'sentry' },
  { name: 'datadog', type: 'http', url: 'https://mcp.datadoghq.com' },
  { name: 'linear', type: 'http', url: 'https://mcp.linear.app' },
  { name: 'jira', type: 'stdio', command: 'jira-mcp' },
  { name: 'pager', type: 'stdio', command: 'pager-mcp' },
] } };
const resolved = {
  sets: [{ id: 'general', group: 'general' }, { id: 'billing', group: 'set' }, { id: TEAM, group: 'team' }],
  copies: [{ name: 'datadog_team-platfor', setId: TEAM, serverId: 'policy:acme/platform/datadog' }],
  skipped: [
    { setId: 'billing', setName: 'Billing', serverId: 'plugin:acme-tools/sentry', copy: 'sentry_billing', reason: 'missing:token' },
    { setId: TEAM, setName: 'Team · acme/platform', serverId: 'plugin:acme-tools/sentry', copy: 'sentry_team-platfor', reason: 'needs-consent' },
    { setId: TEAM, setName: 'Team · acme/platform', serverId: 'policy:acme/platform/github', copy: 'github_team-platfor', reason: 'missing:token' },
    { setId: TEAM, setName: 'Team · acme/platform', serverId: 'policy:acme/platform/jira', copy: 'jira_team-platfor', reason: 'opted-out' },
    { setId: TEAM, setName: 'Team · acme/platform', serverId: 'policy:acme/platform/pager', copy: 'pager_team-platfor', reason: 'off' },
  ],
};

test('mcpDeviations: one warn per required entry that does not start, by the Team set membership only', () => {
  const out = mcpDeviations(fields, resolved, (s) => `${s.reason.slice(8)} not set`);
  assert.deepEqual(out.map((d) => d.code), [
    'mcp-skipped:github', 'mcp-off:acme-tools/sentry', 'mcp-missing:linear', 'mcp-opted-out:jira', 'mcp-off:pager',
  ], 'datadog started; sentry reads its TEAM membership (needs-consent), not the Billing one');
  assert.ok(out.every((d) => d.level === 'warn'));
  assert.equal(out[0].text, 'Required MCP server github is skipped in this run (token not set).');
  assert.equal(out[1].text, 'Required MCP server acme-tools/sentry is off.');
  assert.equal(out[2].text, 'Required MCP server linear is not installed.');
  assert.equal(out[3].text, 'Required MCP server jira is opted out of this run.');
});

test('mcpDeviations: no mcp.required, or no Team set in the resolution', () => {
  assert.deepEqual(mcpDeviations({}, resolved), []);
  assert.deepEqual(mcpDeviations(fields, { sets: [], copies: [], skipped: [] }).map((d) => d.code),
    ['mcp-missing:github', 'mcp-missing:acme-tools/sentry', 'mcp-missing:datadog', 'mcp-missing:linear', 'mcp-missing:jira', 'mcp-missing:pager']);
});
