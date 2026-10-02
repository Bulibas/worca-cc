// test/night-project-prefs.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeNightModePrefs, readNightModePrefs, readRunConfig } from '../src/core/config.mjs';
import { projectKey } from '../src/core/store.mjs';
import { useTempHome } from './helpers/temp-home.mjs';

useTempHome(after);                      // fresh sqlite under WORCA_HOME
const dir = mkdtempSync(join(tmpdir(), 'worca-night-proj-'));

test('project night prefs merge, unset, clear; never leak into readRunConfig', async () => {
  const key = projectKey(dir);
  writeNightModePrefs(key, { strategy: 'weights', maxDecisions: 5 });
  writeNightModePrefs(key, { __unset: ['maxDecisions'] });
  assert.deepEqual(readNightModePrefs(key), { strategy: 'weights' });
  assert.throws(() => writeNightModePrefs(key, { spendCapUsd: 3 }), /per user/);
  assert.equal((await readRunConfig(dir)).nightMode, undefined, 'excluded from the forwarded extra keys');
  writeNightModePrefs(key, null);
  assert.equal(readNightModePrefs(key), null);
});
