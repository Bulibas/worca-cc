// test/night-activation.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inWindow, msUntilWindowStart, nightState, decideDelayMs, nightAnchorMs, runAllowed } from '../src/core/night/activation.mjs';
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
  assert.deepEqual(off, { eligible: false, active: false, graceOn: false, wakeOn: false }, 'Paused beats away hours and the by-day rule');
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

test('nightAnchorMs: inside the window, the window start (or an earlier unattended start)', () => {
  const now = at('2026-09-28T03:00:00Z');
  const c = cfg({ window: '22:00-08:00', timeZone: 'UTC' });
  assert.equal(nightAnchorMs(c, now), at('2026-09-27T22:00:00Z'));
  assert.equal(nightAnchorMs(c, now, at('2026-09-27T21:00:00Z')), at('2026-09-27T21:00:00Z'), 'a grace stretch that began before the window');
  assert.equal(nightAnchorMs(c, now, at('2026-09-28T01:00:00Z')), at('2026-09-27T22:00:00Z'));
});

test('nightAnchorMs: outside the window, only the unattended stretch counts (never the attended day)', () => {
  const now = at('2026-09-28T15:00:00Z');
  const c = cfg({ window: '22:00-08:00', timeZone: 'UTC' });
  assert.equal(nightAnchorMs(c, now), now, 'first decision of the stretch: nothing spent yet');
  assert.equal(nightAnchorMs(c, now, at('2026-09-28T14:10:00Z')), at('2026-09-28T14:10:00Z'));
  assert.equal(nightAnchorMs(cfg({ window: null }), now), now);
  assert.equal(nightAnchorMs(cfg({ window: null }), now, now - 60_000), now - 60_000);
});

// Away mode precedence (plans/away-mode-design.md §3.1).
const W = { ...NIGHT_DEFAULTS, window: '22:00-07:00', timeZone: 'UTC', graceMinutes: 30 };
const DAY = at('2026-09-28T15:00:00Z'); const NIGHT = at('2026-09-28T23:00:00Z');
const st = (o) => nightState({ config: W, toggle: 'auto', optIn: false, override: 'auto', ...o });

test('by day, only a MARKED run gets the waited-N-minutes rule', () => {
  assert.equal(st({ now: DAY, optIn: true }).graceOn, true);
  assert.equal(st({ now: DAY, optIn: false, config: { ...W, enabled: true } }).graceOn, false, 'All runs does not answer unmarked runs by day');
  assert.equal(st({ now: DAY, optIn: false, config: { ...W, enabled: true } }).active, false);
});

test('"I\'m away now" answers every run, marked or not, with or without All runs', () => {
  const s = st({ now: DAY, toggle: 'on', optIn: false, config: { ...W, enabled: false } });
  assert.deepEqual([s.eligible, s.active], [true, true]);
});

test('inside away hours: All runs answers unmarked runs; Only marked does not', () => {
  assert.equal(st({ now: NIGHT, config: { ...W, enabled: true } }).active, true);
  assert.equal(st({ now: NIGHT, config: { ...W, enabled: false } }).eligible, false);
  assert.equal(st({ now: NIGHT, optIn: true }).active, true);
});

test('precedence: run Never > run Answer now > Paused > I\'m away now', () => {
  assert.equal(st({ now: NIGHT, override: 'off', toggle: 'on', optIn: true }).eligible, false);
  assert.equal(st({ now: DAY, override: 'on', toggle: 'off' }).active, true);
  assert.equal(st({ now: NIGHT, toggle: 'off', optIn: true, config: { ...W, enabled: true } }).active, false);
  assert.equal(st({ now: NIGHT, toggle: 'off', optIn: true }).graceOn, false, 'paused: marked runs wait too');
});

test('boundary minutes: 22:00 is away, 07:00 is here', () => {
  assert.equal(inWindow('22:00-07:00', 'UTC', at('2026-09-28T22:00:00Z')), true);
  assert.equal(inWindow('22:00-07:00', 'UTC', at('2026-09-29T07:00:00Z')), false);
});

test('runAllowed: the run switch and the stored settings only, never the clock or the status', () => {
  assert.equal(runAllowed({ config: W, optIn: false, override: 'auto' }), false);
  assert.equal(runAllowed({ config: { ...W, enabled: true }, optIn: false, override: 'auto' }), true);
  assert.equal(runAllowed({ config: W, optIn: true, override: 'auto' }), true);
  assert.equal(runAllowed({ config: W, optIn: false, override: 'on' }), true);
  assert.equal(runAllowed({ config: { ...W, enabled: true }, optIn: true, override: 'off' }), false);
});
