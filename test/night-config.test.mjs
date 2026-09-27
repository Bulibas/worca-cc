// test/night-config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveNightConfig, validateNightPatch, NIGHT_DEFAULTS, teamNightLayer } from '../src/core/night/config.mjs';

test('per-field precedence: project > user > team > default', () => {
  const { config, sources } = resolveNightConfig({
    project: { strategy: 'weights' },
    user: { strategy: 'analysis', minConfidence: 70, enabled: true },
    team: { minConfidence: 80, minMargin: 10, strategy: 'mixed' },
  });
  assert.equal(config.strategy, 'weights'); assert.equal(sources.strategy, 'project');
  assert.equal(config.minConfidence, 70); assert.equal(sources.minConfidence, 'user');
  assert.equal(config.minMargin, 10); assert.equal(sources.minMargin, 'team');
  assert.equal(config.maxDecisions, NIGHT_DEFAULTS.maxDecisions); assert.equal(sources.maxDecisions, 'default');
  assert.equal(config.enabled, true);
});

test('explicit null is a choice (stops the fall-through); undefined falls through', () => {
  const { config, sources } = resolveNightConfig({ project: { graceMinutes: null }, user: { graceMinutes: 5 } });
  assert.equal(config.graceMinutes, null); assert.equal(sources.graceMinutes, 'project');
});

test('spendCapUsd ignores the project layer (it is across all runs)', () => {
  const { config, sources } = resolveNightConfig({ project: { spendCapUsd: 1 }, user: { spendCapUsd: 9 } });
  assert.equal(config.spendCapUsd, 9); assert.equal(sources.spendCapUsd, 'user');
});

test('criteria fill missing keys from defaults', () => {
  const { config } = resolveNightConfig({ user: { criteria: { cost: 5 } } });
  assert.deepEqual(config.criteria, { ...NIGHT_DEFAULTS.criteria, cost: 5 });
});

test('validateNightPatch rejects bad values with a message', () => {
  assert.throws(() => validateNightPatch({ strategy: 'dice' }), /strategy/);
  assert.throws(() => validateNightPatch({ window: '25:00-08:00' }), /window/);
  assert.throws(() => validateNightPatch({ neverDecide: ['gate', 'nope'] }), /neverDecide/);
  assert.throws(() => validateNightPatch({ spendCapUsd: 3 }, { level: 'project' }), /spendCapUsd/);
  assert.deepEqual(validateNightPatch({ minConfidence: 65, window: null }), { minConfidence: 65, window: null });
});

test('an invalid stored layer value is dropped, not fatal', () => {
  const { config } = resolveNightConfig({ user: { minConfidence: 'high' } });
  assert.equal(config.minConfidence, NIGHT_DEFAULTS.minConfidence);
});

test('team layer maps night.* policy keys', () => {
  const get = (k) => ({ 'night.enabled': true, 'night.window': '23:00-07:00' })[k];
  assert.deepEqual(teamNightLayer(get), { enabled: true, window: '23:00-07:00' });
});

test('night/config.mjs is a zero-import leaf (keeps settings.mjs cycle-free)', async () => {
  const src = await readFile(new URL('../src/core/night/config.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^import /m);
});
