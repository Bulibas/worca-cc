import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awayAnswersSummary, KIND_LABELS, METHOD_OPTIONS, CRITERIA_LABELS, FIELD_LABELS, WHICH_RUNS_OPTIONS, RUN_SWITCH_OPTIONS, RUN_SWITCH_TIP, STATUS_ACTIONS, statusActions, GRACE_NO_HOURS, kindLabel, pillText, KIND_SHORT, kindShort, awayAnswerRows } from '../src/shared/away-mode/labels.mjs';
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
  walk({ KIND_LABELS, KIND_SHORT, METHOD_OPTIONS, CRITERIA_LABELS, FIELD_LABELS, WHICH_RUNS_OPTIONS, RUN_SWITCH_OPTIONS, RUN_SWITCH_TIP, STATUS_ACTIONS });
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

test('kindShort: a short caption for every kind the answers list shows', () => {
  for (const k of [...NIGHT_KINDS, 'cost-cap']) assert.ok(KIND_SHORT[k], k);
  assert.equal(kindShort('clarify'), 'Clarifying questions');
  assert.equal(kindShort('gate'), 'Review loop');
  assert.equal(kindShort('mystery'), 'mystery', 'an unknown kind falls back to its name');
});

test('awayAnswerRows: one row per answered question, its wording, the answer and its reason', () => {
  const rows = awayAnswerRows({ kind: 'clarify', choice: 'Live | Devs', flagged: true, rationale: 'delivery: x\naudience: y', questions: [
    { id: 'delivery', question: 'How will the deck be delivered?', choice: 'Live', flagged: true, rationale: 'the agent was not sure enough; took the option easiest to undo. It ships narration.' },
    { id: 'audience', question: 'Who is it for?', choice: 'Devs', flagged: false, rationale: 'it fits the brief' },
  ] });
  assert.deepEqual(rows, [
    { q: 'How will the deck be delivered?', a: 'Live', why: 'The agent was not sure enough; took the option easiest to undo. It ships narration.', check: true },
    { q: 'Who is it for?', a: 'Devs', why: 'It fits the brief.', check: false },
  ]);
});

test('awayAnswerRows: a row saved before the question text was stored reads its id', () => {
  const qs = [{ id: 'feature-scope' }, { id: 'q2' }, { id: 'brandKit' }, { id: '' }].map((x) => ({ ...x, choice: 'A', flagged: false, rationale: '' }));
  assert.deepEqual(awayAnswerRows({ kind: 'clarify', choice: 'A', questions: qs }).map((r) => [r.q, r.why]),
    [['Feature scope', ''], ['Question 2', ''], ['Brand kit', ''], ['Question', '']]);
});

test('awayAnswerRows: a free-text question has no answer and is to check', () => {
  assert.deepEqual(awayAnswerRows({ kind: 'questions', choice: '', flagged: true, questions: [{ id: 'name', question: 'Name it?', choice: '', flagged: true, rationale: 'free-text question; worca cannot answer it' }] }),
    [{ q: 'Name it?', a: 'No answer', why: 'Free-text question; worca cannot answer it.', check: true }]);
});

test('awayAnswerRows: a flagged ask whose questions are not marked marks every row', () => {
  const rows = awayAnswerRows({ kind: 'form', choice: '{}', flagged: true, questions: [{ id: 'a', question: 'A?', choice: 'x', flagged: false }, { id: 'b', question: 'B?', choice: 'y', flagged: false }] });
  assert.deepEqual(rows.map((r) => r.check), [true, true]);
});

test('awayAnswerRows: asks without questions read as one outcome', () => {
  const one = (d) => awayAnswerRows(d);
  assert.deepEqual(one({ kind: 'gate', choice: 'continue', flagged: false, rationale: 'no critical issues left, continuing' }),
    [{ q: null, a: 'Continued', why: 'No critical issues left, continuing.', check: false }]);
  assert.equal(one({ kind: 'gate', choice: 'another', flagged: false })[0].a, 'One more fix round');
  assert.equal(one({ kind: 'workflow', choice: 'accept', flagged: false })[0].a, 'Accepted');
  assert.equal(one({ kind: 'recovery', choice: 'retry', flagged: false })[0].a, 'Retried');
  assert.equal(one({ kind: 'recovery', choice: 'pause', flagged: true })[0].a, 'Stopped retrying');
  assert.equal(one({ kind: 'cost-cap', choice: 'continue', flagged: true })[0].a, 'Continued past the cap');
  assert.deepEqual(one({ kind: 'form', choice: '{"a":1}', strategy: 'defaults', flagged: false, questions: [], rationale: "the form's default values" }),
    [{ q: null, a: 'Default values', why: '', check: false }]);
  assert.equal(one({ kind: 'clarify', choice: '{"answers":[]}', strategy: 'auto', flagged: true, rationale: 'gave the --yes answer instead: x' })[0].a, 'Default answer');
});

test('awayAnswerRows: a limit row is a pause, never one to check', () => {
  assert.deepEqual(awayAnswerRows({ kind: 'clarify', choice: null, guardrail: 'maxDecisions', flagged: true, rationale: 'Paused: worca answered 3 times on this run, the limit you set.' }),
    [{ q: null, a: 'Paused: answer limit reached', why: 'Paused: worca answered 3 times on this run, the limit you set.', check: false }]);
  assert.equal(awayAnswerRows({ kind: 'gate', choice: null, guardrail: 'spendCap', flagged: true })[0].a, 'Paused: spending cap reached');
  assert.equal(awayAnswerRows({ kind: 'gate', choice: null, flagged: true })[0].a, 'Paused');
});

test('awayAnswerRows: row text uses the glossary words only', () => {
  const recs = [{ kind: 'gate', choice: 'continue' }, { kind: 'gate', choice: 'another' }, { kind: 'workflow', choice: 'accept' }, { kind: 'recovery', choice: 'retry' },
    { kind: 'recovery', choice: 'pause' }, { kind: 'cost-cap', choice: 'continue' }, { kind: 'form', choice: '{}', questions: [] }, { kind: 'clarify', choice: 'x', strategy: 'auto' },
    { kind: 'gate', choice: null, guardrail: 'maxDecisions' }, { kind: 'gate', choice: null, guardrail: 'spendCap' }, { kind: 'questions', choice: '', questions: [{ id: 'q1', choice: '' }] }];
  for (const r of recs.flatMap((d) => awayAnswerRows(d))) for (const t of [r.q, r.a].filter(Boolean)) {
    for (const bad of [/\bnight\b/i, /\bstrategy\b/i, /\bdecisions?\b/i, /\bguardrail\b/i]) assert.doesNotMatch(t, bad, t);
  }
});
