// test/helpers-engines-shared.test.mjs — sharedRun / stopAt / afterStarts / seedQuickFix.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempHome } from './helpers/temp-home.mjs';
import { ENGINES, sharedRun, stopAt, afterStarts, isBookend, seedQuickFix } from './helpers/engines.mjs';
import { gitDir } from './helpers/git-dir.mjs';

useTempHome(after);
const engine = ENGINES[0];
const opts = (extra = {}) => ({ projectDir: gitDir('shared'), workflowId: 'wf_default', prompt: 'demo task', claude: { mock: true }, auto: true, ...extra });
let starts = 0;
const shared = () => sharedRun('default', async () => {
  starts++;
  const orch = engine.create(opts());
  const events = [];
  orch.on('exec', (p) => events.push({ nodeId: p.nodeId, executionId: p.executionId, status: p.status }));
  const res = await orch.run();
  return { orch, res, events };
});

test('sharedRun: one run for every reader; state and events are frozen clones', async () => {
  const a = await shared(); const b = await shared();
  assert.equal(starts, 1);
  assert.equal(a.state, b.state);
  assert.equal(a.res.status, 'done');
  assert.ok(Object.isFrozen(a.state.steps[0]));
  assert.throws(() => { a.state.status = 'x'; }, TypeError);
  assert.throws(() => { a.events.push({}); }, TypeError);
  assert.equal(a.events[0].executionId, 'x:preflight:1', 'the first exec event is the Preflight bookend');
  assert.ok(isBookend(a.events[0]) && !isBookend(a.events.find((e) => e.nodeId === 'n_plan')));
});

test('stopAt + afterStarts: stops at the 2nd agent dispatch, never on a bookend', async () => {
  const orch = engine.create(opts());
  const seenStarts = [];
  orch.on('exec', (p) => { if (p.status === 'start') seenStarts.push(p.nodeId); });
  const res = await stopAt(orch, afterStarts(2));
  assert.equal(res.status, 'stopped');
  assert.deepEqual(seenStarts, ['preflight', 'n_task', 'n_clarify', 'n_plan']);
});

test('afterStarts({ agentsOnly: false }): the Task card counts, the Preflight bookend never does', async () => {
  const orch = engine.create(opts());
  const seenStarts = [];
  orch.on('exec', (p) => { if (p.status === 'start') seenStarts.push(p.nodeId); });
  assert.equal((await stopAt(orch, afterStarts(1, { agentsOnly: false }))).status, 'stopped');
  assert.deepEqual(seenStarts, ['preflight', 'n_task']);
});

test('stopAt throws when the predicate never matches', async () => {
  await assert.rejects(stopAt(engine.create(opts()), () => false), /ended done before the stop predicate matched/);
});

test('seedQuickFix: wf_quick-fix runs on a fresh home only once seeded', async () => {
  const unseeded = await engine.create(opts({ workflowId: 'wf_quick-fix' })).run();
  assert.equal(unseeded.status, 'error');
  assert.equal(await seedQuickFix(), 'wf_quick-fix');
  const orch = engine.create(opts({ workflowId: 'wf_quick-fix' }));
  const agents = [];
  orch.on('exec', (p) => { if (p.status === 'start' && p.agentKey) agents.push(p.agentKey); });
  assert.equal((await orch.run()).status, 'done');
  assert.deepEqual([...new Set(agents)], ['planner', 'implementer', 'reviewer']);
});
