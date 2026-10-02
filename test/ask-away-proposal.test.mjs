// test/ask-away-proposal.test.mjs — propose_away_mode_change: the validator builds the confirm card
// (before/after summary lines, one line per changed field) and never writes anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAwayChangeValidator, awayEventPrompt, awayNoticeText } from '../src/core/ask/away-proposal.mjs';

const T15 = Date.parse('2026-09-28T15:00:00Z');
const mk = ({ user = {}, project = {}, team = {} } = {}) => createAwayChangeValidator({
  layers: (dir) => ({ user, project: dir ? project : null, team: dir ? team : {} }),
  projectOf: (k) => (k === 'p' ? { key: 'p', name: 'P', path: '/p' } : null), toggle: () => 'auto', now: () => T15 });

test('a user-level change builds a card with before/after summaries', async () => {
  const r = await mk({ user: { window: '22:00-07:00', timeZone: 'UTC' } })({ level: 'user', set: { enabled: true } });
  assert.equal(r.ok, true);
  assert.equal(r.card.type, 'away');
  assert.deepEqual(r.card.changes, [{ field: 'enabled', label: 'Which runs', before: 'Only runs I marked', after: 'All runs' }]);
  assert.equal(r.card.summary, 'Which runs: All runs');
  assert.match(r.card.before[0], /runs you marked/);
  assert.match(r.card.after[0], /all runs/);
});

test('unset returns a field to the layer below and says so', async () => {
  const r = await mk({ user: { graceMinutes: 30 }, project: { graceMinutes: 45 } })({ level: 'project', projectKey: 'p', unset: ['graceMinutes'] });
  assert.deepEqual(r.card.changes, [{ field: 'graceMinutes', label: 'Marked runs by day', before: '45 minutes', after: '30 minutes (inherited)' }]);
});

test('project level refuses the spend cap; bad values and fields are named; unknown project', async () => {
  const v = mk();
  assert.equal((await v({ level: 'project', projectKey: 'p', set: { spendCapUsd: 3 } })).ok, false);
  const bad = await v({ level: 'user', set: { graceMinutes: 0 } });
  assert.equal(bad.ok, false); assert.match(bad.errors[0], /graceMinutes/);
  assert.match((await v({ level: 'user', unset: ['bogus'] })).errors[0], /bogus/);
  assert.match((await v({ level: 'project', projectKey: 'zz', set: { enabled: true } })).errors[0], /unknown project "zz"/);
  assert.match((await v({ level: 'user' })).errors[0], /nothing to change/);
});

test('event prompt and notice', () => {
  assert.equal(awayEventPrompt({ cardId: 'c1', state: 'applied', card: { summary: 'Which runs: All runs' } }), '[worca event] away card c1 applied; "Which runs: All runs"');
  assert.equal(awayNoticeText({ state: 'declined', card: { summary: 'Which runs: All runs' } }), 'Declined — Which runs: All runs');
});
