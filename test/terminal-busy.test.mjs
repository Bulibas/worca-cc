// test/terminal-busy.test.mjs — a run with an open terminal is busy for the checkout cap and until-pr (#573, D7).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { useTempHome } from './helpers/temp-home.mjs';
import { busyRunIds } from '../src/core/checkout.mjs';
import { terminalPidFile } from '../src/core/terminal/paths.mjs';
import { worcaHome } from '../src/core/projects.mjs';

useTempHome(after);

test('busyRunIds reads the terminal pid file next to the actions one', () => {
  const f = terminalPidFile(worcaHome());
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify([{ pid: process.pid, ownerPid: process.pid, sessionId: 't-1', instanceId: 'term:r9:t-1' },
    { pid: process.pid, ownerPid: process.pid, sessionId: 't-2' }]));
  assert.deepEqual([...busyRunIds()], ['r9']);
});
