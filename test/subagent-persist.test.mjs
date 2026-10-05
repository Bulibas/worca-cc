// test/subagent-persist.test.mjs
// Layer A (DB) — upsertSubAgent / listSubAgents round-trip + idempotency + anti-clobber.
// Seeds the FK-parent pipelines row via the production seedPipeline helper, then drives
// the two new helpers directly: a spawn INSERT, an idempotent status-only UPDATE that
// must NOT null the COALESCE-guarded columns (label/started_at/duration_ms/tokens/
// cost_usd/ui_phase/subagent_type/run_model), the camelCase row->record mapping,
// started_at,id ordering, and the detail read (readPipeline / readPipelineByKey ->
// rowToState -> state.subAgents) that History reconstructs the live view from.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { upsertSubAgent, listSubAgents, readPipeline, readPipelineByKey } from '../src/core/artifacts.mjs';
import { getDb, _resetForTests } from '../src/core/db.mjs';
import { seedPipeline } from './helpers/db-seed.mjs';
import { checkRows } from './helpers/rows.mjs';

const homes = [];
beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'worca-cc-subagent-persist-'));
  homes.push(dir);
  _resetForTests();
  process.env.WORCA_HOME = dir;
});
after(async () => {
  _resetForTests();
  delete process.env.WORCA_HOME;
  await Promise.all(homes.map((d) => rm(d, { recursive: true, force: true })));
});

test('upsertSubAgent inserts a running record; listSubAgents returns the camelCase shape', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'worca-cc-sa-proj-'));
  const { id: pid } = await seedPipeline(proj, { title: 'Run', status: 'running' });

  upsertSubAgent(pid, {
    id: 'toolu_aaa', label: 'investigate auth', nodeId: 's2_0', stepIndex: 2,
    cycle: 1, stepKey: '2:s2_0#1', status: 'running', startedAt: '2026-06-07T00:00:01Z',
  });

  const list = listSubAgents(pid);
  assert.equal(list.length, 1, 'one sub-agent persisted');
  assert.deepEqual(list[0], {
    id: 'toolu_aaa', label: 'investigate auth', nodeId: 's2_0', stepIndex: 2,
    cycle: 1, stepKey: '2:s2_0#1', status: 'running',
    startedAt: '2026-06-07T00:00:01Z', finishedAt: null,
    durationMs: null, tokens: null, costUsd: null, uiPhase: null, skills: [],
    subagentType: null, graphifyCount: null, runModel: null,
  }, 'row maps back to the shared camelCase record shape');
});

