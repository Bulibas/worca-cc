// test/settings-night-mode.test.mjs
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setNightMode, nightModeSettings, setNightModeToggle, nightModeToggle, nightModeHereSince } from '../src/core/settings.mjs';

// settings.json is read from $HOME/.worca-cc (NOT WORCA_HOME): swap HOME/USERPROFILE.
let home; const prev = {};
before(async () => {
  home = await mkdtemp(join(tmpdir(), 'worca-night-settings-'));
  for (const k of ['HOME', 'USERPROFILE']) { prev[k] = process.env[k]; process.env[k] = home; }
});
after(async () => {
  for (const k of ['HOME', 'USERPROFILE']) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  await rm(home, { recursive: true, force: true, maxRetries: 3 });
});

test('nightMode round-trips a validated partial; null clears', async () => {
  await setNightMode({ enabled: true, window: '22:00-08:00' });
  assert.deepEqual(nightModeSettings(), { enabled: true, window: '22:00-08:00' });
  await setNightMode({ minConfidence: 70 });                   // merge
  assert.equal(nightModeSettings().enabled, true);
  await setNightMode({ __unset: ['window'] });                 // remove one field so the team value applies again
  assert.equal(nightModeSettings().window, undefined);
  await assert.rejects(() => setNightMode({ strategy: 'dice' }), /strategy/);
  await setNightMode(null);
  assert.deepEqual(nightModeSettings(), {});
});

test('toggle defaults to auto and validates', async () => {
  assert.equal(nightModeToggle(), 'auto');
  await setNightModeToggle('on'); assert.equal(nightModeToggle(), 'on');
  await assert.rejects(() => setNightModeToggle('maybe'), /nightModeToggle/);
  await setNightModeToggle('auto'); assert.equal(nightModeToggle(), 'auto');
});

test('"here" stores auto plus the moment it was said; any other status clears it', async () => {
  const t = Date.parse('2026-09-27T23:00:00Z');
  await setNightModeToggle('on');
  await setNightModeToggle('here', { now: t });
  assert.equal(nightModeToggle(), 'auto', '"here" is not a stored status: away hours resume by themselves');
  assert.equal(nightModeHereSince(), t);
  await setNightModeToggle('on');
  assert.deepEqual([nightModeToggle(), nightModeHereSince()], ['on', null]);
  await setNightModeToggle('here', { now: t });
  await setNightModeToggle('auto');
  assert.equal(nightModeHereSince(), null);
});
