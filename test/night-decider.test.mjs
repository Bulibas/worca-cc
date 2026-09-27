// test/night-decider.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAsk } from '../src/core/night/decider.mjs';
import { NIGHT_DEFAULTS } from '../src/core/night/config.mjs';

const cfg = { ...NIGHT_DEFAULTS, strategy: 'weights' };

test('clarify/questions: per-question answers + aggregate', async () => {
  const r = await decideAsk({ kind: 'questions', id: 'k', questions: [
    { id: 'a', question: '?', options: ['x', 'y'], confidence: [90, 10], recommended: 'x' },
    { id: 'b', question: '?', options: ['p', 'q'] }] }, { config: cfg });
  assert.deepEqual(r.payload, { answers: [{ id: 'a', choice: 'x' }, { id: 'b', choice: 'p' }] });
  assert.equal(r.record.flagged, true, 'any flagged question flags the decision');
  assert.equal(r.record.strategy, 'weights');
});

test('clarify with analysis: ONE analysis call for all questions', async () => {
  let calls = 0;
  const analyze = async (qs) => { calls += 1; return Object.fromEntries(qs.map((q) => [q.id, { choice: q.options[1], confidence: 90, rationale: 'r', reversible: true, scores: {} }])); };
  const r = await decideAsk({ kind: 'clarify', id: 'c', questions: [
    { id: 'a', question: '?', options: ['x', 'y'] }, { id: 'b', question: '?', options: ['p', 'q'] }] },
  { config: { ...NIGHT_DEFAULTS, strategy: 'analysis' }, analyze });
  assert.deepEqual(r.payload.answers.map((a) => a.choice), ['y', 'q']);
  assert.equal(calls, 1);
  assert.equal(r.record.flagged, false);
});

test('form: defaults, then the strategy for enum fields without a default, else autoValues', async () => {
  const answerSchema = { type: 'object', properties: {
    size: { type: 'string', enum: ['s', 'm'], default: 'm' },
    color: { type: 'string', enum: ['red', 'blue'] },
    note: { type: 'string' } } };
  const r = await decideAsk({ kind: 'form', id: 'f', form: 'pick', version: 1, answerSchema, autoValues: { size: 'm', color: 'red', note: '' } },
    { config: { ...NIGHT_DEFAULTS, strategy: 'weights' } });
  assert.deepEqual(r.payload, { form: 'pick', version: 1, values: { size: 'm', color: 'red', note: '' } });
  assert.equal(r.record.flagged, true, 'color decided without a recommendation');
});

test('gate uses extra cycles from the counter', async () => {
  const r = await decideAsk({ kind: 'gate', id: 'g', wireId: 'w', issues: [{ severity: 'critical' }] }, { config: cfg, gateCyclesUsed: () => 0 });
  assert.deepEqual(r.payload, { decision: 'another' });
  assert.equal(r.record.meta.wireId, 'w');
  const spent = await decideAsk({ kind: 'gate', id: 'g', wireId: 'w', issues: [{ severity: 'critical' }] }, { config: cfg, gateCyclesUsed: () => 1 });
  assert.deepEqual([spent.payload.decision, spent.record.flagged], ['continue', true]);
});

test('workflow accepts the proposal by name', async () => {
  const r = await decideAsk({ kind: 'workflow', id: 'auto-1', workflow: { name: 'wf' } }, { config: cfg });
  assert.deepEqual(r.payload, { decision: 'accept', name: 'wf', nodes: {} });
});

test('recovery waits the backoff then retries', async () => {
  let waited = 0;
  const r = await decideAsk({ kind: 'recovery', id: 'r', recovery: { cls: 'network' } }, { config: cfg, recoveryAttempts: () => 1, sleep: async (ms) => { waited = ms; } });
  assert.deepEqual(r.payload, { decision: 'retry' });
  assert.ok(waited > 0);
});

test('neverDecide kinds return null (wait for the user)', async () => {
  assert.equal(await decideAsk({ kind: 'gate', id: 'g', issues: [] }, { config: { ...cfg, neverDecide: ['gate'] } }), null);
});
