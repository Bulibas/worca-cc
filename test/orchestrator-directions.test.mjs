// test/orchestrator-directions.test.mjs
// Phase 3: deterministic delivery + agent-side consumption. A direction posted
// before a step is primed onto that step's ctx (phases.directionsPromptBlock),
// the agent's consumption record is reconciled into a `direction:applied` log
// line, and the done summary counts the directions nobody claimed.
// Harness mirrors test/orchestrator-questions.test.mjs (a real saved v2 graph,
// the real scheduler, one injected `producer`).
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTempHome } from './helpers/temp-home.mjs';
import { gitDir } from './helpers/git-dir.mjs';
import { createOrchestrator } from '../src/core/orchestrator.mjs';
import { writeGraphWorkflow } from '../src/core/workflows.mjs';
import { appendConsumption, appendDirection } from '../src/core/directions.mjs';

useTempHome(after);

let sandboxHome;
const prevEnv = {};
before(async () => {
  sandboxHome = await mkdtemp(join(tmpdir(), 'worca-dir-home-'));
  for (const k of ['HOME', 'USERPROFILE']) prevEnv[k] = process.env[k];
  process.env.HOME = sandboxHome;
  process.env.USERPROFILE = sandboxHome;
});
after(async () => {
  for (const k of ['HOME', 'USERPROFILE']) {
    if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k];
  }
  await rm(sandboxHome, { recursive: true, force: true });
});

function outsOf(ctx) {
  const o = {};
  for (const p of ctx.ports.outputs || []) o[p.id] = { path: ctx.outputs?.[p.id]?.path ?? null, type: p.type };
  return o;
}

/** task -> planner -> implementer -> End (two producer agents in a line). */
const G = {
  id: 'wf_dir_line', name: 'Directions line', domain: 'coding',
  nodes: [
    { id: 'n_task', kind: 'task', x: 0, y: 0, config: {} },
    { id: 'n_a', kind: 'agent', key: 'planner', x: 200, y: 0, config: {} },
    { id: 'n_b', kind: 'agent', key: 'implementer', x: 400, y: 0, config: {} },
    { id: 'n_end', kind: 'end', x: 600, y: 0, config: {} },
  ],
  wires: [
    { id: 'w1', from: { node: 'n_task', port: 'task' }, to: { node: 'n_a', port: 'task' } },
    { id: 'w2', from: { node: 'n_a', port: 'plan' }, to: { node: 'n_b', port: 'plan' } },
    { id: 'w3', from: { node: 'n_b', port: 'done' }, to: { node: 'n_end', port: 'result' } },
  ],
};

test('a direction posted before a step is in that step\'s prompt; consumption is logged; the done summary counts the rest', { timeout: 60000 }, async () => {
  await writeGraphWorkflow(G);
  const seen = [];
  let orch, posted, late;
  const producer = async (ctx) => {
    seen.push({ node: ctx.nodeId, pending: (ctx.directionsPending || []).map((d) => d.id) });
    for (const p of ctx.ports.outputs || []) {
      const path = ctx.outputs?.[p.id]?.path;
      if (path && p.type !== 'void') await writeFile(path, `# ${p.id}\n`, 'utf8');
    }
    if (ctx.nodeId === 'n_a') posted = await orch.direct('cut the roadmap section', 'test');
    if (ctx.nodeId === 'n_b') {
      await appendConsumption(orch.pipeline.dir, { id: posted.id, consumedBy: ctx.executionId || 'x:n_b:1' });
      late = await orch.direct('make the accent darker', 'test');   // consumed by nobody
    }
    return { outputs: outsOf(ctx), verdict: null, summary: 'x' };
  };
  orch = createOrchestrator({
    projectDir: gitDir('dir'), workflowId: G.id, prompt: 'deck', auto: true,
    claude: { mock: true }, runners: { producer },
  });
  const logs = [];
  orch.on('log', (e) => { if (e.source === 'directions') logs.push(e.text); });

  const res = await orch.run();
  assert.equal(res.status, 'done', res.error);

  assert.ok(seen.find((s) => s.node === 'n_b').pending.includes(posted.id), 'n_b saw the pending direction');
  assert.ok(logs.some((t) => t.startsWith('direction:posted')), 'a posted line was logged');
  assert.ok(logs.some((t) => t.startsWith(`direction:applied ${posted.id}`)), 'the applied line was logged');

  const st = orch.getState();
  assert.deepEqual(st.directions, { posted: 2, applied: 1, pending: [{ id: late.id, text: 'make the accent darker' }] });
});

// The inbox summary was computed only on the `done` paths. A direction is
// deliberately accepted for a PAUSED run (resume replays it) — so a run that is
// then stopped, errors, or is never resumed left state.directions null, and
// renderDone, formatRunSummary and the audit line all reported nothing. The one
// user who needed telling was the one who posted the direction.
test('a stopped run still reports the directions nobody read', { timeout: 120000 }, async () => {
  const dir = gitDir('dir-stop');
  let orchRef = null;
  const orch = createOrchestrator({
    projectDir: dir, workflowId: 'wf_default', prompt: 'deck', auto: true, claude: { mock: true },
  });
  orchRef = orch;
  orch.on('log', (e) => {
    if (orchRef && !orchRef.__stopped && /implement/i.test(String(e?.text || ''))) {
      orchRef.__stopped = true;
      appendDirection(orchRef.pipeline.dir, { text: 'cut the roadmap slide', source: 'ui' })
        .then(() => orchRef.stop());
    }
  });
  const res = await orch.run();
  assert.ok(['stopped', 'done'].includes(res.status), JSON.stringify(res));
  const st = orch.getState();
  assert.ok(st.directions, 'a terminal run always summarises its inbox');
  assert.ok(Array.isArray(st.directions.pending));
});
