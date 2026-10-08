// test/api-platform-heartbeat.test.mjs
// W3: the server's collect() for the platform heartbeat, against a real (temp) store and the live
// registries: an idle server is ok and suspendable, and the body keeps the contract's shape.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { useTempHome } from './helpers/temp-home.mjs';
import { PIPELINE_KEYS } from '../src/core/platform-heartbeat.mjs';

useTempHome(after);

let mod;
before(async () => {
  process.env.WORCA_MOCK = '1';
  mod = await import('../ui/server.mjs');
});
after(() => { delete process.env.WORCA_MOCK; });

test('an idle server: ok, suspendable, fixed pipeline keys, the package version', async () => {
  const b = await mod._testing.collectPlatformHeartbeat();
  assert.equal(b.health, 'ok');
  assert.equal(b.suspendable, true);
  assert.deepEqual(Object.keys(b.pipelines), PIPELINE_KEYS);
  assert.match(b.version, /^\d+\.\d+\.\d+/);
  assert.equal(b.nextScheduledAt, null);
  assert.deepEqual(b.today, { done: 0, failed: 0, stopped: 0 });
});

test('a live running entry makes it busy and counts as running', async () => {
  const { runs } = mod;
  runs.set('hb-test-run', { id: 'hb-test-run', kind: 'run', status: 'running', events: [], title: 't', projectDir: '/tmp/x', startedAt: new Date().toISOString() });
  try {
    const b = await mod._testing.collectPlatformHeartbeat();
    assert.equal(b.pipelines.running, 1);
    assert.equal(b.suspendable, false);
  } finally {
    runs.delete('hb-test-run');
  }
});
