// test/server-shutdown-steps.test.mjs
// The shutdown steps after a drain are bounded (B2): a step that never settles is named and left
// behind, so a stop always ends the process (found on Railway, where one never settled).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempHome } from './helpers/temp-home.mjs';

useTempHome(after);
process.env.WORCA_MOCK = '1';
const { _testing } = await import('../ui/server.mjs');

test('all steps settle: nothing pending, no log', async () => {
  const logs = [];
  const pending = await _testing.settleShutdownSteps({ a: async () => {}, b: () => { throw new Error('boom'); } }, { timeoutMs: 500, log: (l) => logs.push(l) });
  assert.deepEqual(pending, []);
  assert.deepEqual(logs, []);
});

test('a step that never settles is named after the bound', async () => {
  const logs = [];
  const started = Date.now();
  const pending = await _testing.settleShutdownSteps({ quick: async () => {}, stuck: () => new Promise(() => {}) }, { timeoutMs: 300, log: (l) => logs.push(l) });
  assert.deepEqual(pending, ['stuck']);
  assert.match(logs[0], /stuck did not stop within/);
  assert.ok(Date.now() - started < 2000);
});
