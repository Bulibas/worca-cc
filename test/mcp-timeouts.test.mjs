// test/mcp-timeouts.test.mjs — how long a registry server may take to start, per surface
// (docs/mcp-servers.md "Limits and costs"): long enough for a first `npx -y` download of a large package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MCP_STARTUP_MS, mcpStartupMs } from '../src/core/mcp/timeouts.mjs';
import { checkRows } from './helpers/rows.mjs';

test('MCP startup timeouts: Ask 60 s, pipelines and Test 2 minutes; worca\'s own MCP_TIMEOUT wins when it is an integer ≥ 1000 ms (capped at the largest timer)', async () => {
  await checkRows([
    { name: 'defaults fit a cold npx install of firebase-tools (33.5 s measured): Ask 60 s, pipelines and Test 2 minutes', run: () => {
      assert.deepEqual({ ...MCP_STARTUP_MS }, { ask: 60000, pipeline: 120000, test: 120000 });
      assert.ok(Object.isFrozen(MCP_STARTUP_MS));
    } },
    { name: "worca's own MCP_TIMEOUT wins when it is an integer ≥ 1000 ms, on every surface", run: () => {
      assert.equal(mcpStartupMs('pipeline', {}), 120000);
      assert.equal(mcpStartupMs('test', { MCP_TIMEOUT: '300000' }), 300000);
      assert.equal(mcpStartupMs('ask', { MCP_TIMEOUT: '5000' }), 5000, 'lower is allowed too');
      assert.equal(mcpStartupMs('ask', { MCP_TIMEOUT: '1000' }), 1000, '1000 ms counts');
      assert.equal(mcpStartupMs('ask', { MCP_TIMEOUT: '999' }), 60000, 'under 1000 ms: ignored');
      assert.equal(mcpStartupMs('ask', { MCP_TIMEOUT: '1500.5' }), 60000, 'not an integer: ignored');
      assert.equal(mcpStartupMs('ask', { MCP_TIMEOUT: '' }), 60000);
      assert.equal(mcpStartupMs('test', { MCP_TIMEOUT: '99999999999' }), 2147483647, "capped at Node's largest timer: a larger one fires at once");
    } },
  ]);
});
