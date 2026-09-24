import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGraph } from '../src/shared/graph/validate.mjs';
import { classifyLoops } from '../src/shared/graph/loops.mjs';
import { realPortsFn } from './helpers/graph-ports.mjs';
import { GRAPH_PRESENTATION_WORKFLOW } from '../src/core/graph/presentation-workflow.mjs';

test('wf_presentation validates against the REAL sidecars: 0 errors, 0 warnings', () => {
  const { ok, errors, warnings } = validateGraph(GRAPH_PRESENTATION_WORKFLOW, realPortsFn());
  assert.deepEqual(errors, [], JSON.stringify(errors, null, 1));
  assert.deepEqual(warnings, [], JSON.stringify(warnings, null, 1));
  assert.equal(ok, true);
});

test('all four fix loops close on the or card and carry a cycle cap', () => {
  const { loopWireIds } = classifyLoops(GRAPH_PRESENTATION_WORKFLOW, realPortsFn());
  assert.deepEqual([...loopWireIds].sort(), ['w12', 'w14', 'w19', 'w25']);
  const cap = (id) => GRAPH_PRESENTATION_WORKFLOW.wires.find((w) => w.id === id).config.maxCycles;
  assert.equal(cap('w12'), 3);            // audit  -> builder
  assert.equal(cap('w14'), 3);            // review -> builder
  // An export or bundle finding re-runs builder + audit + review, so caps are lower.
  assert.equal(cap('w19'), 2);            // export -> builder
  assert.equal(cap('w25'), 2);            // bundle -> builder
});

test('the bundle step sits between the review and the export, and gates it', () => {
  const w = (id) => GRAPH_PRESENTATION_WORKFLOW.wires.find((x) => x.id === id);
  const node = (id) => GRAPH_PRESENTATION_WORKFLOW.nodes.find((n) => n.id === id);
  assert.equal(node('n_bundle').kind, 'script');
  assert.equal(node('n_bundle').key, 'deckBundle');
  // Gated on the clean review, so it runs ONCE — and it also takes `built` from
  // inside the fix loop, the shape graph-scheduler pins against re-firing.
  assert.deepEqual(w('w22').from, { node: 'n_review', port: 'pass' });
  assert.deepEqual(w('w22').to, { node: 'n_bundle', port: 'await' });
  assert.deepEqual(w('w23').from, { node: 'n_build', port: 'built' });
  // The export now waits on the bundle, not on the review: w16 is gone.
  assert.equal(GRAPH_PRESENTATION_WORKFLOW.wires.some((x) => x.id === 'w16'), false);
  assert.deepEqual(w('w24').from, { node: 'n_bundle', port: 'pass' });
  assert.deepEqual(w('w24').to, { node: 'n_export', port: 'await' });
});

test('the or card has a slot for every fix source', () => {
  const node = (id) => GRAPH_PRESENTATION_WORKFLOW.nodes.find((n) => n.id === id);
  const intoOr = GRAPH_PRESENTATION_WORKFLOW.wires.filter((w) => w.to.node === 'n_or');
  assert.equal(node('n_or').config.arity, intoOr.length,
    'an unwired or-input is an unwired required port (V9) at run start');
  assert.deepEqual(intoOr.map((w) => w.to.port).sort(), ['in1', 'in2', 'in3', 'in4']);
});

test('the export step is terminal, and the request reaches both judging steps', () => {
  const w = (id) => GRAPH_PRESENTATION_WORKFLOW.wires.find((x) => x.id === id);
  assert.deepEqual(w('w20').from, { node: 'n_export', port: 'pass' });
  assert.deepEqual(w('w20').to, { node: 'n_end', port: 'result' });
  // Every agent that reads the ORIGINAL request, so a dropped deliverable has
  // somewhere to be caught. Before this, nothing compared output to the ask.
  const taskConsumers = GRAPH_PRESENTATION_WORKFLOW.wires
    .filter((x) => x.from.node === 'n_task').map((x) => x.to.node).sort();
  assert.deepEqual(taskConsumers, ['n_clarify', 'n_export', 'n_narr', 'n_review']);
});

test('the checkpoints and the builder barrier are declared on the nodes', () => {
  const node = (id) => GRAPH_PRESENTATION_WORKFLOW.nodes.find((n) => n.id === id);
  assert.equal(node('n_narr').config.askQuestions, true);
  assert.equal(node('n_system').config.askQuestions, true);
  assert.equal(node('n_build').config.awaitAll, true);
  assert.equal(GRAPH_PRESENTATION_WORKFLOW.domain, 'presentation');
  assert.ok(Object.isFrozen(GRAPH_PRESENTATION_WORKFLOW.nodes[0].config));
});
