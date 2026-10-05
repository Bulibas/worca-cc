// test/debug-spawn-settings.test.mjs
// The stored spawn-diagnostics preference and the ONE precedence rule the runner
// gate and the settings API share (settings.mjs#effectiveDebugSpawn): a non-empty
// WORCA_DEBUG_SPAWN wins, otherwise the stored value applies. The setter persists
// only — it never writes process.env.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  settingsFile, debugSpawnEnabled, setDebugSpawnEnabled, effectiveDebugSpawn,
  assertDebugSpawnInput, DEFAULT_DEBUG_SPAWN_ENABLED,
} from '../src/core/settings.mjs';
import { debugSpawnEnabled as gateEnabled } from '../src/core/claude-runner.mjs';
import { checkRows } from './helpers/rows.mjs';

let home, prevHome, prevProfile, prevGate;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'worca-debug-spawn-'));
  prevHome = process.env.HOME; prevProfile = process.env.USERPROFILE; prevGate = process.env.WORCA_DEBUG_SPAWN;
  process.env.HOME = home; process.env.USERPROFILE = home;
});

/** The state every test starts from: no env override, an empty settings.json. A merged
 * test's rows each call it too, since beforeEach runs once per test, not once per row. */
async function fresh() {
  delete process.env.WORCA_DEBUG_SPAWN;
  await writeFile(settingsFile(), '{}\n', 'utf8');
}

beforeEach(async () => {
  await mkdir(join(home, '.worca-cc'), { recursive: true });
  await fresh();
});
after(async () => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
  if (prevGate === undefined) delete process.env.WORCA_DEBUG_SPAWN; else process.env.WORCA_DEBUG_SPAWN = prevGate;
  await rm(home, { recursive: true, force: true });
});

/** Run `fn` with WORCA_DEBUG_SPAWN set to `value` (undefined = unset), restoring after. */
async function withGate(value, fn) {
  const prev = process.env.WORCA_DEBUG_SPAWN;
  if (value === undefined) delete process.env.WORCA_DEBUG_SPAWN; else process.env.WORCA_DEBUG_SPAWN = value;
  try { return await fn(); }
  finally { if (prev === undefined) delete process.env.WORCA_DEBUG_SPAWN; else process.env.WORCA_DEBUG_SPAWN = prev; }
}

test('debug-spawn setting: OFF when missing/corrupt, boolean-only round-trip, read-modify-write', async () => {
  await checkRows([
    { name: 'debugSpawnEnabled reads OFF when missing or corrupt (loudly for a non-boolean)', run: async () => {
      await checkRows([
        { name: 'missing setting reads as OFF (default)', run: async () => {
          await fresh();
          assert.equal(debugSpawnEnabled(), false);
          assert.equal(DEFAULT_DEBUG_SPAWN_ENABLED, false);
        } },
        { name: 'corrupt settings.json falls back to OFF, never throws', run: async () => {
          await fresh();
          await writeFile(settingsFile(), '{ not json', 'utf8');
          assert.equal(debugSpawnEnabled(), false);
        } },
        { name: 'corrupt stored value (non-boolean) falls back to OFF loudly', run: async () => {
          await fresh();
          await writeFile(settingsFile(), JSON.stringify({ debugSpawnEnabled: 'yes' }), 'utf8');
          const realWarn = console.warn; const warnings = [];
          console.warn = (...a) => warnings.push(a.join(' '));
          try { assert.equal(debugSpawnEnabled(), false); } finally { console.warn = realWarn; }
          assert.ok(warnings.some((w) => /debugSpawnEnabled/.test(w)));
        } },
      ]);
    } },
    { name: 'setDebugSpawnEnabled round-trips booleans, refuses anything else, never writes process.env', run: async () => {
      await checkRows([
        { name: 'setter round-trips true/false, returns the stored value, and never touches process.env', run: async () => {
          await fresh();
          assert.deepEqual(await setDebugSpawnEnabled(true), { debugSpawnEnabled: true });
          assert.equal(debugSpawnEnabled(), true);
          assert.equal(process.env.WORCA_DEBUG_SPAWN, undefined, 'no env write on true');
          assert.deepEqual(await setDebugSpawnEnabled(false), { debugSpawnEnabled: false });
          assert.equal(debugSpawnEnabled(), false);
          assert.equal(process.env.WORCA_DEBUG_SPAWN, undefined, 'no env write on false (no leaked "0" into child envs)');
          const raw = JSON.parse(await readFile(settingsFile(), 'utf8'));
          assert.equal('debugSpawnEnabled' in raw, false, 'the default is stored as absence');
        } },
        { name: 'setter rejects non-boolean input and persists nothing; assertDebugSpawnInput is the same rule', run: async () => {
          await fresh();
          await assert.rejects(() => setDebugSpawnEnabled('true'), /must be true or false/);
          const raw = JSON.parse(await readFile(settingsFile(), 'utf8'));
          assert.equal('debugSpawnEnabled' in raw, false);
          assert.throws(() => assertDebugSpawnInput('on'), /debugSpawnEnabled must be true or false/);
          assert.throws(() => assertDebugSpawnInput(1), /must be true or false/);
          assert.doesNotThrow(() => assertDebugSpawnInput(true));
          assert.doesNotThrow(() => assertDebugSpawnInput(false));
        } },
      ]);
    } },
    { name: 'unknown keys survive a setter write (read-modify-write)', run: async () => {
      await fresh();
      await writeFile(settingsFile(), JSON.stringify({ someFutureKey: 42 }), 'utf8');
      await setDebugSpawnEnabled(true);
      const raw = JSON.parse(await readFile(settingsFile(), 'utf8'));
      assert.equal(raw.someFutureKey, 42);
      assert.equal(raw.debugSpawnEnabled, true);
    } },
  ]);
});

