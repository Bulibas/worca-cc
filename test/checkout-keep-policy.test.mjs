// test/checkout-keep-policy.test.mjs — keep a finished run's checkout by policy (issue #529, D10/D11).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { useTempHome } from './helpers/temp-home.mjs';

// settingsFile() lives under HOME, not WORCA_HOME: repoint both BEFORE any src/core import,
// or this test rewrites the developer's real settings.json (keep policy, cap).
const home = useTempHome(after, 'worca-cc-keep-');
const prevHome = process.env.HOME;
const prevProfile = process.env.USERPROFILE;
process.env.HOME = process.env.USERPROFILE = home;
after(() => {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
});

const { seedPipeline } = await import('./helpers/db-seed.mjs');
const { getDb } = await import('../src/core/db.mjs');
const { worcaHome } = await import('../src/core/projects.mjs');
const { setActionsSettings } = await import('../src/core/settings.mjs');
const { checkoutRecordsFor, findPipelineRowById, persistPrState } = await import('../src/core/artifacts.mjs');
const { keepAfterRun, releaseKeptCheckouts } = await import('../src/core/checkout.mjs');

const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const created = [];
async function freshRepo() {                                       // copy of test/worktree.test.mjs:30-42
  const dir = await mkdtemp(join(tmpdir(), 'worca-cc-keep-repo-'));
  created.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);
  await writeFile(join(dir, 'README.md'), '# hi\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'init']);
  return realpath(dir);
}
after(() => Promise.all(created.map((d) => rm(d, { recursive: true, force: true }))));

async function seedDoneRun(repo, feature, { status = 'done' } = {}) {
  const { id, dir, key } = await seedPipeline(repo, { status,
    branch: { source: 'main', feature, runRootMode: 'detached', worktreeRemoved: true, branchKept: true } });
  const worktreeDir = join(worcaHome(), 'runs', id, 'repos', key);
  getDb().prepare(`UPDATE pipelines SET branch = json_set(branch, '$.worktreeDir', ?) WHERE id = ?`).run(worktreeDir, id);
  return { id, dir, key };
}

test('on-success: a done run keeps a checkout after teardown; an error run does not', async () => {
  await setActionsSettings({ keep: 'on-success' });
  const repo = await freshRepo(); git(repo, ['branch', 'worca-cc/k']);
  const { id } = await seedDoneRun(repo, 'worca-cc/k');
  const r = await keepAfterRun({ pipelineId: id });
  assert.equal(r.members[0].state, 'checked-out');
  assert.equal(checkoutRecordsFor(findPipelineRowById(id)).members[0].policy, 'on-success');
  const { id: bad } = await seedDoneRun(await freshRepo(), 'worca-cc/e', { status: 'error' });
  assert.equal(await keepAfterRun({ pipelineId: bad }), null);
});

test('never (default) is a no-op', async () => {
  await setActionsSettings({ keep: null });
  const { id } = await seedDoneRun(await freshRepo(), 'worca-cc/n');
  assert.equal(await keepAfterRun({ pipelineId: id }), null);
});

test('a kept checkout has setup pending, and nothing runs until the first action (D10, D25)', async () => {
  await setActionsSettings({ keep: 'on-success' });
  const repo = await freshRepo(); git(repo, ['branch', 'worca-cc/p']);
  const { id } = await seedDoneRun(repo, 'worca-cc/p');
  await keepAfterRun({ pipelineId: id });
  assert.equal(checkoutRecordsFor(findPipelineRowById(id)).members[0].setup.status, 'pending');
});

test('until-pr: released when the PR is MERGED or CLOSED, kept while OPEN or absent', async () => {
  await setActionsSettings({ keep: 'until-pr' });
  const ids = {};
  for (const s of ['OPEN', 'MERGED', 'CLOSED', 'NONE']) {
    // Feature branches are always sanitized to lowercase (worktree.mjs sanitizeBranchName).
    const feature = `worca-cc/${s.toLowerCase()}`;
    const repo = await freshRepo(); git(repo, ['branch', feature]);
    const { id } = await seedDoneRun(repo, feature);
    await keepAfterRun({ pipelineId: id });
    if (s !== 'NONE') persistPrState(id, { url: `https://github.com/o/r/pull/${s}`, number: 1, state: 'OPEN' });
    ids[s] = id;
  }
  const states = { [`https://github.com/o/r/pull/MERGED`]: 'MERGED', [`https://github.com/o/r/pull/CLOSED`]: 'CLOSED' };
  const { released } = await releaseKeptCheckouts({ prState: async ({ prUrl }) => states[prUrl] || 'OPEN' });
  assert.deepEqual(released.sort(), [ids.MERGED, ids.CLOSED].sort());
});
