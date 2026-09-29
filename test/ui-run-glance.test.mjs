// test/ui-run-glance.test.mjs — the Running detail glance helpers (ui/public/run-glance.mjs):
// the trail (one dot per execution, loops add dots, overlaps stack), the Now/Earlier rows,
// and the status copy for every state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  trailColumns, nowRows, earlierRows, glanceState, glanceCopy, renderTrail, renderOrb, nodeLabel, TRAIL_STACK_CAP,
} from '../ui/public/run-glance.mjs';

const stepper = {
  version: 2,
  graph: {
    nodes: [
      { id: 'n_clarify', kind: 'agent', key: 'clarify', label: 'Clarify' },
      { id: 'n_plan', kind: 'agent', key: 'planner', label: 'Plan' },
      { id: 'n_refine', kind: 'agent', key: 'refiner', label: 'Refine' },
      { id: 'n_impl', kind: 'agent', key: 'implementer', label: 'Implement', model: 'sonnet' },
      { id: 'n_docs', kind: 'agent', key: 'docs', label: 'Docs' },
      { id: 'n_or', kind: 'or', key: 'or', label: 'Or' },
      { id: 'n_end', kind: 'end', key: 'end', label: 'End' },
    ],
    wires: [],
  },
};
const at = (m) => new Date(Date.UTC(2026, 8, 29, 10, m)).toISOString();
const row = (nodeId, ord, start, end, status = 'done', extra = {}) => ({
  executionId: `x:${nodeId}:${ord}`, nodeId, ordinal: ord, cycle: ord, kind: 'cycle',
  status, startedAt: at(start), endedAt: end == null ? null : at(end), ...extra,
});

const loopedBranched = {
  status: 'running',
  stepper,
  steps: [
    { key: 'preflight', phase: 'preflight', cycle: 0 },          // bookend: dropped
    row('n_clarify', 1, 0, 1),
    row('n_plan', 1, 1, 3),
    row('n_refine', 1, 3, 4),
    row('n_refine', 2, 4, 5),                                   // loop re-fire: its own dot
    row('n_or', 1, 5, 5),                                       // flow node: not drawn
    row('n_impl', 1, 5, null, 'start', { runningSince: at(5) }),
    row('n_docs', 1, 5, null, 'start'),                         // parallel with impl
  ],
  active: [{ nodeId: 'n_impl' }, { nodeId: 'n_docs' }],
};

test('trail: one dot per execution in start order, loops add dots, overlaps stack, flow nodes skipped', () => {
  const t = trailColumns(loopedBranched);
  assert.equal(t.count, 6);
  assert.deepEqual(t.columns.map((c) => c.dots.map((d) => d.nodeId)),
    [['n_clarify'], ['n_plan'], ['n_refine'], ['n_refine'], ['n_impl', 'n_docs']]);
  assert.equal(t.columns[3].dots[0].label, 'Refine · cycle 2');
  assert.deepEqual(t.columns[4].dots.map((d) => d.state), ['act', 'act']);
  assert.deepEqual(t.columns[0].dots.map((d) => d.state), ['done']);
});

test('trail: a wide fan-out caps the stack and counts the rest', () => {
  const steps = [];
  for (let i = 1; i <= 5; i++) {
    steps.push({ ...row('n_impl', i, 0, 3), executionId: `x:n_impl:1:p1t${i}`, kind: 'task', title: `Task ${i}`, parentExecutionId: 'x:n_impl:1' });
  }
  const t = trailColumns({ status: 'running', stepper, steps });
  assert.equal(t.columns.length, 1);
  assert.equal(t.columns[0].dots.length, TRAIL_STACK_CAP);
  assert.equal(t.columns[0].more, 5 - TRAIL_STACK_CAP);
  assert.equal(t.columns[0].dots[0].label, 'Implement · Task 1');
});

test('trail: sequential executions that touch end-to-start do not stack', () => {
  const t = trailColumns({ stepper, steps: [row('n_plan', 1, 0, 2), row('n_refine', 1, 2, 3)] });
  assert.equal(t.columns.length, 2);
});

