// test/helpers/engines.mjs
// One test body, one engine (the v1 arm died with the v1 engine). The v1-shaped
// stub-runner ABI ({status, issues, review, summary}) the suites are written in
// is still adapted to the v2 executor ABI ({outputs, verdict, summary}), so the
// suites themselves did not have to be rewritten.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createOrchestrator } from '../../src/core/orchestrator.mjs';
import { BOOKEND_EXECUTION_IDS } from '../../src/shared/graph/constants.mjs';
import { SEED_TEMPLATES } from '../../src/core/graph/seed-templates.mjs';
import { writeGraphWorkflow } from '../../src/core/workflows.mjs';

/** Wrap a v1-shaped stub so the graph executor contract is satisfied: every
 *  declared non-void output gets a real file at its ALLOCATED path (downstream
 *  nodes bind paths, not values) and the verdict rides `verdict`. A stub that
 *  already returns `outputs` is passed through untouched, and a stub that hangs
 *  or rejects still hangs or rejects — the pause/stop suites depend on that. */
export function adaptRunner(fn) {
  return async (ctx) => {
    const r = await fn(ctx);
    if (r && r.outputs) return r;
    const outputs = {};
    for (const p of ctx.ports?.outputs || []) {
      const path = ctx.outputs?.[p.id]?.path ?? null;
      if (path && p.type !== 'void') {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, p.type === 'json' ? '{"ok":true}\n' : `# ${p.id}\n`, 'utf8');
      }
      outputs[p.id] = { path, type: p.type };
    }
    const verdict = r?.review
      ?? (r?.status === 'blocked'
        ? { issues: (r.issues || [{ severity: 'major' }]), summary: r.summary || '' }
        : (ctx.verdict ? { issues: [], summary: '' } : null));
    return { outputs, verdict, summary: r?.summary || '' };
  };
}

/** The ONE engine, still in the shape a suite loops over: the dual-engine
 *  parametrization collapsed with the v1 engine, and keeping the array keeps
 *  every consumer's `for (const engine of ENGINES)` body byte-identical. */
export const ENGINES = [
  {
    id: 'graph',
    workflowId: 'wf_default',
    create: (opts) => createOrchestrator({
      ...opts,
      runners: Object.fromEntries(Object.entries(opts.runners || {}).map(([k, fn]) => [k, adaptRunner(fn)])),
    }),
    /** Spy on the per-execution ctx builder: the graph engine's _execCtx(node, nc, args). */
    spyCtx: (orch, seen) => {
      const orig = orch._execCtx.bind(orch);
      orch._execCtx = (node, nc, args) => { const ctx = orig(node, nc, args); seen.push({ key: nc.key, claudeOpts: ctx.claudeOpts || {} }); return ctx; };
    },
    expectResumePoint: (rp, { sessionId }) => {
      assert.equal(rp.version, 2);
      assert.equal(rp.manifest?.version, 2, 'frozen manifest stored');
      assert.ok(rp.snapshot && Array.isArray(rp.snapshot.execs), 'scheduler snapshot stored');
      assert.ok(rp.nodes.some((n) => n.sessionId === sessionId && !n.completed), 'interrupted execution session recorded');
    },
  },
];

/** One run per key per test process, for tests that only READ its outcome. `start` runs once
 *  (attach every observer, spy and injection inside it) and resolves { orch, state, events? };
 *  state and events come back as deep-frozen clones, so no test can mutate what another reads
 *  (orch itself stays live: read the frozen `state`, never orch.state). A rejected start
 *  fails every test that awaits it, each with the same error. */
export function sharedRun(key, start) {
  const cache = (sharedRun._c ??= new Map());
  if (!cache.has(key)) {
    cache.set(key, Promise.resolve().then(start).then((r) => ({
      ...r,
      state: deepFreeze(structuredClone(r.state ?? r.orch.getState())),
      ...(r.events ? { events: deepFreeze(structuredClone(r.events)) } : {}),
    })));
  }
  return cache.get(key);
}

/** An exec event of the run's own Preflight / Sync / Done ledger rows (x:preflight:1 …). Every
 *  node execution id is ALSO x:<nodeId>:<n>, so match the ids, never the x: prefix. */
export const isBookend = (p) => BOOKEND_EXECUTION_IDS.includes(p.executionId);

/** Run `orch` and stop it the first time `pred(execEvent)` is true. Resolves run()'s result
 *  ({ status: 'stopped', pipelineDir }); throws when the run ended without the predicate ever
 *  matching, so a stop that never happened cannot pass as a full run. */
export async function stopAt(orch, pred) {
  let hit = null;
  const onExec = (p) => {
    if (hit || !pred(p)) return;
    hit = p;
    orch.off('exec', onExec);
    orch.stop();
  };
  orch.on('exec', onExec);
  let res;
  try { res = await orch.run(); } finally { orch.off('exec', onExec); }
  if (!hit) throw new Error(`stopAt: the run ended ${res?.status} before the stop predicate matched`);
  return res;
}

/** pred for stopAt: the n-th node start. Bookends never count (the first exec event is
 *  Preflight's, before any checkout). agentsOnly (default) counts agent dispatches only, so the
 *  Task and End cards do not count either. The n-th execution's ctx is already built when its
 *  start fires (a _execCtx spy sees it), its runner output is not. */
export const afterStarts = (n, { agentsOnly = true, skip = [] } = {}) => {
  let k = 0;
  return (p) => p.status === 'start' && !isBookend(p) && (!agentsOnly || !!p.agentKey)
    && !skip.includes(p.nodeId) && ++k >= n;
};

/** A fresh home holds no seed workflows (fresh installs keep Default only, db.mjs V24 D7): write
 *  wf_quick-fix (task, planner, implementer, reviewer, end) into the CURRENT home before a run
 *  names it. Call it after useTempHome(), once per home. */
export async function seedQuickFix() {
  const t = SEED_TEMPLATES.find((x) => x.id === 'wf_quick-fix');
  await writeGraphWorkflow({ id: t.id, name: t.name, domain: t.domain, nodes: t.nodes, wires: t.wires });
  return t.id;
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}
