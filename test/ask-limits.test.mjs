// test/ask-limits.test.mjs
// P1/T5: Ask Worca per-turn limits in settings.json (ask-worca-design.md §6.9, D12)
// and their fresh reader. Settings sandbox: settingsFile() lives under HOME,
// not WORCA_HOME (same pattern as test/cost-settings.test.mjs).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  askMaxTurns, askMaxBudgetUsd, setAskMaxTurns, setAskMaxBudgetUsd, assertAskLimitInputs,
  DEFAULT_ASK_MAX_TURNS, DEFAULT_ASK_MAX_BUDGET_USD, settingsFile, readSettings,
} from '../src/core/settings.mjs';
import { askLimits } from '../src/core/ask/limits.mjs';
import { checkRows } from './helpers/rows.mjs';

let sandboxHome;
const prevEnv = {};
before(async () => {
  sandboxHome = await mkdtemp(join(tmpdir(), 'worca-ask-limits-'));
  for (const k of ['HOME', 'USERPROFILE']) prevEnv[k] = process.env[k];
  process.env.HOME = sandboxHome;
  process.env.USERPROFILE = sandboxHome;
});
after(async () => {
  for (const k of ['HOME', 'USERPROFILE']) {
    if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k];
  }
  await rm(sandboxHome, { recursive: true, force: true });
});
beforeEach(async () => {
  await mkdir(join(sandboxHome, '.worca-cc'), { recursive: true });
  await writeFile(settingsFile(), '{}\n', 'utf8');
});

test('defaults: 400 turns / no cap; absent or invalid stored values fall back to them with one warning each', async () => {
  await checkRows([
    { name: 'defaults: 400 turns, no cost cap', run: () => {
      assert.equal(DEFAULT_ASK_MAX_TURNS, 400);
      assert.equal(DEFAULT_ASK_MAX_BUDGET_USD, null);
      assert.equal(askMaxTurns(), 400);
      assert.equal(askMaxBudgetUsd(), null);
    } },
    { name: 'no stored budget, or an invalid one, means no cap', run: async () => {
      assert.ok(!('askMaxBudgetUsd' in readSettings()), 'nothing stored');
      assert.equal(askMaxBudgetUsd(), null, 'absent ⇒ no cap');
      const warnings = [];
      const orig = console.warn;
      console.warn = (...a) => warnings.push(a.join(' '));
      try {
        for (const bad of [-3, 0.05, 101, '2', true, {}]) {
          await writeFile(settingsFile(), JSON.stringify({ askMaxBudgetUsd: bad }), 'utf8');
          assert.equal(askMaxBudgetUsd(), null, `invalid ${JSON.stringify(bad)} ⇒ no cap`);
        }
      } finally { console.warn = orig; }
      assert.equal(warnings.length, 6);
      for (const w of warnings) assert.match(w, /invalid askMaxBudgetUsd .* — using the default \(no cap\)$/);
    } },
    { name: 'invalid persisted values fall back loudly to the defaults', run: async () => {
      await writeFile(settingsFile(), JSON.stringify({ askMaxTurns: 'lots', askMaxBudgetUsd: -3 }), 'utf8');
      const warnings = [];
      const orig = console.warn;
      console.warn = (...a) => warnings.push(a.join(' '));
      try {
        assert.equal(askMaxTurns(), 400);
        assert.equal(askMaxBudgetUsd(), null);
      } finally { console.warn = orig; }
      assert.equal(warnings.filter((w) => /askMaxTurns|askMaxBudgetUsd/.test(w)).length, 2);
      assert.ok(warnings.some((w) => w.endsWith('invalid askMaxTurns "lots" — using the default (400)')));
      assert.ok(warnings.some((w) => w.endsWith('invalid askMaxBudgetUsd -3 — using the default (no cap)')));
    } },
  ]);
});

test('set/read roundtrip; null stores "no cap"; "" clears to the default', async () => {
  assert.deepEqual(await setAskMaxTurns(120), { askMaxTurns: 120 });
  assert.equal(askMaxTurns(), 120);
  assert.deepEqual(await setAskMaxBudgetUsd(0.5), { askMaxBudgetUsd: 0.5 });
  assert.equal(askMaxBudgetUsd(), 0.5);
  assert.deepEqual(await setAskMaxBudgetUsd(null), { askMaxBudgetUsd: null });
  assert.equal(askMaxBudgetUsd(), null, 'null = no cap');
  assert.equal(readSettings().askMaxBudgetUsd, null, 'the literal null is persisted');
  await setAskMaxBudgetUsd(0.5);
  assert.deepEqual(await setAskMaxBudgetUsd(''), { askMaxBudgetUsd: null });
  assert.equal(askMaxBudgetUsd(), null, '"" clears to the default (no cap)');
  assert.ok(!('askMaxBudgetUsd' in readSettings()), 'cleared key is removed');
  await setAskMaxTurns('');
  assert.equal(askMaxTurns(), 400);
  await setAskMaxTurns(5);
  await setAskMaxTurns(null);
  assert.equal(askMaxTurns(), 400, 'null clears askMaxTurns (it has no "no cap" meaning)');
});

test('validation: ranges, integers, strings rejected, exact messages', async () => {
  for (const bad of [0, 501, 2.5, '40', -1, NaN, true, {}]) {
    await assert.rejects(() => setAskMaxTurns(bad), { message: 'askMaxTurns must be an integer between 1 and 500' });
  }
  for (const bad of [0, 0.05, 101, '2', -1, NaN, true, {}]) {
    await assert.rejects(() => setAskMaxBudgetUsd(bad), { message: 'askMaxBudgetUsd must be null (no cap) or a number between 0.1 and 100' });
  }
  await setAskMaxTurns(1); await setAskMaxTurns(500);
  await setAskMaxBudgetUsd(0.1); await setAskMaxBudgetUsd(100);
  assert.equal(askMaxBudgetUsd(), 100);
});

test('assertAskLimitInputs validates only the keys present, as a set, and throws the first error', () => {
  assert.doesNotThrow(() => assertAskLimitInputs({}));
  assert.doesNotThrow(() => assertAskLimitInputs({ askMaxTurns: 10, askMaxBudgetUsd: null }));
  assert.doesNotThrow(() => assertAskLimitInputs({ askMaxTurns: '', askMaxBudgetUsd: '' }));
  assert.throws(() => assertAskLimitInputs({ askMaxTurns: 0 }), /askMaxTurns must be an integer/);
  assert.throws(() => assertAskLimitInputs({ askMaxTurns: 10, askMaxBudgetUsd: 1000 }), /askMaxBudgetUsd must be null/);
  assert.doesNotThrow(() => assertAskLimitInputs({ pipelineCostLimitUsd: -1 }), 'foreign keys are not its business');
});

test('askLimits() reads the settings fresh on every call (D12) and accepts injected readers', async () => {
  assert.deepEqual(askLimits(), { maxTurns: 400, maxBudgetUsd: null });
  await setAskMaxTurns(3);
  await setAskMaxBudgetUsd(0.5);
  assert.deepEqual(askLimits(), { maxTurns: 3, maxBudgetUsd: 0.5 }, 'no caching');
  await setAskMaxBudgetUsd(null);
  assert.deepEqual(askLimits(), { maxTurns: 3, maxBudgetUsd: null }, 'no caching');
  assert.deepEqual(askLimits({ readMaxTurns: () => 9, readMaxBudgetUsd: () => 0.25 }), { maxTurns: 9, maxBudgetUsd: 0.25 });
});