test('effectiveDebugSpawn: env precedence, and a UI save under an env override', async () => {
  await checkRows([
    { name: 'effectiveDebugSpawn: a non-empty env wins both ways, empty or unset defers to the stored value; the runner gate follows', run: async () => {
      await checkRows([
        { name: 'effectiveDebugSpawn: env unset ⇒ the stored value, source "settings"; the runner gate follows with no restart', run: async () => {
          await fresh();
          assert.deepEqual(effectiveDebugSpawn(), { enabled: false, source: 'settings' });
          assert.equal(gateEnabled(), false, 'sanity: unset env + default setting is off');
          await setDebugSpawnEnabled(true);
          assert.deepEqual(effectiveDebugSpawn(), { enabled: true, source: 'settings' });
          assert.equal(gateEnabled(), true, 'the runner sees the saved setting on its next read');
          await setDebugSpawnEnabled(false);
          assert.equal(gateEnabled(), false, 'and flips back');
        } },
        { name: 'effectiveDebugSpawn: a NON-EMPTY env value wins over the stored value, in both directions', run: async () => {
          await fresh();
          await setDebugSpawnEnabled(false);
          await withGate('1', () => {
            assert.deepEqual(effectiveDebugSpawn(), { enabled: true, source: 'env' });
            assert.equal(gateEnabled(), true);
          });
          await setDebugSpawnEnabled(true);
          for (const off of ['0', 'false']) {
            await withGate(off, () => {
              assert.deepEqual(effectiveDebugSpawn(), { enabled: false, source: 'env' }, `an exported ${JSON.stringify(off)} is an explicit OFF override`);
              assert.equal(gateEnabled(), false);
            });
          }
        } },
        { name: 'effectiveDebugSpawn: an EMPTY env export is not an override — the stored value still applies', run: async () => {
          await fresh();
          await setDebugSpawnEnabled(true);
          await withGate('', () => {
            assert.deepEqual(effectiveDebugSpawn(), { enabled: true, source: 'settings' });
            assert.equal(gateEnabled(), true);
          });
        } },
      ]);
    } },
    { name: 'a UI save while the env overrides: stored changes, effective does not, env untouched', run: async () => {
      await fresh();
      await withGate('1', async () => {
        await setDebugSpawnEnabled(false);
        assert.equal(debugSpawnEnabled(), false, 'stored');
        assert.deepEqual(effectiveDebugSpawn(), { enabled: true, source: 'env' }, 'launch override still in force');
        assert.equal(process.env.WORCA_DEBUG_SPAWN, '1', 'the env var is untouched');
      });
    } },
  ]);
});
