// test/stop-paused-core.test.mjs — stopPausedRun, the one action behind every surface:
// refusals touch nothing (interrupted stays resumable), the happy path settles a seeded
// paused row, beforeStop runs synchronously before the claim and can veto it, and two
// concurrent stops of one run cannot both succeed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempHome } from './helpers/temp-home.mjs';
import { gitDir } from './helpers/git-dir.mjs';
import { getDb } from '../src/core/db.mjs';
import { seedPipeline } from './helpers/db-seed.mjs';
import { graphResumePoint } from './helpers/graph-templates.mjs';
import { stopPausedRun, StopPausedError } from '../src/core/stop-paused.mjs';

useTempHome(after);
const dir = gitDir('stop-paused-core');
const projectDirFor = () => dir;
// mock: a mock run records no team metrics (no sink discovery) — hermetic and fast.
const opts = (over = {}) => ({ projectDirFor, claude: { mock: true }, ...over });
const rowOf = (id) => getDb().prepare('SELECT status, resume_point FROM pipelines WHERE id = ?').get(id);

/** A paused row with a v2 resume point and no worktree (nothing to tear down). */
async function pausedRow(status = 'paused') {
  // The pipeline dir createPipeline made, under the temp home useTempHome removes.
  const { id, dir: pipelineDir } = await seedPipeline(dir, { title: 'parked', status });
  getDb().prepare('UPDATE pipelines SET resume_point = ? WHERE id = ?').run(JSON.stringify(graphResumePoint({ pipelineDir })), id);
  return id;
}
const refused = (code, status) => (e) => e instanceof StopPausedError && e.code === code && e.status === status;

test('refusals carry a code + HTTP status and touch nothing', async () => {
  await assert.rejects(stopPausedRun('', opts()), refused('BAD_REQUEST', 400));
  await assert.rejects(stopPausedRun('nope0000', opts()), refused('NOT_FOUND', 404));
  const interrupted = await pausedRow('interrupted');
  await assert.rejects(stopPausedRun(interrupted, opts()), refused('INTERRUPTED', 409));
  assert.equal(rowOf(interrupted).status, 'interrupted');
  assert.ok(rowOf(interrupted).resume_point, 'an interrupted run stays resumable');
  const running = await pausedRow('running');
  await assert.rejects(stopPausedRun(running, opts()), refused('NOT_PAUSED', 409));
  const archived = await pausedRow();
  getDb().prepare('UPDATE pipelines SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), archived);
  await assert.rejects(stopPausedRun(archived, opts()), refused('ARCHIVED', 409));
  const pointless = await pausedRow();
  getDb().prepare('UPDATE pipelines SET resume_point = NULL WHERE id = ?').run(pointless);
  await assert.rejects(stopPausedRun(pointless, opts()), refused('NO_RESUME_POINT', 409));
  const orphan = await pausedRow();
  await assert.rejects(stopPausedRun(orphan, opts({ projectDirFor: () => null })), refused('NO_PROJECT', 400));
  assert.equal(rowOf(orphan).status, 'paused', 'a refused stop leaves the run paused');
});

test('a paused run is stopped: ok, row stopped, resume point gone', async () => {
  const id = await pausedRow();
  const out = await stopPausedRun(id, opts({ by: 'ada' }));
  assert.deepEqual(out, { ok: true, pipelineId: id, status: 'stopped' });
  assert.deepEqual({ ...rowOf(id) }, { status: 'stopped', resume_point: null });
});

test('beforeStop runs synchronously before the claim and can veto the stop', async () => {
  const id = await pausedRow();
  let seen = null;
  await assert.rejects(stopPausedRun(id, opts({
    beforeStop: (orch) => { seen = { status: rowOf(id).status, hasStop: typeof orch.stopPaused }; throw new StopPausedError('LIVE', 'pipeline is live'); },
  })), refused('LIVE', 409));
  assert.deepEqual(seen, { status: 'paused', hasStop: 'function' }, 'called with the orchestrator, before the claim');
  assert.equal(rowOf(id).status, 'paused', 'a veto touches nothing');
});

test('two concurrent stops of one run: exactly one wins, the other is NOT_PAUSED', async () => {
  const id = await pausedRow();
  const [a, b] = await Promise.allSettled([stopPausedRun(id, opts()), stopPausedRun(id, opts())]);
  const won = [a, b].filter((x) => x.status === 'fulfilled');
  const lost = [a, b].filter((x) => x.status === 'rejected');
  assert.equal(won.length, 1, 'exactly one stop wins');
  assert.equal(lost.length, 1);
  assert.equal(lost[0].reason.code, 'NOT_PAUSED');
  assert.equal(rowOf(id).status, 'stopped');
});

test('nothing is awaited between beforeStop and the claim', async () => {
  const id = await pausedRow();
  const { claimPausedForStop } = await import('../src/core/artifacts.mjs');
  let rival = null;
  const out = await stopPausedRun(id, opts({ beforeStop: () => { queueMicrotask(() => { rival = claimPausedForStop(id); }); } }));
  assert.equal(out.status, 'stopped');
  assert.equal(rival, false, 'the claim ran in the same synchronous turn as beforeStop');
});
