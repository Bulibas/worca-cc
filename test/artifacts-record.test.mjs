// test/artifacts-record.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempHome } from './helpers/temp-home.mjs';
import { seedPipeline } from './helpers/db-seed.mjs';
import { recordArtifact } from '../src/core/artifacts.mjs';
import { getDb } from '../src/core/db.mjs';

useTempHome(after);

test('recordArtifact stamps attribution on the first insert', async () => {
  const { id } = await seedPipeline(process.cwd(), { title: 'A', status: 'done' });
  recordArtifact(id, 'plan', 'plans/plan.md', { stepKey: 'exec-1', nodeId: 'planner', cycle: 0 });
  const row = getDb().prepare(
    'SELECT step_key, node_id, cycle, created_at FROM artifacts WHERE pipeline_id=? AND kind=? AND rel_path=?',
  ).get(id, 'plan', 'plans/plan.md');
  assert.equal(row.step_key, 'exec-1');
  assert.equal(row.node_id, 'planner');
  assert.equal(row.cycle, 0);
  assert.ok(row.created_at, 'created_at is stamped');
});

// One row per FILE, attributed to whoever LAST wrote it. A fix loop rewrites the
// same paths every cycle — deck-manifest.md, deck/deck.html, and shots/sNN.png,
// which the audit deletes and recreates — so first-write-wins left a three-cycle
// run claiming its rebuilt deliverables came from cycle 1, which for the reshot
// screenshots was not merely stale but false. created_at stays first-seen,
// because listRunArtifacts orders by it.
test('recordArtifact re-attributes a rewritten file to the latest writer', async () => {
  const { id } = await seedPipeline(process.cwd(), { title: 'B', status: 'done' });
  recordArtifact(id, 'plan', 'plans/plan.md', { stepKey: 'exec-1', nodeId: 'planner', cycle: 0 });
  const first = getDb().prepare('SELECT created_at FROM artifacts WHERE pipeline_id=? AND rel_path=?')
    .get(id, 'plans/plan.md').created_at;
  recordArtifact(id, 'plan', 'plans/plan.md', { stepKey: 'exec-2', nodeId: 'refiner', cycle: 1 });

  const rows = getDb().prepare('SELECT step_key, node_id, cycle, created_at FROM artifacts WHERE pipeline_id=? AND kind=? AND rel_path=?')
    .all(id, 'plan', 'plans/plan.md');
  assert.equal(rows.length, 1, 'still one row per file — the path is the identity');
  assert.equal(rows[0].step_key, 'exec-2');
  assert.equal(rows[0].node_id, 'refiner');
  assert.equal(rows[0].cycle, 1);
  assert.equal(rows[0].created_at, first, 'created_at is first-seen and never moves');
});

test('recordArtifact without attribution never erases the attribution already there', async () => {
  const { id } = await seedPipeline(process.cwd(), { title: 'B2', status: 'done' });
  recordArtifact(id, 'plan', 'plans/plan.md', { stepKey: 'exec-1', nodeId: 'planner', cycle: 0 });
  recordArtifact(id, 'plan', 'plans/plan.md');                       // a 2-arg legacy call
  const row = getDb().prepare('SELECT step_key, node_id, cycle FROM artifacts WHERE pipeline_id=? AND kind=? AND rel_path=?')
    .get(id, 'plan', 'plans/plan.md');
  assert.equal(row.step_key, 'exec-1');
  assert.equal(row.node_id, 'planner');
  assert.equal(row.cycle, 0);
});

test('recordArtifact 3-arg form still works (NULL attribution)', async () => {
  const { id } = await seedPipeline(process.cwd(), { title: 'C', status: 'done' });
  recordArtifact(id, 'prompt', 'prompt.md');
  const row = getDb().prepare('SELECT step_key, node_id, cycle FROM artifacts WHERE pipeline_id=? AND kind=? AND rel_path=?')
    .get(id, 'prompt', 'prompt.md');
  assert.equal(row.step_key, null);
  assert.equal(row.node_id, null);
  assert.equal(row.cycle, null);
});
