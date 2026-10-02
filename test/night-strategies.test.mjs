// test/night-strategies.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weightsVerdict, decideQuestion, gateRule, workflowRule, recoveryRule, weightedTotals, mostReversible } from '../src/core/night/strategies.mjs';
import { NIGHT_DEFAULTS } from '../src/core/night/config.mjs';

const C = NIGHT_DEFAULTS;
const Q = (o) => ({ id: 'q', question: '?', options: ['A', 'B', 'C'], ...o });

test('weights threshold: confidence ≥ minConfidence AND margin ≥ minMargin', () => {
  assert.equal(weightsVerdict(Q({ confidence: [70, 20, 10], recommended: 'A' }), C).met, true);
  assert.equal(weightsVerdict(Q({ confidence: [59, 21, 20], recommended: 'A' }), C).met, false, 'below 60');
  assert.equal(weightsVerdict(Q({ confidence: [60, 36, 4], recommended: 'A' }), C).met, false, 'margin 24 < 25');
  assert.equal(weightsVerdict(Q({ confidence: [60, 35, 5], recommended: 'A' }), C).met, true, 'margin exactly 25');
  assert.equal(weightsVerdict(Q({}), C).met, false, 'no confidence');
});

test('weights strategy below threshold → first option, flagged', async () => {
  const d = await decideQuestion(Q({ confidence: [40, 50, 10], recommended: 'B' }), { ...C, strategy: 'weights' }, {});
  assert.deepEqual([d.choice, d.flagged, d.strategy], ['A', true, 'weights']);
});

test('mixed uses weights when met, never calls analysis', async () => {
  let called = false;
  const d = await decideQuestion(Q({ confidence: [80, 10, 10], recommended: 'A' }), C, { analyze: async () => { called = true; } });
  assert.deepEqual([d.choice, d.flagged, d.strategy, called], ['A', false, 'weights', false]);
});

test('mixed falls back to analysis; low analysis confidence → most reversible, flagged', async () => {
  const analysis = { choice: 'A', confidence: 40, rationale: 'unsure', reversible: false,
    scores: { A: { reversible: 2, matchesMemory: 9 }, B: { reversible: 9, matchesMemory: 3 }, C: { reversible: 5 } } };
  const d = await decideQuestion(Q({}), C, { analyze: async () => analysis });
  assert.deepEqual([d.choice, d.flagged, d.strategy], ['B', true, 'analysis']);
});

test('analysis confident → its choice, not flagged', async () => {
  const d = await decideQuestion(Q({}), C, { analyze: async () => ({ choice: 'C', confidence: 85, rationale: 'r', reversible: true, scores: {} }) });
  assert.deepEqual([d.choice, d.flagged, d.confidence], ['C', false, 85]);
});

test('analysis failure → recommended or first, flagged', async () => {
  const d = await decideQuestion(Q({ confidence: [10, 50, 40], recommended: 'B' }), { ...C, strategy: 'analysis' }, { analyze: async () => { throw new Error('boom'); } });
  assert.deepEqual([d.choice, d.flagged], ['B', true]);
  assert.match(d.rationale, /could not weigh the options \(boom\); took the agent's recommendation/);
});

test('weightedTotals / mostReversible', () => {
  const t = weightedTotals({ A: { reversible: 10, cost: 0 }, B: { reversible: 0, cost: 10 } }, C.criteria, ['A', 'B']);
  assert.ok(t.A > t.B);
  assert.equal(mostReversible(['A', 'B'], { A: { reversible: 3 }, B: { reversible: 3 } }, { A: 1, B: 2 }), 'B', 'tie → higher total');
});

test('gate rule', () => {
  const crit = [{ severity: 'critical', title: 'x' }], major = [{ severity: 'major', title: 'y' }];
  assert.deepEqual(gateRule({ issues: major, extraUsed: 0 }, C), { decision: 'continue', flagged: false, reason: 'no critical issues left, continuing' });
  assert.equal(gateRule({ issues: crit, extraUsed: 0 }, C).decision, 'another');
  assert.equal(gateRule({ issues: crit, extraUsed: 0 }, C).reason, '1 critical issue left, one more fix round');
  assert.equal(gateRule({ issues: [...crit, ...crit], extraUsed: 0 }, C).reason, '2 critical issues left, one more fix round');
  const spent = gateRule({ issues: crit, extraUsed: 1 }, C);
  assert.deepEqual([spent.decision, spent.flagged], ['continue', true]);
  assert.equal(spent.reason, '1 critical issue left but the extra fix rounds are used up; continuing');
});

test('workflow rule: accept; flag when the night budget is ≥80% used', () => {
  assert.deepEqual(workflowRule({ proposal: { name: 'wf' }, budget: null }), { payload: { decision: 'accept', name: 'wf', nodes: {} }, flagged: false, reason: 'workflow accepted as proposed' });
  assert.equal(workflowRule({ proposal: { name: 'wf' }, budget: { spent: 8, cap: 10 } }).flagged, true);
  assert.equal(workflowRule({ proposal: { name: 'wf' }, budget: { spent: 8, cap: 10 } }).reason, 'workflow accepted; 80% of the away spend cap used');
});

test('recovery rule: retry until the per-class budget, then pause flagged', () => {
  assert.deepEqual(recoveryRule({ attempts: 0, max: 3 }), { decision: 'retry', flagged: false });
  assert.deepEqual(recoveryRule({ attempts: 3, max: 3 }), { decision: 'pause', flagged: true });
});

test('an analysis choice outside the options is replaced by the best-scored one AND flagged', async () => {
  const d = await decideQuestion(Q({}), { ...C, strategy: 'analysis' }, {
    analyze: async () => ({ choice: 'D (made up)', confidence: 90, rationale: 'r', reversible: true,
      scores: { B: { matchesMemory: 9, reversible: 9, smallestScope: 9, codebaseConventions: 9, cost: 9 } } }),
  });
  assert.equal(d.choice, 'B');
  assert.equal(d.flagged, true);
  assert.match(d.rationale, /which is not an option/);
});

test('rationales in plain words (wording §3.6)', async () => {
  const met = await decideQuestion(Q({ confidence: [82, 10, 8], recommended: 'A' }), C, {});
  assert.equal(met.rationale, 'the agent recommended this at 82%, well ahead of the next option');
  const low = await decideQuestion(Q({ confidence: [40, 50, 10], recommended: 'B' }), { ...C, strategy: 'weights' }, {});
  assert.equal(low.rationale, 'the agent was not sure enough; first option taken');
  const none = await decideQuestion({ id: 'q', question: '?', options: [] }, C, {});
  assert.equal(none.rationale, 'free-text question; worca cannot answer it');
  const firstOpt = await decideQuestion(Q({}), { ...C, strategy: 'analysis' }, { analyze: async () => { throw new Error('boom'); } });
  assert.equal(firstOpt.rationale, 'could not weigh the options (boom); first option taken');
  const unsure = await decideQuestion(Q({}), { ...C, strategy: 'analysis' }, { analyze: async () => ({ choice: 'A', confidence: 10, rationale: 'r', scores: {} }) });
  assert.match(unsure.rationale, /^the agent was not sure enough; took the option easiest to undo\. r$/);
});
