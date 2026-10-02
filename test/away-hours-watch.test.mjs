// test/away-hours-watch.test.mjs — the away hours starting or ending by themselves (wording §3.9):
// one event per edge, never for a click, with how many runs it touches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAwayHoursWatch } from '../src/core/night/hours-watch.mjs';
import { NIGHT_DEFAULTS } from '../src/core/night/config.mjs';

const at = (iso) => Date.parse(iso);
const C = { ...NIGHT_DEFAULTS, window: '22:00-07:00', timeZone: 'UTC', graceMinutes: 30, enabled: false };

function setup({ runs = [], answered = { answered: 0, flagged: 0 } } = {}) {
  let t = at('2026-09-28T21:58:00Z');
  const status = { config: C, toggle: 'auto', hereSince: null };
  const events = []; const since = [];
  const watch = createAwayHoursWatch({
    readStatus: () => status, now: () => t, localZone: 'UTC',
    liveRuns: () => runs, effective: () => ({ config: C }),
    answeredSince: (ms) => { since.push(ms); return answered; },
    onEdge: (e) => events.push(e),
  });
  return { watch, events, since, status, set: (iso) => { t = at(iso); } };
}
const MARKED = { title: 'Fix login', projectDir: '/p', status: 'running', night: { optIn: true, override: 'auto' } };
const PLAIN = { title: 'Docs', projectDir: '/p', status: 'running', night: { optIn: false, override: 'auto' } };

test('the hours start: one event, naming the runs worca now answers on; chat only when a run is touched', () => {
  const s = setup({ runs: [MARKED, PLAIN, { ...MARKED, status: 'done' }] });
  s.watch.tick();                                   // baseline: nothing to say
  assert.deepEqual(s.events, []);
  s.set('2026-09-28T22:00:30Z'); s.watch.tick();
  s.set('2026-09-28T22:01:00Z'); s.watch.tick();    // still the same stretch: no second event
  assert.equal(s.events.length, 1);
  assert.deepEqual(s.events[0], { edge: 'start', count: 1, chat: true,
    text: 'Away hours started (22:00 to 07:00). worca now answers questions on 1 run.' });
  const quiet = setup({ runs: [PLAIN] });
  quiet.watch.tick(); quiet.set('2026-09-28T22:00:30Z'); quiet.watch.tick();
  assert.deepEqual(quiet.events[0], { edge: 'start', count: 0, chat: false,
    text: 'Away hours started (22:00 to 07:00). No run is answered by worca right now.' });
});

test('the hours end: a recap of what worca answered in the stretch; chat only when it answered something', () => {
  const s = setup({ answered: { answered: 3, flagged: 1 } });
  s.watch.tick(); s.set('2026-09-28T22:00:30Z'); s.watch.tick();
  s.set('2026-09-29T07:00:30Z'); s.watch.tick();
  assert.deepEqual(s.events[1], { edge: 'end', count: 3, chat: true,
    text: 'Away hours ended. worca answered 3 questions while you were away; 1 to check.' });
  assert.equal(s.since.at(-1), at('2026-09-28T22:00:00Z'), 'counted from the start of the stretch');
  const none = setup();
  none.watch.tick(); none.set('2026-09-28T22:00:30Z'); none.watch.tick(); none.set('2026-09-29T07:00:30Z'); none.watch.tick();
  assert.deepEqual(none.events[1], { edge: 'end', count: 0, chat: false, text: 'Away hours ended. worca answered nothing while you were away.' });
});

test('a click is never an edge: "I\'m away now", "I\'m here" and Pause change the status without an event', () => {
  const s = setup({ runs: [MARKED] });
  s.watch.tick();
  s.status.toggle = 'on'; s.set('2026-09-28T22:00:30Z'); s.watch.tick();   // already away: the hours change nothing
  s.status.toggle = 'auto'; s.status.hereSince = at('2026-09-28T22:05:00Z'); s.set('2026-09-28T22:05:30Z'); s.watch.tick();
  s.set('2026-09-29T07:00:30Z'); s.watch.tick();                               // the skipped stretch ends: not an edge
  assert.deepEqual(s.events, []);
  s.set('2026-09-29T22:00:30Z'); s.watch.tick();                               // the next stretch applies by itself
  assert.equal(s.events.at(-1).edge, 'start');
});

test('never throws: unreadable settings are no status', () => {
  const watch = createAwayHoursWatch({ readStatus: () => { throw new Error('boom'); }, now: () => 0, liveRuns: () => [], effective: () => ({ config: C }), answeredSince: () => ({ answered: 0, flagged: 0 }), onEdge: () => { throw new Error('x'); } });
  assert.doesNotThrow(() => { watch.tick(); watch.tick(); });
});
