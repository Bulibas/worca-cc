// test/night-decider-model.test.mjs — which model and effort the nightDecider runs with
// (src/core/night/decider-model.mjs), and the effort lists that must stay equal to model-env EFFORTS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDeciderPair } from '../src/core/night/decider-model.mjs';
import { NIGHT_EFFORTS } from '../src/core/night/config.mjs';
import { DECIDER_EFFORTS } from '../src/shared/away-mode/labels.mjs';
import { EFFORTS } from '../src/core/model-env.mjs';

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['medium', 'high', 'xhigh', 'max'] },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', efforts: ['medium', 'high'] },
  { id: 'corp-bridged', label: 'Corp', efforts: ['medium', 'high'], bridged: 'openai', needsSignIn: true },
];

test('the effort lists the zero-import leaves keep are model-env EFFORTS', () => {
  assert.deepEqual([...NIGHT_EFFORTS], EFFORTS);
  assert.deepEqual([...DECIDER_EFFORTS], EFFORTS);
});

test('a configured model that is in the catalog and runnable is used, in the catalog casing', () => {
  assert.deepEqual(resolveDeciderPair({ deciderModel: 'Claude-Opus-5-5', deciderEffort: 'max', runModel: 'claude-sonnet-5-5' }, { models: MODELS }),
    { model: 'claude-opus-5-5', effort: 'max', source: 'setting', stale: null, staleWhy: null, effortDropped: null });
});

test('a stale id falls back to the run model and is reported; unset → the run model; no run model → null', () => {
  assert.deepEqual(resolveDeciderPair({ deciderModel: 'gone-model', runModel: 'claude-sonnet-5-5' }, { models: MODELS }),
    { model: 'claude-sonnet-5-5', effort: 'medium', source: 'run', stale: 'gone-model', staleWhy: 'catalog', effortDropped: null });
  assert.deepEqual(resolveDeciderPair({ deciderModel: null, runModel: 'claude-sonnet-5-5' }, { models: MODELS }),
    { model: 'claude-sonnet-5-5', effort: 'medium', source: 'run', stale: null, staleWhy: null, effortDropped: null });
  assert.deepEqual(resolveDeciderPair({}, { models: MODELS }),
    { model: null, effort: 'medium', source: 'default', stale: null, staleWhy: null, effortDropped: null });
  assert.deepEqual(resolveDeciderPair({ deciderModel: 'gone-model' }, { models: [] }),
    { model: null, effort: 'medium', source: 'default', stale: 'gone-model', staleWhy: 'catalog', effortDropped: null });
});

test('a bridged model whose provider is not set up is not runnable: the run model instead', () => {
  const r = resolveDeciderPair({ deciderModel: 'corp-bridged', runModel: 'claude-opus-5-5' }, { models: MODELS });
  assert.deepEqual([r.model, r.source, r.stale, r.staleWhy], ['claude-opus-5-5', 'run', 'corp-bridged', 'sign-in']);
});

test('effort: the configured one when the model offers it, else medium (and reported); unknown values read as medium', () => {
  const haiku = resolveDeciderPair({ deciderModel: 'claude-haiku-4-5', deciderEffort: 'max' }, { models: MODELS });
  assert.deepEqual([haiku.model, haiku.effort, haiku.effortDropped], ['claude-haiku-4-5', 'medium', 'max']);
  assert.equal(resolveDeciderPair({ deciderModel: 'claude-haiku-4-5', deciderEffort: 'high' }, { models: MODELS }).effort, 'high');
  // An effort with no catalog entry to check it against (the run's model off-catalog, or none) is passed as set.
  assert.equal(resolveDeciderPair({ deciderEffort: 'xhigh', runModel: 'off-catalog' }, { models: MODELS }).effort, 'xhigh');
  assert.equal(resolveDeciderPair({ deciderEffort: 'xhigh' }, { models: MODELS }).effort, 'xhigh');
  assert.equal(resolveDeciderPair({ deciderEffort: 'low' }, { models: MODELS }).effort, 'medium');
  // The default is never reported as dropped, even for a model that lists no efforts.
  assert.equal(resolveDeciderPair({ deciderModel: 'x' }, { models: [{ id: 'x', efforts: [] }] }).effortDropped, null);
});
