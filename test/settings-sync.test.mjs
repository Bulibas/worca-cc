// test/settings-sync.test.mjs — sync-before-run (#527) instance defaults in
// settings.json and the per-project override in project_config.extra.sync.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTempHome } from './helpers/temp-home.mjs';
import { checkRows } from './helpers/rows.mjs';
import {
  DEFAULT_SYNC_SETTINGS, SETTINGS_POST_KEYS, normalizeSyncSettings, assertSyncSettingsInput,
  syncDefaults, setSyncDefaults, readSettings,
} from '../src/core/settings.mjs';
import { SYNC_PREFS_KEY, readSyncPrefs, writeSyncPrefs, readRunConfig } from '../src/core/config.mjs';
import { projectKey } from '../src/core/store.mjs';

const home = useTempHome(after, 'worca-cc-settings-sync-');
let prev, projDir, key;

before(() => {
  prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  projDir = mkdtempSync(join(tmpdir(), 'worca-cc-sync-proj-'));
  mkdirSync(join(projDir, 'src'), { recursive: true });
  key = projectKey(projDir);
});

after(() => {
  for (const k of ['HOME', 'USERPROFILE']) {
    if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
  }
  rmSync(projDir, { recursive: true, force: true });
});

test('normalizeSyncSettings drops invalid keys and fills defaults', () => {
  assert.deepEqual(normalizeSyncSettings(undefined), { ...DEFAULT_SYNC_SETTINGS });
  assert.deepEqual(
    normalizeSyncSettings({ beforeRun: 'yes', remote: 'https://x', refreshMinutes: 1441, onDiverged: 'merge', extra: 1 }),
    { ...DEFAULT_SYNC_SETTINGS },
  );
  assert.deepEqual(
    normalizeSyncSettings({ beforeRun: false, remote: 'upstream', refreshMinutes: 0, onDiverged: 'fail' }),
    { beforeRun: false, remote: 'upstream', refreshMinutes: 0, onDiverged: 'fail' },
  );
  assert.deepEqual(normalizeSyncSettings([]), { ...DEFAULT_SYNC_SETTINGS });
});

test('assertSyncSettingsInput rejects URLs, unknown keys and bad values; null / "" reset', () => {
  assert.throws(() => assertSyncSettingsInput({ remote: 'https://x' }), /never a URL/);
  assert.throws(() => assertSyncSettingsInput({ nope: 1 }), /unknown sync setting: nope/);
  assert.throws(() => assertSyncSettingsInput({ toString: 1 }), /unknown sync setting/);
  assert.throws(() => assertSyncSettingsInput({ beforeRun: 1 }), /beforeRun/);
  assert.throws(() => assertSyncSettingsInput({ refreshMinutes: 1.5 }), /refreshMinutes/);
  assert.throws(() => assertSyncSettingsInput({ onDiverged: 'merge' }), /ask \| origin \| fail/);
  assert.throws(() => assertSyncSettingsInput([]), /must be an object/);
  assert.doesNotThrow(() => assertSyncSettingsInput(null));
  assert.doesNotThrow(() => assertSyncSettingsInput(''));
  assert.doesNotThrow(() => assertSyncSettingsInput({ remote: 'origin', refreshMinutes: 0 }));
});

test('setSyncDefaults round-trips a partial patch and null resets', async () => {
  assert.ok(SETTINGS_POST_KEYS.includes('sync'));
  assert.deepEqual(syncDefaults(), { ...DEFAULT_SYNC_SETTINGS });
  assert.deepEqual(await setSyncDefaults({ onDiverged: 'fail' }), { ...DEFAULT_SYNC_SETTINGS, onDiverged: 'fail' });
  assert.deepEqual(await setSyncDefaults({ refreshMinutes: 0 }), { ...DEFAULT_SYNC_SETTINGS, onDiverged: 'fail', refreshMinutes: 0 });
  assert.deepEqual(syncDefaults(), { ...DEFAULT_SYNC_SETTINGS, onDiverged: 'fail', refreshMinutes: 0 });
  await assert.rejects(setSyncDefaults({ remote: 'git@x:y' }), /never a URL/);
  assert.deepEqual(await setSyncDefaults(null), { ...DEFAULT_SYNC_SETTINGS });
});

test('a null sync key resets just that key: the default is reported and the key is deleted from settings.json', async () => {
  await checkRows([
    { name: 'a null sync key resets just that key to its default', run: async () => {
      for (const k of Object.keys(DEFAULT_SYNC_SETTINGS)) assert.doesNotThrow(() => assertSyncSettingsInput({ [k]: null }));
      await setSyncDefaults({ remote: 'upstream', refreshMinutes: 30, beforeRun: false, onDiverged: 'fail' });
      assert.deepEqual(await setSyncDefaults({ remote: null }), { beforeRun: false, remote: 'origin', refreshMinutes: 30, onDiverged: 'fail' });
      assert.deepEqual(await setSyncDefaults({ refreshMinutes: null, beforeRun: null, onDiverged: null }), { ...DEFAULT_SYNC_SETTINGS });
      assert.deepEqual(syncDefaults(), { ...DEFAULT_SYNC_SETTINGS });
    } },
    { name: 'settings.json keeps only the sync keys someone set (a null key is deleted, not frozen at today\'s default)', run: async () => {
      await setSyncDefaults(null);
      await setSyncDefaults({ onDiverged: 'fail' });
      assert.deepEqual(readSettings().sync, { onDiverged: 'fail' });
      await setSyncDefaults({ refreshMinutes: 30 });
      assert.deepEqual(readSettings().sync, { onDiverged: 'fail', refreshMinutes: 30 });
      await setSyncDefaults({ onDiverged: null });
      assert.deepEqual(readSettings().sync, { refreshMinutes: 30 });
      await setSyncDefaults({ refreshMinutes: null });
      assert.equal(readSettings().sync, undefined);
      assert.deepEqual(syncDefaults(), { ...DEFAULT_SYNC_SETTINGS });
    } },
  ]);
});

test('readSyncPrefs / writeSyncPrefs merge, and a null value deletes back to inherit', async () => {
  assert.equal(SYNC_PREFS_KEY, 'sync');
  assert.equal(readSyncPrefs(key), null);
  assert.deepEqual(writeSyncPrefs(key, { beforeRun: false }), { beforeRun: false });
  assert.deepEqual(writeSyncPrefs(key, { onDiverged: 'origin' }), { beforeRun: false, onDiverged: 'origin' });
  assert.deepEqual(readSyncPrefs(key), { beforeRun: false, onDiverged: 'origin' });
  // The override is a project preference, never run config.
  assert.equal(SYNC_PREFS_KEY in (await readRunConfig(projDir)), false);
  assert.deepEqual(writeSyncPrefs(key, { onDiverged: null }), { beforeRun: false });
  assert.equal(writeSyncPrefs(key, { beforeRun: null }), null);
  assert.equal(readSyncPrefs(key), null);
  assert.throws(() => readSyncPrefs(projDir), /projectKey/);
});
