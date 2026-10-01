import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awayAnswersSummary, KIND_LABELS, METHOD_OPTIONS, CRITERIA_LABELS, FIELD_LABELS, WHICH_RUNS_OPTIONS, RUN_SWITCH_OPTIONS, RUN_SWITCH_TIP, STATUS_ACTIONS, statusActions, GRACE_NO_HOURS, kindLabel, pillText } from '../src/shared/away-mode/labels.mjs';
import { NIGHT_KINDS, NIGHT_STRATEGIES, NIGHT_CRITERIA, NIGHT_FIELDS } from '../src/core/night/config.mjs';

test('every kind, method, criterion and field has a plain label', () => {
  for (const k of NIGHT_KINDS) assert.ok(KIND_LABELS[k], k);
  assert.deepEqual(METHOD_OPTIONS.map((m) => m.value).sort(), [...NIGHT_STRATEGIES].sort());
  for (const c of NIGHT_CRITERIA) assert.ok(CRITERIA_LABELS[c], c);
  for (const f of NIGHT_FIELDS) assert.ok(FIELD_LABELS[f]?.label, f);
});

test('labels use the glossary words only', () => {
  // Scan the TEXT only: object keys and `value`/`mode` entries are stored field names (e.g. `strategy`), exempt by the
  // Global Constraints.
  const texts = [];
  const walk = (v, key) => {
    if (typeof v === 'string') { if (key !== 'value' && key !== 'mode') texts.push(v); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, Array.isArray(v) ? key : k);
  };
  walk({ KIND_LABELS, METHOD_OPTIONS, CRITERIA_LABELS, FIELD_LABELS, WHICH_RUNS_OPTIONS, RUN_SWITCH_OPTIONS, RUN_SWITCH_TIP, STATUS_ACTIONS });
  assert.ok(texts.length > 40, 'walked the labels');
  for (const t of texts) for (const bad of [/\bnight\b/i, /\bgrace\b/i, /\beligible\b/i, /\bforce\b/i, /\bstrategy\b/i, /\bdecisions?\b/i]) assert.doesNotMatch(t.replace(/--night\b/g, ''), bad, t);   // the --night flag name is exempt
  // "decided" is not banned here: wording §3.1 D's exact criterion label is "Matches what you decided before" (the user decided).
});

test('run switch, status actions and pill wording', () => {
  assert.deepEqual(RUN_SWITCH_OPTIONS.map((o) => [o.value, o.label]), [['auto', 'As set up'], ['on', 'Answer for me now'], ['off', 'Never on this run']]);
  assert.deepEqual(STATUS_ACTIONS.auto.map((a) => a.label), ["I'm away now", 'Pause away mode']);
  assert.deepEqual(STATUS_ACTIONS.on.map((a) => a.label), ["I'm back"]);
  assert.equal(STATUS_ACTIONS.on[0].mode, 'here', '"I\'m back" counts as here, even inside the away hours');
  assert.deepEqual(STATUS_ACTIONS.off.map((a) => a.label), ['Turn away mode back on']);
  assert.equal(kindLabel('gate'), 'Fix again or continue, in a review loop');
  assert.equal(kindLabel('cost-cap'), "Continuing past the team's cost cap");
  assert.equal(pillText('after', 12), 'answers after 12 min');
  assert.equal(pillText('now'), 'answering');
});

test('no away hours set: no status button talks about away hours', () => {
  for (const t of ['auto', 'on', 'off']) {
    const withHours = statusActions(t, { hours: true });
    const none = statusActions(t, { hours: false });
    assert.deepEqual(withHours, STATUS_ACTIONS[t], 'with hours: the table as it is');
    assert.deepEqual(none.map((a) => [a.mode, a.label]), STATUS_ACTIONS[t].map((a) => [a.mode, a.label]), 'same buttons');
    for (const a of none) assert.doesNotMatch(a.tip, /away hours|by day/i, `${t}: ${a.tip}`);
  }
  assert.equal(statusActions('off', { hours: false })[0].tip, 'worca answers again when you say you are away.');
  assert.deepEqual(GRACE_NO_HOURS, { label: 'Marked runs', hint: 'A marked run is answered once a question has waited this long. Unmarked runs wait for you.', never: 'Never', neverHint: 'Marked runs wait for you, like every other run.' });
});

test('awayAnswersSummary: the one line every end-of-run channel uses', () => {
  assert.equal(awayAnswersSummary({ decisions: 5, flagged: 2 }), '5 answers while you were away — 2 to check');
  assert.equal(awayAnswersSummary({ decisions: 1, flagged: 0 }), '1 answer while you were away — nothing to check');
  assert.equal(awayAnswersSummary({ decisions: 0, flagged: 0 }), null);
  assert.equal(awayAnswersSummary(null), null);
  assert.equal(awayAnswersSummary({ decisions: 2, flagged: 9 }), '2 answers while you were away — 2 to check', 'never more to check than answers');
});
