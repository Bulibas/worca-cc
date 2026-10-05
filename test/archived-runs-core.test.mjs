// test/archived-runs-core.test.mjs — the core half of the Archived Runs view:
// listAllPipelines' `archived` opt (the inverse WHERE), restorePipeline (the inverse of
// archivePipeline: same preamble, same guards, `archived_at = NULL`), rowToState's
// archivedAt + the run-dir-gated `resumable`, and the chain gate's D9 interplay
// (an archived predecessor is gone/"was archived"; a restored one is ok again).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAllPipelines, readPipelineByKey } from '../src/core/artifacts.mjs';
import { archivePipeline, restorePipeline } from '../src/core/pipeline-delete.mjs';
import { predecessorState } from '../src/core/scheduler.mjs';
import { projectKey } from '../src/core/store.mjs';
import { _resetForTests, getDb } from '../src/core/db.mjs';
import { seedPipeline } from './helpers/db-seed.mjs';

let home, prevHome, projectDir, key;

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'worca-cc-archived-core-'));
  prevHome = process.env.WORCA_HOME; process.env.WORCA_HOME = home; // store.mjs appends '.worca-cc'
  _resetForTests();                                                 // DB singleton opens under this home
  projectDir = await mkdtemp(join(tmpdir(), 'worca-cc-archived-proj-'));
  key = projectKey(projectDir);
});
after(async () => {
  _resetForTests();
  if (prevHome === undefined) delete process.env.WORCA_HOME; else process.env.WORCA_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

test('listAllPipelines: the default lists active rows only, { archived: true } lists only archived ones', async () => {
  const kept = await seedPipeline(projectDir, { title: 'kept', status: 'done' });
  const gone = await seedPipeline(projectDir, { title: 'archived one', status: 'done' });
  await archivePipeline({ projectDir, id: gone.id });

  const active = await listAllPipelines();
  assert.ok(active.some((r) => r.id === kept.id), 'the active row is listed');
  assert.ok(!active.some((r) => r.id === gone.id), 'the archived row is not');

  const archived = await listAllPipelines({ archived: true, lite: true });
  assert.deepEqual(archived.map((r) => r.id), [gone.id], 'exactly the archived rows, newest first');
  assert.equal(archived[0].archived, true, 'archived rows are flagged for the Runs list');
  assert.ok(archived[0].archivedAt, 'the archive stamp rides along');
});

test('restorePipeline mirrors archivePipeline: null for unknown, idempotent alreadyActive, RUNNING guard', async () => {
  assert.equal(await restorePipeline({ projectDir, id: 'nope' }), null, 'unknown id -> null (the route 404s it)');

  const active = await seedPipeline(projectDir, { title: 'never archived', status: 'done' });
  assert.deepEqual(await restorePipeline({ projectDir, id: active.id }),
    { ok: true, id: active.id, alreadyActive: true, warnings: [] },
    'a finished, never-archived row is already active (idempotent shape)');

  // Defensive mirror of the DELETE guard: an ACTIVE row is refused even if archived_at
  // was stamped (an archived run cannot be live, so this only fires on a corrupt row).
  const stamped = await seedPipeline(projectDir, { title: 'running stamp', status: 'running' });
  getDb().prepare('UPDATE pipelines SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), stamped.id);
  await assert.rejects(
    () => restorePipeline({ projectDir, id: stamped.id }),
    (e) => e.code === 'RUNNING',
  );
});

test('restorePipeline: archive then restore clears archived_at; a second restore is alreadyActive', async () => {
  const { id } = await seedPipeline(projectDir, { title: 'round trip', status: 'done' });
  await archivePipeline({ projectDir, id });
  assert.ok(getDb().prepare('SELECT archived_at FROM pipelines WHERE id = ?').get(id).archived_at,
    'the archive stamped the row first');

  const report = await restorePipeline({ projectDir, id });
  assert.deepEqual(report, { ok: true, id, restored: true, warnings: [] });
  assert.equal(getDb().prepare('SELECT archived_at FROM pipelines WHERE id = ?').get(id).archived_at, null,
    'the stamp is cleared: every archived_at IS NULL read sees the row again');

  assert.deepEqual(await restorePipeline({ projectDir, id }),
    { ok: true, id, alreadyActive: true, warnings: [] }, 'restoring an active row is a no-op');
});

test('readPipelineByKey: archivedAt rides the detail state; resumable dies with the run dir', async () => {
  const { id } = await seedPipeline(projectDir, {
    title: 'paused then archived', status: 'paused', resumePoint: { pauseReason: 'cost_pipeline' },
  });
  await archivePipeline({ projectDir, id });

  const st = (await readPipelineByKey(key, id)).state;
  assert.ok(st.archivedAt, 'the archive stamp reaches the detail payload');
  assert.equal(st.resumable, false, 'an archived run has no run dir to resume from');

  assert.deepEqual(await restorePipeline({ projectDir, id }),
    { ok: true, id, restored: true, wasPaused: true, warnings: [] }, 'the report says it came back unparked');
  const restored = (await readPipelineByKey(key, id)).state;
  assert.equal(restored.archivedAt, null, 'restored: the stamp is cleared');
  assert.equal(restored.resumable, false, 'the run dir was reclaimed: a restored run is not resumable');
  // Left paused it would sit in Needs you forever behind a Resume that can only fail:
  // restore drops the dead resume point and the row comes back interrupted.
  const row = getDb().prepare('SELECT status, resume_point FROM pipelines WHERE id = ?').get(id);
  assert.equal(row.status, 'interrupted', 'a paused row is unparked');
  assert.equal(row.resume_point, null, 'the dead resume point is dropped');

  // The dir-gate is about the FS, not the stamp: a never-archived row whose run dir
  // vanished loses resumable too, and an intact one keeps it.
  const intact = await seedPipeline(projectDir, { title: 'intact', status: 'paused', resumePoint: {} });
  const live = (await readPipelineByKey(key, intact.id)).state;
  assert.equal(live.resumable, true);
  assert.equal(live.archivedAt, null);
  await rm(intact.dir, { recursive: true, force: true });
  const vanished = (await readPipelineByKey(key, intact.id)).state;
  assert.equal(vanished.resumable, false, 'no run dir, no resume — archive or not');
});

test('the chain gate: an archived predecessor is gone ("was archived"), a restored one is ok again', async () => {
  const { id } = await seedPipeline(projectDir, { title: 'chain predecessor', status: 'done' });
  assert.equal(predecessorState({ kind: 'pipeline', id }, { now: Date.now() }).state, 'ok',
    'a plain done row opens the gate');

  await archivePipeline({ projectDir, id });
  const gone = predecessorState({ kind: 'pipeline', id }, { now: Date.now() });
  assert.equal(gone.state, 'gone', 'archive strands its dependents (spec D9)');
  assert.equal(gone.reason, 'was archived');

  await restorePipeline({ projectDir, id });
  assert.equal(predecessorState({ kind: 'pipeline', id }, { now: Date.now() }).state, 'ok',
    'restore un-strands them: the gate is open again');
});
