// test/runner-args.test.mjs
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildEffortArgs } from '../src/core/claude-runner.mjs';
import { checkRows } from './helpers/rows.mjs';

let prevFlag;
beforeEach(() => {
  prevFlag = process.env.WORCA_EFFORT_FLAG;
  delete process.env.WORCA_EFFORT_FLAG;
});
afterEach(() => {
  if (prevFlag === undefined) delete process.env.WORCA_EFFORT_FLAG;
  else process.env.WORCA_EFFORT_FLAG = prevFlag;
});

test('buildEffortArgs: default flag, nothing for an empty effort, WORCA_EFFORT_FLAG override', async () => {
  await checkRows([
    { name: 'buildEffortArgs maps an effort to the default CLI flag', run: () => {
      assert.deepEqual(buildEffortArgs('xhigh'), ['--effort', 'xhigh']);
    } },
    { name: 'buildEffortArgs adds nothing when effort is empty', run: () => {
      assert.deepEqual(buildEffortArgs(''), []);
      assert.deepEqual(buildEffortArgs(undefined), []);
    } },
    { name: 'buildEffortArgs honors the WORCA_EFFORT_FLAG override', run: () => {
      process.env.WORCA_EFFORT_FLAG = '--reasoning-effort';
      assert.deepEqual(buildEffortArgs('high'), ['--reasoning-effort', 'high']);
    } },
  ]);
});
