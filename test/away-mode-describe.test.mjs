import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeAwayMode, describeRun, describeNewRun, describeChange } from '../src/shared/away-mode/describe.mjs';
import { NIGHT_DEFAULTS } from '../src/core/night/config.mjs';

const at = (iso) => Date.parse(iso);
const C = { ...NIGHT_DEFAULTS, window: '22:00-07:00', timeZone: 'UTC', graceMinutes: 30, enabled: false };
const base = { config: C, toggle: 'auto', localZone: 'UTC' };

test('worked example at 15:00 (proposal §3.1 A)', () => {
  const d = describeAwayMode({ ...base, now: at('2026-09-28T15:00:00Z') });
  assert.equal(d.status, 'here');
  assert.deepEqual(d.lines, [
    'Right now it is 15:00. You count as here. Next away hours start at 22:00.',
    'From 22:00 to 07:00, worca answers questions on runs you marked. Other runs wait for you.',
    'Outside those hours, a marked run is answered once a question has waited 30 minutes. Unmarked runs always wait.',
  ]);
});

test('the four cells: 15:00 / 23:00 × marked / unmarked', () => {
  const run = (iso, optIn) => describeRun({ config: C, toggle: 'auto', now: at(iso), run: { optIn, override: 'auto', openedAt: iso, done: false } });
  assert.deepEqual([run('2026-09-28T15:00:00Z', true).state, run('2026-09-28T15:00:00Z', true).minutes], ['after', 30]);
  assert.equal(run('2026-09-28T15:00:00Z', false).state, 'wait');
  assert.equal(run('2026-09-28T23:00:00Z', true).state, 'now');
  assert.equal(run('2026-09-28T23:00:00Z', false).state, 'wait');
});

test('status variants', () => {
  const now = at('2026-09-28T23:00:00Z');
  assert.match(describeAwayMode({ ...base, now }).lines[0], /You count as away \(your away hours\)\. They end at 07:00\./);
  assert.match(describeAwayMode({ ...base, now, toggle: 'on' }).lines[0], /because you said "I'm away now"/);
  assert.match(describeAwayMode({ ...base, now, toggle: 'off' }).lines[0], /^Away mode is paused\./);
  assert.match(describeAwayMode({ ...base, now, config: { ...C, window: null } }).lines[0], /^No away hours are set\./);
  assert.equal(describeAwayMode({ ...base, now, config: { ...C, enabled: true } }).lines[1], 'From 22:00 to 07:00, worca answers questions on all runs.');
  assert.equal(describeAwayMode({ ...base, now, config: { ...C, graceMinutes: null } }).lines[2], 'Outside those hours, every run waits for you.');
  assert.equal(describeAwayMode({ ...base, now, config: { ...C, neverDecide: ['gate', 'recovery'] } }).lines[3],
    'Fix again or continue, in a review loop and A step failed: retry or give up always wait for you, even when you are away.');
  assert.equal(describeAwayMode({ ...base, now, config: { ...C, neverDecide: ['form'] } }).lines[3], 'Input forms always wait for you, even when you are away.');
});

test('boundary minutes', () => {
  assert.equal(describeAwayMode({ ...base, now: at('2026-09-28T22:00:00Z') }).status, 'away-hours');
  assert.equal(describeAwayMode({ ...base, now: at('2026-09-29T07:00:00Z') }).status, 'here');
});

test('unknown zone: falls back to the local zone, names it, never throws', () => {
  const d = describeAwayMode({ ...base, config: { ...C, timeZone: 'Mars/Olympus' }, localZone: 'UTC', now: at('2026-09-28T15:00:00Z') });
  assert.match(d.lines[0], /15:00 UTC/);
});

test('null zone: the local zone, not named', () => {
  const d = describeAwayMode({ ...base, config: { ...C, timeZone: null }, localZone: 'UTC', now: at('2026-09-28T15:00:00Z') });
  assert.equal(d.lines[0], 'Right now it is 15:00. You count as here. Next away hours start at 22:00.');
});