test('idempotent upsert: telemetry and status-only finish updates keep one row and never null a COALESCE-guarded column (label, started_at, duration/tokens/cost, uiPhase, subagentType, runModel)', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'worca-cc-sa-proj-'));
  const { id: pid } = await seedPipeline(proj, { title: 'Run', status: 'running' });

  // Spawn carries label + startedAt + uiPhase + subagentType + runModel; a later
  // telemetry upsert fills duration/tokens/cost.
  upsertSubAgent(pid, { id: 'toolu_ccc', label: 'build index', nodeId: 's0_0', stepIndex: 0,
    cycle: 0, stepKey: '0:s0_0', status: 'running', startedAt: '2026-06-07T00:00:03Z',
    uiPhase: 'refine', subagentType: 'general-purpose', runModel: 'sonnet' });
  upsertSubAgent(pid, { id: 'toolu_ccc', durationMs: 4200, tokens: 1500, costUsd: 0.012 });
  // Finish: a further upsert with the SAME id carries ONLY status + finishedAt
  // (no label/started/telemetry/uiPhase/type/model).
  upsertSubAgent(pid, { id: 'toolu_ccc', status: 'finished', finishedAt: '2026-06-07T00:00:12Z' });
  // A second child spawned with no subagentType and no runModel.
  upsertSubAgent(pid, { id: 'toolu_ddd', label: 'AR items', nodeId: 's0_0', stepIndex: 0, cycle: 0,
    status: 'finished', startedAt: '2026-06-07T00:00:04Z' });

  const list = listSubAgents(pid);
  const rec = list.find((r) => r.id === 'toolu_ccc');
  const bare = list.find((r) => r.id === 'toolu_ddd');
  const { state } = await readPipeline(proj, pid);

  await checkRows([
    { name: 'upsertSubAgent is idempotent on (pipeline_id,id) and a status update keeps the row count at 1', run: () => {
      assert.equal(list.filter((r) => r.id === 'toolu_ccc').length, 1, 'the later upserts updated the same row (no duplicate)');
      assert.equal(list.length, 2, 'one row per id');
      assert.equal(rec.status, 'finished', 'status transitioned to finished');
      assert.equal(rec.finishedAt, '2026-06-07T00:00:12Z', 'finishedAt set on the update');
    } },
    { name: 'a status-only update never nulls the COALESCE-guarded columns (label/started_at/telemetry)', run: () => {
      assert.equal(rec.label, 'build index', 'label preserved by COALESCE across the finish update');
      assert.equal(rec.startedAt, '2026-06-07T00:00:03Z', 'started_at preserved (never re-nulled)');
      assert.equal(rec.durationMs, 4200, 'duration_ms preserved across the finish update');
      assert.equal(rec.tokens, 1500, 'tokens preserved');
      assert.equal(rec.costUsd, 0.012, 'cost_usd preserved');
      assert.equal(rec.status, 'finished', 'status still advanced to finished');
      assert.equal(rec.finishedAt, '2026-06-07T00:00:12Z', 'finishedAt set');
    } },
    { name: 'upsertSubAgent rows reconstruct into state.subAgents via readPipeline', run: () => {
      assert.ok(Array.isArray(state.subAgents), 'state.subAgents is reconstructed');
      assert.equal(state.subAgents.length, 2, 'UPSERT, not duplicate-insert');
      const r = state.subAgents.find((x) => x.id === 'toolu_ccc');
      assert.equal(r.id, 'toolu_ccc');
      assert.equal(r.label, 'build index', 'COALESCE keeps the first non-null label');
      assert.equal(r.status, 'finished');
      assert.equal(r.finishedAt, '2026-06-07T00:00:12Z');
      assert.equal(r.nodeId, 's0_0');
      assert.equal(r.stepKey, '0:s0_0');
      assert.equal(r.durationMs, 4200);
      assert.equal(r.tokens, 1500);
      assert.equal(r.costUsd, 0.012);
    } },
    { name: 'a finish UPSERT that omits uiPhase keeps the spawn-time value (COALESCE)', run: () => {
      assert.equal(state.subAgents.find((x) => x.id === 'toolu_ccc').uiPhase, 'refine', 'uiPhase: COALESCE keeps uiPhase across a finish that omits it');
    } },
    { name: 'sub_agents.subagent_type round-trips; absent -> null', run: () => {
      assert.equal(rec.subagentType, 'general-purpose', 'subagentType round-trips');
      assert.equal(bare.subagentType, null, 'subagentType: absent type surfaces as null');
    } },
    { name: 'a status-only update never nulls the COALESCE-guarded subagent_type', run: () => {
      assert.equal(rec.subagentType, 'general-purpose', 'subagentType: type preserved across a type-less finish update');
    } },
    { name: 'a spawned child records the model it ran on, and later updates never null it', run: () => {
      assert.equal(rec.status, 'finished');
      assert.equal(rec.runModel, 'sonnet', 'runModel: the finish update is COALESCE-guarded');
    } },
    { name: 'a child with no recorded model reads back as null (pre-v25 rows paint no pill)', run: () => {
      assert.equal(bare.runModel, null, 'runModel: absent model surfaces as null');
    } },
  ]);
});

test('listSubAgents orders by (started_at, id)', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'worca-cc-sa-proj-'));
  const { id: pid } = await seedPipeline(proj, { title: 'Run', status: 'running' });
  // Insert out of order; same started_at for two rows to exercise the id tiebreak.
  upsertSubAgent(pid, { id: 'toolu_z', status: 'running', startedAt: '2026-06-07T00:00:05Z' });
  upsertSubAgent(pid, { id: 'toolu_a', status: 'running', startedAt: '2026-06-07T00:00:05Z' });
  upsertSubAgent(pid, { id: 'toolu_m', status: 'running', startedAt: '2026-06-07T00:00:01Z' });

  assert.deepEqual(listSubAgents(pid).map((r) => r.id), ['toolu_m', 'toolu_a', 'toolu_z'],
    'earliest started_at first; ties broken by id ascending');
});

