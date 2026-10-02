// test/artifacts-checkout.test.mjs
// Issue #529: a finished run's checkout (branch.checkout marker + a live worktreeDir)
// is protected by the sweep, surfaced in History, refused by archive — and is never
// mistaken for commit-failed retained work.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTempHome } from './helpers/temp-home.mjs';
import { seedPipeline, seedPipelineRow } from './helpers/db-seed.mjs';
import { getDb } from '../src/core/db.mjs';
import {
  checkoutRecordsFor, retainedWorkFor, runRootSweepLookups, listPipelines,
} from '../src/core/artifacts.mjs';
import { archivePipeline } from '../src/core/pipeline-delete.mjs';
import { RETAIN_REASONS, writeRunManifest } from '../src/core/run-manifest.mjs';
import { worcaHome } from '../src/core/projects.mjs';

useTempHome(after);

const scratch = [];
after(() => Promise.all(scratch.map((d) => rm(d, { recursive: true, force: true }))));

async function liveDir() {
  const d = await mkdtemp(join(tmpdir(), 'worca-cc-checkout-'));
  scratch.push(d);
  return d;
}

const PROJECT = '/tmp/proj-checkout';

async function seedCheckedOut(policy = 'on-success') {
  const worktreeDir = await liveDir();
  const branch = {
    source: 'main', feature: 'worca/feature-x', worktreeDir, worktreeRemoved: false,
    checkout: { at: '2026-09-30T10:00:00.000Z', policy },
  };
  const { id } = await seedPipeline(PROJECT, { status: 'done', branch });
  const row = getDb().prepare('SELECT * FROM pipelines WHERE id = ?').get(id);
  return { id, row, worktreeDir };
}

test('RETAIN_REASONS carries the checkout reason', () => {
  assert.equal(RETAIN_REASONS.CHECKOUT, 'checkout');
  assert.equal(RETAIN_REASONS.COMMIT_FAILED, 'commit_failed');
});

test('checkoutRecordsFor: a checked-out member with a live worktree', async () => {
  const { row, worktreeDir } = await seedCheckedOut();
  const rec = checkoutRecordsFor(row);
  assert.equal(rec.members.length, 1);
  assert.equal(rec.members[0].worktreeDir, worktreeDir);
  assert.equal(rec.members[0].policy, 'on-success');
  assert.equal(rec.members[0].branch, 'worca/feature-x');
  assert.deepEqual(rec.members[0].setup, { status: 'none' });
  assert.equal(retainedWorkFor(row), null, 'a checkout is not retained work');
});

test('checkoutRecordsFor: null without a marker, a live dir, or a row', async () => {
  assert.equal(checkoutRecordsFor(null), null);
  const dir = await liveDir();
  assert.equal(checkoutRecordsFor({ branch: JSON.stringify({ feature: 'f', worktreeDir: dir }) }), null);
  assert.equal(checkoutRecordsFor({
    branch: { feature: 'f', worktreeDir: join(dir, 'gone'), checkout: { at: 'x' } },
  }), null);
  const rec = checkoutRecordsFor({ branch: { feature: 'f', worktreeDir: dir, checkout: {} } });
  assert.equal(rec.members[0].policy, 'on-demand', 'policy defaults to on-demand');
});

test('checkoutRecordsFor: workspace members come from workspace_meta.branches', async () => {
  const a = await liveDir();
  const rec = checkoutRecordsFor({
    target: 'workspace',
    workspace_meta: JSON.stringify({ branches: {
      'api-1': { feature: 'f', worktreeDir: a, checkout: { at: 't', policy: 'until-pr' } },
      'web-2': { feature: 'f', worktreeDir: a },
    } }),
  });
  assert.equal(rec.members.length, 1);
  assert.equal(rec.members[0].projectKey, 'api-1');
  assert.equal(rec.members[0].policy, 'until-pr');
});

test('runRootSweepLookups().retainOf keeps a checked-out run', async () => {
  const { id } = await seedCheckedOut();
  assert.ok(runRootSweepLookups().retainOf(id));
});

test('History entry carries the checkout record', async () => {
  const { id } = await seedCheckedOut();
  const entries = await listPipelines(PROJECT, { lite: true });
  const e = entries.find((x) => x.id === id);
  assert.equal(e.checkout.members[0].policy, 'on-success');
  assert.equal(e.retainedWork, null);
});

test('archive refuses a checked-out run (DB marker)', async () => {
  const { id } = await seedCheckedOut();
  await assert.rejects(
    archivePipeline({ projectDir: PROJECT, id }),
    (e) => e.code === 'RETAINED_WORKTREE' && /checked out/.test(e.message),
  );
});

test('archive refuses with checkout wording when only the manifest retains for checkout', async () => {
  const id = 'chkman01';
  seedPipelineRow({ id, projectKey: 'proj-00000001', status: 'done',
    branch: { source: 'main', feature: 'worca/y' } });
  const runRoot = join(worcaHome(), 'runs', id);
  const wt = join(runRoot, 'repos', 'proj-00000001');
  await mkdir(wt, { recursive: true });
  await writeRunManifest(runRoot, {
    pipelineId: id,
    retain: { reason: RETAIN_REASONS.CHECKOUT, members: [{ projectKey: 'proj-00000001', worktreeDir: wt }] },
  });
  await assert.rejects(
    archivePipeline({ key: 'proj-00000001', id }),
    (e) => e.code === 'RETAINED_WORKTREE' && /checked out/.test(e.message),
  );
});
