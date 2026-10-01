// test/mcp-deny.test.mjs — MCP registry §6.4: a run's deny rule reaches every registry copy of the
// server it names (by base or declared name), follows a copy's `_w` rename, and keeps the original.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandMcpDenyRules } from '../src/core/mcp/deny.mjs';
import { isPermissionRule } from '../src/core/guardrails.mjs';

const catalog = [
  { id: 'manual:linear', name: 'linear', base: 'linear' },
  { id: 'policy:acme/platform/linear', name: 'linear', base: 'platform-linear' },
  { id: 'plugin:acme-tools/jira', name: 'jira', base: 'jira' },
];
const copies = [
  { name: 'linear_billing', copy: 'linear_billing', serverId: 'manual:linear' },
  { name: 'platform-linear_team-platfor', copy: 'platform-linear_team-platfor', serverId: 'policy:acme/platform/linear' },
  { name: 'jira_w', copy: 'jira', serverId: 'plugin:acme-tools/jira' },
  { name: 'jira_shop', copy: 'jira_shop', serverId: 'plugin:acme-tools/jira' },
  { name: 'sentry_billing_w', copy: 'sentry_billing', serverId: 'plugin:acme-tools/sentry' },
];

test('expandMcpDenyRules: by declared name, by base, through a _w rename; originals kept, nothing else touched', () => {
  const rules = ['Bash(curl:*)', 'mcp__linear__delete_issue', 'mcp__jira', 'mcp__jira_shop__create_issue', 'mcp__sentry_billing__search', 'mcp__nope__x'];
  assert.deepEqual(expandMcpDenyRules(rules, { catalog, copies }), [
    ...rules,
    'mcp__linear_billing__delete_issue', 'mcp__platform-linear_team-platfor__delete_issue',
    'mcp__jira_w', 'mcp__jira_shop', 'mcp__sentry_billing_w__search',
  ]);
  assert.deepEqual(expandMcpDenyRules(['mcp__platform-linear'], { catalog, copies }),
    ['mcp__platform-linear', 'mcp__platform-linear_team-platfor'], 'the machine-local base reaches its copies too');
  assert.deepEqual(expandMcpDenyRules(['mcp__jira__search'], { catalog, copies: [] }), ['mcp__jira__search']);
});

test('RULE_RE accepts copy names with `_` (a deny rule on sentry_billing / jira_w validates)', () => {
  for (const r of ['mcp__sentry_billing__search_issues', 'mcp__jira_w', 'mcp__postgres-ro_shop__query']) assert.ok(isPermissionRule(r), r);
});
