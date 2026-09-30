// test/docs-mcp-servers.test.mjs — docs/mcp-servers.md covers what spec §17 lists, its links resolve,
// and the hosted-instance docs state the one-registry rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const DOC = readFileSync(path('../docs/mcp-servers.md'), 'utf8');

test('docs/mcp-servers.md covers every §17 topic', () => {
  for (const [topic, re] of [
    ['catalog vs sets', /\*\*catalog\*\*[\s\S]*\*\*set\*\*/], ['manual definitions and fields', /Add MCP server[\s\S]*per set/],
    ['General', /\*\*General\*\* is built in/], ['Duplicate for per-project credentials', /\*\*Duplicate\*\* a set/],
    ['copy names and renames', /`sentry_billing`[\s\S]*`<copy>_w`/], ['surfaces', /\*\*Pipelines:\*\*[\s\S]*\*\*Ask Worca:\*\*/],
    ['per-chat picker', /MCP · N/], ['per-run opt-out', /switch memberships off for one run/], ['OAuth refresh', /refreshed by hand/],
    ['$env MCP_ rule', /MCP_\[A-Z0-9_\]\{1,60\}/], ['keep-list', /HOME LOGNAME PATH\s+SHELL TERM USER TMPDIR LANG/],
    ['limits and start costs', /12 copies per Ask message and 24 per pipeline agent[\s\S]*75 s/],
    ['worktrees bring sets (D17)', /open a worktree on any registered project/], ['what can still read secrets', /## What can still read a secret/],
  ]) assert.match(DOC, re, topic);
});

test('its relative links resolve', () => {
  for (const [, target] of DOC.matchAll(/\]\(([a-z-]+\.md)(#[a-z-]+)?\)/g)) assert.ok(existsSync(path(`../docs/${target}`)), target);
});

test('remote-access and deploy-railway state one registry and one secrets file per instance; guardrails and the broker link the guide', () => {
  assert.match(readFileSync(path('../docs/remote-access.md'), 'utf8'), /One MCP registry and one MCP secrets file per instance/);
  assert.match(readFileSync(path('../docs/deploy-railway.md'), 'utf8'), /one MCP registry and one MCP secrets file/);
  assert.match(readFileSync(path('../README.md'), 'utf8'), /\[MCP servers\]\(docs\/mcp-servers\.md\)/);
  for (const f of ['guardrails.md', 'credential-broker.md']) assert.match(readFileSync(path(`../docs/${f}`), 'utf8'), /\]\(mcp-servers\.md\)/, f);
});
