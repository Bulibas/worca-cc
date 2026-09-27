// test/night-activation.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inWindow, msUntilWindowStart, nightState, decideDelayMs, nightAnchorMs } from '../src/core/night/activation.mjs';
import { NIGHT_DEFAULTS } from '../src/core/night/config.mjs';

const at = (iso) => Date.parse(iso);
const cfg = (o = {}) => ({ ...NIGHT_DEFAULTS, ...o });

test('window wraps midnight in the given zone', () => {
  const w = '22:00-08:00';
  assert.equal(inWindow(w, 'UTC', at('2026-09-27T23:30:00Z')), true);
  assert.equal(inWindow(w, 'UTC', at('2026-09-27T07:59:00Z')), true);
  assert.equal(inWindow(w, 'UTC', at('2026-09-27T08:00:00Z')), false);
  assert.equal(inWindow(w, 'Europe/Berlin', at('2026-09-27T20:30:00Z')), true);   // 22:30 CEST
  assert.equal(inWindow('09:00-17:00', 'UTC', at('2026-09-27T12:00:00Z')), true);
});

test('msUntilWindowStart', () => {
  assert.equal(msUntilWindowStart('22:00-08:00', 'UTC', at('2026-09-27T21:00:00Z')), 3_600_000);
  assert.equal(msUntilWindowStart('22:00-08:00', 'UTC', at('2026-09-27T22:30:00Z')), 23.5 * 3_600_000);
});

test('eligibility and activation (clarify answer 1 + 2)', () => {
  const now = at('2026-09-27T12:00:00Z');
  const base = { toggle: 'auto', optIn: false, override: 'auto', now };
  const NONE = { eligible: false, active: false, graceOn: false, wakeOn: false };
  assert.deepEqual(nightState({ ...base, config: cfg() }), NONE);
  assert.equal(nightState({ ...base, config: cfg(), optIn: true }).eligible, true, 'opt-in forces eligibility when enabled is off');
  assert.equal(nightState({ ...base, config: cfg({ enabled: true }), override: 'off' }).eligible, false);
  assert.equal(nightState({ ...base, config: cfg({ enabled: true }), toggle: 'on' }).active, true);
  const off = nightState({ ...base, config: cfg({ enabled: true, window: '00:00-23:59', timeZone: 'UTC' }), toggle: 'off' });
  assert.deepEqual(off, { eligible: true, active: false, graceOn: false, wakeOn: false }, 'global off beats window and grace');
  assert.equal(nightState({ ...base, config: cfg({ enabled: true }), toggle: 'off', override: 'on' }).active, true, 'per-run on beats global off');
  const noGrace = nightState({ ...base, config: cfg({ enabled: true, graceMinutes: null, window: '22:00-08:00', timeZone: 'UTC' }) });
  assert.deepEqual([noGrace.graceOn, noGrace.wakeOn], [false, true], 'null grace does not disable the window wake');
});

test('decideDelayMs: active → 0, else min(grace deadline, window start), none when neither', () => {
  const now = at('2026-09-27T21:00:00Z');
  const c = cfg({ enabled: true, window: '22:00-08:00', timeZone: 'UTC', graceMinutes: 30 });
  const st = { eligible: true, active: false, graceOn: true, wakeOn: true };
  assert.equal(decideDelayMs({ state: st, config: c, openedAt: now, now }), 30 * 60_000);
  assert.equal(decideDelayMs({ state: st, config: { ...c, graceMinutes: 120 }, openedAt: now, now }), 3_600_000);
  assert.equal(decideDelayMs({ state: { ...st, active: true }, config: c, openedAt: now, now }), 0);
  assert.equal(decideDelayMs({ state: { ...st, graceOn: false }, config: { ...c, window: null }, openedAt: now, now }), null);
  assert.equal(decideDelayMs({ state: st, config: c, openedAt: now - 31 * 60_000, now }), 0, 'grace already elapsed');
  assert.equal(decideDelayMs({ state: { ...st, graceOn: false }, config: { ...c, graceMinutes: null }, openedAt: now, now }), 3_600_000,
    'window-only config still wakes at the window start');
  assert.equal(decideDelayMs({ state: { ...st, graceOn: false, wakeOn: false }, config: c, openedAt: now, now }), null, 'global off: no wake');
});

test('nightAnchorMs: last window start, else rolling 12 h', () => {
  const now = at('2026-09-28T03:00:00Z');
  assert.equal(nightAnchorMs(cfg({ window: '22:00-08:00', timeZone: 'UTC' }), now), at('2026-09-27T22:00:00Z'));
  assert.equal(nightAnchorMs(cfg({ window: null }), now), now - 12 * 3_600_000);
});
