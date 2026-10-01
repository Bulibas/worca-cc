// test/mcp-tool-name.test.mjs — §9.7: the one MCP tool-name parser the Ask reducer and panel share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMcpToolName } from '../src/shared/mcp-tool-name.mjs';

test('parseMcpToolName splits at the first __ after the server (server names never contain __)', () => {
  assert.deepEqual(parseMcpToolName('mcp__worca__list_runs'), { server: 'worca', tool: 'list_runs' });
  assert.deepEqual(parseMcpToolName('mcp__sentry_billing__search_issues'), { server: 'sentry_billing', tool: 'search_issues' });
  assert.deepEqual(parseMcpToolName('mcp__jira_w__get_issue'), { server: 'jira_w', tool: 'get_issue' });
  assert.deepEqual(parseMcpToolName('mcp__postgres-ro_shop__query__raw'), { server: 'postgres-ro_shop', tool: 'query__raw' });
  for (const n of ['Read', 'mcp__worca', 'mcp____x', '', null, undefined]) assert.equal(parseMcpToolName(n), null, String(n));
});

// §10: the first-party API's 400 on an over-long MCP tool name — one definition for the pipeline warning
// (run-harness.mjs) and Ask's muted line (ask/turn.mjs). Bounded quantifiers: it runs in the server process.
import { MCP_TOOL_NAME_400_RE, MCP_TOOL_NAME_TOO_LONG } from '../src/shared/mcp-tool-name.mjs';

test('MCP_TOOL_NAME_400_RE matches the API 400 for both limits and nothing else; linear on a long line', () => {
  assert.equal(MCP_TOOL_NAME_TOO_LONG, 'an MCP tool name is too long for this model');
  assert.ok(MCP_TOOL_NAME_400_RE.test('API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"tools.12.custom.name: String should have at most 128 characters"}}'));
  assert.ok(MCP_TOOL_NAME_400_RE.test('tools.3.name: String should have at most 64 characters'));
  for (const s of ['tools.12.custom.description: String should have at most 1024 characters', 'messages.0.content: at most 128', 'tools.x.name: at most 128']) {
    assert.equal(MCP_TOOL_NAME_400_RE.test(s), false, s);
  }
  const t0 = Date.now();
  MCP_TOOL_NAME_400_RE.test(`tools.1.${'name'.repeat(20000)}`);
  assert.ok(Date.now() - t0 < 1000, 'no super-linear backtracking on an 80 KB line');
});
