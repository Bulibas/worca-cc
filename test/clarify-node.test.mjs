// test/clarify-node.test.mjs
// Clarify is its own graph node (n_clarify on the built-in default) that runs
// BEFORE the planner. It records its own execution row, writes clarify.json
// (scratch) + the DB answers row, and a graph WITHOUT a clarify node still plans
// (the planner's `answers` input is optional).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator } from '../src/core/orchestrator.mjs';
import { readClarifyRow } from '../src/core/artifacts.mjs';
import { writeSeedGraph } from './helpers/graph-templates.mjs';
import { useTempHome } from './helpers/temp-home.mjs';
import { checkRows } from './helpers/rows.mjs';

useTempHome(after); // store writes -> isolated temp home

const tmpDirs = [];
async function makeTmpDir() {
  const dir = await mkdtemp(join(tmpdir(), 'worca-cc-clarify-node-'));
  tmpDirs.push(dir);
  return dir;
}
after(async () => { await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true }))); });

test('default run: clarify is its own node, one round, clarify.json + DB answers', async () => {
  // One wf_default mock run carries every assertion (was two identical runs here, plus
  // test/clarify.test.mjs's one-round run): its listeners attach before run().
  const orch = createOrchestrator({
    projectDir: await makeTmpDir(),
    workflowId: 'wf_default',
    prompt: 'demo task',
    auto: true,             // auto-answers the clarify gate (orch _ask kind:'clarify')
    claude: { mock: true },
  });
  const clarifyCycles = [];
  let clarifyQuestions = 0;
  orch.on('exec', ({ agentKey, ordinal }) => {
    if (agentKey === 'clarify') clarifyCycles.push(ordinal);
  });
  // In mock mode the planner always returns questions on the first call
  // (MOCK_PRIOR === 0), so a single clarify round must fire this exactly once.
  orch.on('question', ({ kind }) => {
    if (kind === 'clarify') clarifyQuestions += 1;
  });
  const res = await orch.run();

  await checkRows([
    { name: 'clarify runs as its own node (n_clarify) and the planner is a separate row', run: () => {
      assert.equal(res.status, 'done', 'mock pipeline finishes');

      const st = orch.getState();
      const clarify = st.steps.find((s) => s.nodeId === 'n_clarify');
      assert.ok(clarify, 'a clarify execution row exists');
      assert.equal(clarify.key, 'x:n_clarify:1', 'the ledger key IS the executionId');

      const plan = st.steps.find((s) => s.nodeId === 'n_plan');
      assert.ok(plan, 'the planner execution row exists');
      assert.equal(plan.key, 'x:n_plan:1');
      assert.notEqual(plan.nodeId, clarify.nodeId);

      // Totals stay Σ steps (no double-count, no drop) — the structural invariant.
      const sum = (f) => st.steps.reduce((a, s) => a + (Number(s[f]) || 0), 0);
      assert.equal(st.totalActiveMs, sum('activeMs'), 'totalActiveMs === Σ steps.activeMs');
    } },
    { name: 'the default run writes clarify.json (scratch) AND a DB answers row', run: async () => {
      assert.equal(res.status, 'done');

      const pipelineDir = orch.pipeline.dir;            // VERIFIED real accessor (orchestrator.mjs)
      const fs = JSON.parse(await readFile(join(pipelineDir, 'clarify.json'), 'utf8'));
      assert.ok(Array.isArray(fs.questions), 'clarify.json has a questions array');

      const row = readClarifyRow(orch.pipeline.id);     // VERIFIED real accessor
      assert.ok(row && row.answers, 'answers persisted to the clarify DB row');
    } },
    { name: 'clarify runs exactly one round (no clarify execution past ordinal 1)', run: () => {
      assert.equal(res.status, 'done', 'mock pipeline should finish');
      assert.ok(clarifyCycles.length > 0, 'the clarify node should run');
      assert.ok(
        clarifyCycles.every((c) => c === 1),
        `clarify must stay on cycle 1, saw cycles ${clarifyCycles.join(',')}`,
      );
      assert.equal(clarifyQuestions, 1, 'clarify must be asked exactly once');
    } },
  ]);
});

test('a workflow WITHOUT a clarify node records no clarify step and still plans', async () => {
  // wf_quick-fix: planner -> implementer -> reviewer, no clarify node.
  const tpl = await writeSeedGraph('wf_quick-fix', 'wf_no-clarify-node');
  const orch = createOrchestrator({ projectDir: await makeTmpDir(), workflowId: tpl.id, prompt: 'demo', auto: true, claude: { mock: true } });
  const res = await orch.run();
  assert.equal(res.status, 'done');
  const st = orch.getState();
  assert.equal(st.steps.find((s) => s.nodeId === 'n_clarify'), undefined, 'no clarify execution');
  assert.ok(st.steps.find((s) => s.nodeId === 'n_plan'), 'planner still ran');
});