test('readPipelineByKey exposes state.subAgents: camelCase records in (started_at,id) order, [] when none', async () => {
  // readPipeline(dir, id) is readPipelineByKey(projectKey(dir), id) — the same path
  // all 3 detail endpoints use: rowToState -> listSubAgents.
  const proj = await mkdtemp(join(tmpdir(), 'worca-cc-sa-rts-proj-'));
  const { id: pid, key } = await seedPipeline(proj, { title: 'Demo', status: 'done',
    startedAt: '2026-06-07T00:00:00Z' });
  const { id: barePid, key: bareKey } = await seedPipeline(proj, { title: 'Bare', status: 'done',
    startedAt: '2026-06-07T00:00:00Z' });

  upsertSubAgent(pid, { id: 'toolu_2', label: 'second', nodeId: 's1_0', stepIndex: 1,
    cycle: 0, stepKey: '1:s1_0', status: 'finished',
    startedAt: '2026-06-07T00:00:05Z', finishedAt: '2026-06-07T00:00:08Z' });
  upsertSubAgent(pid, { id: 'toolu_1', label: 'first', nodeId: 's1_0', stepIndex: 1, uiPhase: 'plan',
    cycle: 0, stepKey: '1:s1_0', status: 'running', startedAt: '2026-06-07T00:00:02Z' });

  await checkRows([
    { name: 'readPipelineByKey returns state.subAgents reconstructed from the sub_agents table', run: async () => {
      const detail = await readPipelineByKey(key, pid);
      assert.ok(detail && detail.state, 'detail resolved');
      assert.ok(Array.isArray(detail.state.subAgents), 'state.subAgents is an array');
      assert.equal(detail.state.subAgents.length, 2, 'both sub-agents reconstructed');
      // Ordered by started_at -> the running 'first' precedes the finished 'second'.
      assert.deepEqual(detail.state.subAgents.map((s) => s.id), ['toolu_1', 'toolu_2'], 'ordered by started_at');
      assert.equal(detail.state.subAgents[0].status, 'running');
      assert.equal(detail.state.subAgents[0].label, 'first');
      assert.equal(detail.state.subAgents[1].status, 'finished');
      assert.equal(detail.state.subAgents[1].finishedAt, '2026-06-07T00:00:08Z');
    } },
    { name: 'upsertSubAgent persists uiPhase; readPipeline reconstructs it', run: async () => {
      const { state } = await readPipeline(proj, pid);
      assert.equal(state.subAgents.length, 2);
      assert.equal(state.subAgents.find((s) => s.id === 'toolu_1').uiPhase, 'plan', 'uiPhase round-trips through the DB');
    } },
    { name: 'state.subAgents is [] for a run with no sub-agents (always present)', run: async () => {
      const detail = await readPipelineByKey(bareKey, barePid);
      assert.deepEqual(detail.state.subAgents, [], 'subAgents present and empty (never undefined)');
    } },
    { name: 'listSubAgents returns [] for a pipeline with no sub-agents', run: () => {
      assert.deepEqual(listSubAgents(barePid), [], 'no rows -> empty array (never null)');
    } },
  ]);
});

test('sub_agents FK cascades on pipeline delete', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'worca-cc-sa-proj-'));
  const { id: pid } = await seedPipeline(proj, { title: 'Run', status: 'running' });
  upsertSubAgent(pid, { id: 'toolu_fk', status: 'running', startedAt: '2026-06-07T00:00:01Z' });
  assert.equal(listSubAgents(pid).length, 1, 'seeded one sub-agent');
  getDb().prepare('DELETE FROM pipelines WHERE id = ?').run(pid);
  assert.equal(listSubAgents(pid).length, 0, 'sub_agents rows cascade-deleted with the pipeline');
});
