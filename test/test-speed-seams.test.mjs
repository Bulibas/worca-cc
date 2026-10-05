// test/test-speed-seams.test.mjs — the env/option knobs the suite uses to wait less (suite reduction Task 8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlCheckIntervalMs, CONTROL_CHECK_INTERVAL_MS } from '../src/core/pipeline-commands.mjs';
import { pruneWaitMsFrom } from '../src/core/projects.mjs';

test('controlCheckIntervalMs: 1000 by default; only 10 .. 60000 overrides it', () => {
  assert.equal(CONTROL_CHECK_INTERVAL_MS, 1000);
  assert.deepEqual(
    [{}, { WORCA_CONTROL_CHECK_MS: '25' }, { WORCA_CONTROL_CHECK_MS: '5' }, { WORCA_CONTROL_CHECK_MS: 'abc' }, { WORCA_CONTROL_CHECK_MS: '3e9' }].map(controlCheckIntervalMs),
    [1000, 25, 1000, 1000, 1000]);
});

test('pruneWaitMsFrom: 10 s by default; only 1 .. 600000 overrides it', () => {
  assert.deepEqual(
    [{}, { WORCA_PRUNE_WAIT_MS: '200' }, { WORCA_PRUNE_WAIT_MS: '0' }, { WORCA_PRUNE_WAIT_MS: '-5' }, { WORCA_PRUNE_WAIT_MS: '9999999' }].map(pruneWaitMsFrom),
    [10_000, 200, 10_000, 10_000, 10_000]);
});
