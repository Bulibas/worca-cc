import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeAwayMode, describeRun, describeAwaySwitch } from '../src/shared/away-mode/describe.mjs';
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

test('boundary minutes', () => {
  assert.equal(describeAwayMode({ ...base, now: at('2026-09-28T22:00:00Z') }).status, 'away-hours');
  assert.equal(describeAwayMode({ ...base, now: at('2026-09-29T07:00:00Z') }).status, 'here');
});

test('unknown zone: falls back to the local zone, names it, never throws', () => {
  const d = describeAwayMode({ ...base, config: { ...C, timeZone: 'Mars/Olympus' }, localZone: 'UTC', now: at('2026-09-28T15:00:00Z') });
  assert.match(d.lines[0], /15:00 UTC/);
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

test('settings not loaded yet: no pill, never a false "never"', () => {
  const d = describeRun({ config: undefined, toggle: undefined, now: at('2026-09-28T15:00:00Z'), run: { optIn: true, override: 'auto', done: false } });
  assert.deepEqual([d.state, d.pill], ['unknown', '']);
});

test('never throws on junk', () => {
  assert.doesNotThrow(() => describeAwayMode({ config: null, toggle: undefined, now: NaN }));
  assert.deepEqual(describeAwayMode({ config: null, toggle: 'auto', now: 0 }).lines, ['Away mode settings could not be read.']);
});

test('sidebar switch: "I\'m here | I\'m away" lights what applies right now', () => {
  const sw = (o) => describeAwaySwitch({ ...base, ...o });
  const here = sw({ now: at('2026-09-28T15:00:00Z') });
  assert.deepEqual([here.side, here.status, here.disabled], ['here', 'here', false]);
  assert.equal(here.tip, 'Right now it is 15:00. You count as here. Next away hours start at 22:00. Click "I\'m away" to have worca answer on every run now.');
  const hours = sw({ now: at('2026-09-28T23:00:00Z') });
  assert.deepEqual([hours.side, hours.status], ['away', 'away-hours'], 'the away hours light "I\'m away" by themselves');
  assert.equal(hours.tip, 'Right now it is 23:00. You count as away (your away hours). They end at 07:00. Click "I\'m here" to count as here until they end.');
  const held = sw({ now: at('2026-09-28T23:30:00Z'), hereSince: at('2026-09-28T23:00:00Z') });
  assert.deepEqual([held.side, held.status], ['here', 'here-now']);
  assert.equal(held.tip, 'Right now it is 23:30. You count as here because you said "I\'m here". Your away hours apply again from 22:00. Click "I\'m away" to have worca answer on every run now.');
  const on = sw({ now: at('2026-09-28T15:00:00Z'), toggle: 'on' });
  assert.deepEqual([on.side, on.tip], ['away', 'You said you are away. worca answers on every run until you click "I\'m here".']);
  const paused = sw({ now: at('2026-09-28T23:00:00Z'), toggle: 'off' });
  assert.deepEqual([paused.side, paused.status, paused.disabled], ['here', 'paused', false]);
  assert.equal(paused.tip, 'Away mode is paused. worca answers nothing. Click "I\'m away" to have worca answer on every run, or turn it back on in Settings › Away mode.');
  const none = sw({ now: at('2026-09-28T15:00:00Z'), config: { ...C, window: null } });
  assert.deepEqual([none.side, none.tip], ['here', 'No away hours are set. Click "I\'m away" to have worca answer on every run now.']);
  const junk = describeAwaySwitch({ config: null, toggle: 'auto', now: 0 });
  assert.deepEqual([junk.side, junk.disabled, junk.tip], [null, true, 'Away mode settings could not be read.']);
  for (const d of [here, hours, held, on, paused, none]) assert.doesNotMatch(d.tip, /night|grace|eligible|Force|strategy/i);
});

test('"I\'m here" inside the away hours: the summary and the run pill count it as here', () => {
  const now = at('2026-09-28T23:30:00Z'); const hereSince = at('2026-09-28T23:00:00Z');
  const d = describeAwayMode({ ...base, now, hereSince });
  assert.equal(d.status, 'here-now');
  assert.equal(d.lines[0], 'Right now it is 23:30. You count as here because you said "I\'m here". Your away hours apply again from 22:00.');
  assert.equal(describeAwayMode({ ...base, now, hereSince: at('2026-09-28T15:00:00Z') }).status, 'away-hours', 'said by day: tonight still counts');
  const run = (o) => describeRun({ config: C, toggle: 'auto', now, hereSince, run: { optIn: true, override: 'auto', openedAt: '2026-09-28T23:30:00Z', done: false, ...o } });
  assert.deepEqual([run().state, run().minutes], ['after', 30], 'a marked run gets the by-day rule, as when you are here by day');
  assert.equal(run({ optIn: false }).state, 'wait');
});