test('trail: the execution parked on a question is amber, errors are red', () => {
  const run = { status: 'running', stepper, steps: [row('n_clarify', 1, 0, null, 'start')], pendingQuestion: { id: 'q', kind: 'questions', nodeId: 'n_clarify', questions: [{}, {}] }, active: [{ nodeId: 'n_clarify' }] };
  assert.equal(trailColumns(run).columns[0].dots[0].state, 'ask');
  const failed = { status: 'error', stepper, steps: [row('n_plan', 1, 0, 1, 'error')] };
  assert.equal(trailColumns(failed).columns[0].dots[0].state, 'fail');
});

test('now and earlier rows', () => {
  assert.deepEqual(nowRows(loopedBranched).map((r) => [r.label, r.model]), [['Implement', 'sonnet'], ['Docs', '']]);
  assert.deepEqual(earlierRows(loopedBranched).map((r) => [r.label, r.times]), [['Clarify', 1], ['Plan', 1], ['Refine', 2]]);
  assert.equal(nodeLabel(stepper, 'n_docs'), 'Docs');
  assert.equal(nodeLabel(stepper, 'n_missing'), 'n_missing');
});

test('glance state and copy for every status', () => {
  assert.equal(glanceState({ status: 'starting' }), 'start');
  assert.equal(glanceState({ status: 'pausing' }), 'paused');
  assert.equal(glanceState({ status: 'running', pendingQuestion: {} }), 'ask');
  assert.equal(glanceState({ status: 'stopped' }), 'stop');
  assert.equal(glanceState({ status: 'error' }), 'fail');

  const two = glanceCopy(loopedBranched);
  assert.deepEqual([two.title, two.sub], ['2 steps running', 'Implement and Docs']);
  const one = glanceCopy({ ...loopedBranched, steps: loopedBranched.steps.slice(0, 7) }, { lastLine: 'Edited src/a.js' });
  assert.deepEqual([one.title, one.sub], ['Implement', 'Edited src/a.js']);

  const ask = glanceCopy({ status: 'running', stepper, steps: [], pendingQuestion: { kind: 'questions', nodeId: 'n_clarify', questions: [{}, {}] } });
  assert.deepEqual([ask.state, ask.title, ask.sub], ['ask', '2 questions', 'Clarify is paused until you answer']);
  assert.equal(glanceCopy({ status: 'running', stepper, steps: [], pendingQuestion: { kind: 'gate', nodeId: 'n_refine' } }).title, 'Decision needed');
  const form = glanceCopy({ status: 'running', stepper, steps: [], pendingQuestion: { kind: 'form', nodeId: 'n_docs', title: 'What should this run produce?' } });
  assert.deepEqual([form.title, form.sub], ['Input needed', 'What should this run produce?']);

  assert.equal(glanceCopy({ status: 'paused' }, { pill: { text: 'Paused · cost limit' } }).sub, 'Cost limit. Resume to continue');
  assert.equal(glanceCopy({ status: 'paused' }, { pill: { text: 'Paused' } }).sub, 'Resume to continue where it left off');
  assert.equal(glanceCopy({ status: 'pausing' }).title, 'Pausing');
  assert.equal(earlierRows({ stepper, steps: [row('n_plan', 1, 0, 1, 'paused')] }).length, 0, 'a paused step did not complete');
  assert.equal(glanceCopy({ status: 'done' }).title, 'Finished');
  assert.equal(glanceCopy({ status: 'done' }, { checks: 2 }).sub, '2 things to check before you merge');
  assert.equal(glanceCopy({ status: 'done' }, { checks: 0 }).sub, 'The review found nothing to check');
  assert.equal(glanceCopy({ status: 'stopped' }).title, 'Stopped');
});

test('DOM: trail stacks and the orb carries its state class', () => {
  const { document } = new JSDOM('').window;
  const node = renderTrail(document, trailColumns(loopedBranched));
  assert.equal(node.querySelectorAll('.rg-td').length, 6);
  assert.equal(node.querySelectorAll('.rg-tstack .rg-td-act').length, 2);
  assert.equal(node.querySelector('.rg-td').title, 'Clarify');
  const orb = renderOrb(document, 'ask');
  assert.match(orb.getAttribute('class'), /rg-orb-ask/);
  assert.ok(orb.querySelector('path.rg-orb-mark') && orb.querySelector('circle.rg-orb-dot'), 'a drawn hook and dot, not a font glyph');
  assert.equal(orb.querySelector('text'), null);
});