test('run switch states', () => {
  const r = (o) => describeRun({ config: C, toggle: 'auto', now: at('2026-09-28T15:00:00Z'), run: { optIn: false, override: 'auto', openedAt: null, done: false, ...o } });
  assert.equal(r({ override: 'off' }).pill, 'never');
  assert.equal(r({ override: 'on' }).pill, 'answering');
  assert.equal(r({ done: true }).state, 'never');
  assert.equal(describeRun({ config: C, toggle: 'off', now: at('2026-09-28T15:00:00Z'), run: { optIn: true, override: 'auto', openedAt: null, done: false } }).state, 'wait', 'Paused: a marked run waits too');
  assert.deepEqual([r({ optIn: true, openedAt: '2026-09-28T14:48:00Z' }).state, r({ optIn: true, openedAt: '2026-09-28T14:48:00Z' }).pill], ['after', 'answers after 18 min']);
  assert.deepEqual([r({ optIn: true, openedAt: '2026-09-28T14:20:00Z' }).state, r({ optIn: true, openedAt: '2026-09-28T14:20:00Z' }).pill], ['now', 'answering'], 'a due question is being answered');
});

test('an open always-wait question never counts down; "Never by day" gives its own reason', () => {
  const r = (o) => describeRun({ config: C, toggle: 'auto', now: at('2026-09-28T15:00:00Z'), run: { optIn: true, override: 'auto', openedAt: null, done: false, ...o } });
  assert.deepEqual([r({ waiting: true }).state, r({ waiting: true }).pill], ['wait', 'waiting for you']);
  assert.match(r({ waiting: true }).reason, /Always wait for me on/);
  assert.equal(describeRun({ config: C, toggle: 'on', now: at('2026-09-28T15:00:00Z'), run: { optIn: true, override: 'auto', openedAt: null, done: false, waiting: true } }).state, 'wait', 'even while away');
  assert.equal(r({}).state, 'after', 'no open question: what would happen');
  const nb = describeRun({ config: { ...C, graceMinutes: null }, toggle: 'auto', now: at('2026-09-28T15:00:00Z'), run: { optIn: true, override: 'auto', openedAt: null, done: false } });
  assert.deepEqual([nb.state, nb.reason], ['wait', 'You count as here, and your settings say marked runs wait by day too.']);
});

test('project summary marks the lines its own values shape', () => {
  const d = describeAwayMode({ ...base, now: at('2026-09-28T15:00:00Z'), projectName: 'Shop', projectFields: ['graceMinutes'] });
  assert.match(d.lines[0], /^For Shop: Right now/);
  assert.doesNotMatch(d.lines[1], /this project/);
  assert.match(d.lines[2], /Unmarked runs always wait\. \(this project\)$/);
});

test('settings not loaded yet: no pill, never a false "never"', () => {
  const d = describeRun({ config: undefined, toggle: undefined, now: at('2026-09-28T15:00:00Z'), run: { optIn: true, override: 'auto', done: false } });
  assert.deepEqual([d.state, d.pill], ['unknown', '']);
});

test('New-run hint variants', () => {
  assert.match(describeNewRun({ config: C, toggle: 'auto' }), /^While you are away \(Settings › Away mode: 22:00–07:00, or "I'm away now"\)/);
  assert.match(describeNewRun({ config: { ...C, enabled: true }, toggle: 'auto' }), /already allow every run/);
  assert.match(describeNewRun({ config: C, toggle: 'off' }), /^Away mode is paused/);
});

test('before/after for a card', () => {
  const d = describeChange(C, { ...C, enabled: true }, { toggle: 'auto', now: at('2026-09-28T15:00:00Z') });
  assert.match(d.before[0], /runs you marked/);
  assert.match(d.after[0], /all runs/);
});

test('never throws on junk', () => {
  assert.doesNotThrow(() => describeAwayMode({ config: null, toggle: undefined, now: NaN }));
  assert.deepEqual(describeAwayMode({ config: null, toggle: 'auto', now: 0 }).lines, ['Away mode settings could not be read.']);
});
