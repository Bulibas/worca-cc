// test/stop-paused-claim.test.mjs — the store half of "stop a paused run": the claim is
// one atomic UPDATE that only a PAUSED, non-archived row passes (an interrupted run keeps
// its resume point: it stays resumable), its twin claims a parked row for a resume unless it
// settled meanwhile, and the resume loader carries the full saved state the stop writes back.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempHome } from './helpers/temp-home.mjs';
import { getDb } from '../src/core/db.mjs';
import { seedPipelineRow } from './helpers/db-seed.mjs';
import { claimPausedForStop, claimForResume, readPipelineForResume } from '../src/core/artifacts.mjs';

useTempHome(after);

const rowOf = (id) => ({ ...getDb().prepare('SELECT status, resume_point FROM pipelines WHERE id = ?').get(id) });
function seed(id, status, { archived = false } = {}) {
  seedPipelineRow({ id, status, title: id });
  getDb().prepare('UPDATE pipelines SET resume_point = ? WHERE id = ?').run(JSON.stringify({ version: 2 }), id);
  if (archived) getDb().prepare('UPDATE pipelines SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

test('a paused row is claimed once: stopped, resume point gone; a second claim loses', () => {
  seed('aaa00001', 'paused');
  assert.equal(claimPausedForStop('aaa00001'), true);
  assert.deepEqual(rowOf('aaa00001'), { status: 'stopped', resume_point: null });
  assert.equal(claimPausedForStop('aaa00001'), false, 'the racing second stop loses');
});

test('anything but paused is refused untouched: interrupted keeps its resume point', () => {
  for (const [id, status] of [['aaa00002', 'interrupted'], ['aaa00003', 'running'], ['aaa00004', 'pausing'], ['aaa00005', 'done']]) {
    seed(id, status);
    assert.equal(claimPausedForStop(id), false, status);
    assert.equal(rowOf(id).status, status, `${status}: status kept`);
    assert.ok(rowOf(id).resume_point, `${status}: resume point kept`);
  }
  assert.equal(claimPausedForStop('nope0000'), false, 'unknown id');
  assert.equal(claimPausedForStop(''), false, 'no id');
});

test('an archived paused row is refused', () => {
  seed('aaa00006', 'paused', { archived: true });
  assert.equal(claimPausedForStop('aaa00006'), false);
  assert.equal(rowOf('aaa00006').status, 'paused');
});

test('a resume claims a parked row once; a row a stop claimed first is refused untouched', () => {
  seed('aaa00008', 'paused');
  assert.equal(claimForResume('aaa00008'), true);
  assert.equal(rowOf('aaa00008').status, 'running');
  assert.equal(claimPausedForStop('aaa00008'), false, 'the stop that comes second loses');
  seed('aaa00009', 'interrupted');
  assert.equal(claimForResume('aaa00009'), true, 'an interrupted run is resumable');
  for (const [id, status] of [['aaa00010', 'stopped'], ['aaa00011', 'done'], ['aaa00012', 'error']]) {
    seed(id, status);
    assert.equal(claimForResume(id), false, status);
    assert.equal(rowOf(id).status, status, `${status}: status kept`);
  }
  seed('aaa00013', 'paused');
  assert.equal(claimPausedForStop('aaa00013'), true);
  assert.equal(claimForResume('aaa00013'), false, 'the resume that comes second loses');
  assert.deepEqual(rowOf('aaa00013'), { status: 'stopped', resume_point: null });
  assert.equal(claimForResume('nope0000'), true, 'no row: the caller\'s snapshot is all there is');
});

test('readPipelineForResume carries the saved state snapshot (the stop writes it back)', () => {
  seedPipelineRow({ id: 'aaa00007', status: 'paused', totalCostUsd: 1.25, totalActiveMs: 4200, phase: 'implement', cycle: 2 });
  const saved = readPipelineForResume('aaa00007');
  assert.equal(saved.state.totalCostUsd, 1.25);
  assert.equal(saved.state.totalActiveMs, 4200);
  assert.equal(saved.state.phase, 'implement');
  assert.equal(saved.state.cycle, 2);
  assert.ok(Array.isArray(saved.steps), 'the existing shape is unchanged');
});
