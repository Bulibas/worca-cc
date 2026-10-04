// test/terminal-worktrees.test.mjs — worca-owned worktrees for a project branch (#573, D6).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTempHome } from './helpers/temp-home.mjs';
import { openBranchWorktree, removeBranchWorktree, releaseBranchWorktree, enforceBranchWorktreeCap, sweepBranchWorktrees, branchCheckoutName } from '../src/core/terminal/worktrees.mjs';
import { listBranchWorktrees, insertBranchWorktree, deleteBranchWorktree } from '../src/core/terminal/store.mjs';

useTempHome(after);
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'term-wt-')));
after(() => rmSync(repo, { recursive: true, force: true }));
git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
writeFileSync(join(repo, 'a.txt'), 'a\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
git(repo, 'branch', 'feat/x'); git(repo, 'branch', 'feat/y'); git(repo, 'branch', 'Feature/ABC-1.2');
const PK = 'repo-0000aaaa';
const projectDirOf = async () => repo;

test('branchCheckoutName is path-safe and distinct per branch', () => {
  assert.match(branchCheckoutName('feat/x'), /^feat-x-[0-9a-f]{6}$/);
  assert.notEqual(branchCheckoutName('feat/x'), branchCheckoutName('feat-x'));
});

test('a free branch is attached; opening again reuses the folder', async () => {
  const a = await openBranchWorktree({ projectKey: PK, projectDir: repo, branch: 'feat/x', by: 'ada' });
  assert.equal(a.detached, false);
  assert.equal(git(a.dir, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim(), 'feat/x');
  const again = await openBranchWorktree({ projectKey: PK, projectDir: repo, branch: 'feat/x' });
  assert.equal(again.dir, a.dir);
  assert.equal(again.reused, true);
});

test('a branch named with capitals and dots attaches as itself', async () => {
  const w = await openBranchWorktree({ projectKey: PK, projectDir: repo, branch: 'Feature/ABC-1.2' });
  assert.equal(w.detached, false);
  assert.equal(git(w.dir, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim(), 'Feature/ABC-1.2');
  assert.equal(git(repo, 'branch', '--list', 'feature/abc-1-2').stdout.trim(), '', 'no sanitized twin was created');
});

test('the branch held by the person\'s own checkout opens detached, with a warning', async () => {
  const m = await openBranchWorktree({ projectKey: PK, projectDir: repo, branch: 'main' });
  assert.equal(m.detached, true);
  assert.match(m.warning, /detached copy/);
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim(), 'main', 'the person\'s checkout is untouched');
});

test('unknown or unsafe branches are refused', async () => {
  await assert.rejects(openBranchWorktree({ projectKey: PK, projectDir: repo, branch: 'nope' }), { code: 'NO_BRANCH' });
  await assert.rejects(openBranchWorktree({ projectKey: PK, projectDir: repo, branch: '-x' }), { code: 'BAD_BRANCH' });
});

test('keep never releases a clean folder, never a dirty one, never a busy one; the branch stays', async () => {
  const y = await openBranchWorktree({ projectKey: PK, projectDir: repo, branch: 'feat/y' });
  writeFileSync(join(y.dir, 'wip.txt'), 'unsaved\n');
  assert.deepEqual(await releaseBranchWorktree(y.dir, { keep: 'never', busyDirs: new Set(), projectDirOf }), { removed: false, reason: 'dirty' });
  assert.ok(existsSync(join(y.dir, 'wip.txt')));
  assert.deepEqual(await releaseBranchWorktree(y.dir, { keep: 'on-success', busyDirs: new Set(), projectDirOf }), { removed: false });
  rmSync(join(y.dir, 'wip.txt'));
  assert.deepEqual(await releaseBranchWorktree(y.dir, { keep: 'never', busyDirs: new Set([y.dir]), projectDirOf }), { removed: false });
  assert.deepEqual(await releaseBranchWorktree(y.dir, { keep: 'never', busyDirs: new Set(), projectDirOf }), { removed: true });
  assert.equal(existsSync(y.dir), false);
  assert.match(git(repo, 'branch', '--list', 'feat/y').stdout, /feat\/y/, 'the branch is never deleted');
});

test('force removes a dirty folder; the cap evicts the least recently used clean one', async () => {
  const y = await openBranchWorktree({ projectKey: PK, projectDir: repo, branch: 'feat/y' });
  writeFileSync(join(y.dir, 'wip.txt'), 'x\n');
  assert.deepEqual(await removeBranchWorktree(y.dir, { projectDirOf }), { removed: false, reason: 'dirty' });
  assert.deepEqual(await removeBranchWorktree(y.dir, { force: true, projectDirOf }), { removed: true });
  const before = listBranchWorktrees().length;              // feat/x and main remain
  const { evicted } = await enforceBranchWorktreeCap({ max: before - 1, busyDirs: new Set(), projectDirOf });
  assert.equal(evicted.length, 1);
  assert.equal(listBranchWorktrees().length, before - 1);
});

test('a detached copy holding commits no branch reaches is never auto-removed (data loss guard)', async () => {
  const m = await openBranchWorktree({ projectKey: PK, projectDir: repo, branch: 'main' });
  assert.equal(m.detached, true);
  writeFileSync(join(m.dir, 'orphan.txt'), 'only-here\n');
  git(m.dir, 'add', '-A'); git(m.dir, 'commit', '-qm', 'orphan commit');
  // release under `never`: refused, clean-dirty check alone would have let it through
  assert.deepEqual(await releaseBranchWorktree(m.dir, { keep: 'never', busyDirs: new Set(), projectDirOf }), { removed: false, reason: 'unpushed-commits' });
  assert.ok(existsSync(m.dir));
  // the cap tries every entry, including this one, and still leaves it alone
  const { evicted } = await enforceBranchWorktreeCap({ max: 0, busyDirs: new Set(), projectDirOf });
  assert.ok(!evicted.includes(m.dir));
  assert.ok(existsSync(m.dir));
  // the explicit Remove-folder path reports the same reason, and only an explicit force proceeds
  assert.deepEqual(await removeBranchWorktree(m.dir, { projectDirOf }), { removed: false, reason: 'unpushed-commits' });
  assert.deepEqual(await removeBranchWorktree(m.dir, { force: true, projectDirOf }), { removed: true });
  assert.equal(existsSync(m.dir), false);
});

test('closing and quickly reopening a branch terminal never removes the new terminal\'s folder', async () => {
  git(repo, 'branch', 'feat/z');
  const z = await openBranchWorktree({ projectKey: PK, projectDir: repo, branch: 'feat/z' });
  const busy = new Set();
  // The shell exited (nothing busy), then a new terminal opens the same branch while git works.
  const released = releaseBranchWorktree(z.dir, { keep: 'never', busyDirs: () => busy, projectDirOf });
  const again = await openBranchWorktree({ projectKey: PK, projectDir: repo, branch: 'feat/z' });
  busy.add(again.dir);                                       // its shell starts in it
  await released;
  assert.ok(existsSync(again.dir), 'the reopened terminal\'s folder is there');
  assert.equal(git(again.dir, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim(), 'feat/z');
  assert.ok(listBranchWorktrees().some((w) => w.dir === again.dir), 'and still recorded');
});

test('a folder that became busy while the release checked it is kept (busyDirs read again before git)', async () => {
  const z = await openBranchWorktree({ projectKey: PK, projectDir: repo, branch: 'feat/z' });
  let busyNow = false;
  const released = releaseBranchWorktree(z.dir, { keep: 'never', busyDirs: () => new Set(busyNow ? [z.dir] : []), projectDirOf });
  busyNow = true;
  assert.deepEqual(await released, { removed: false, reason: 'in-use' });
  assert.ok(existsSync(z.dir));
});

test('the project\'s own folder is never removed, even if a row ever named it: release, cap, sweep and force all refuse', async () => {
  insertBranchWorktree({ dir: repo, projectKey: PK, branch: 'main', detached: false });
  try {
    assert.deepEqual(await releaseBranchWorktree(repo, { keep: 'never', busyDirs: new Set(), projectDirOf }), { removed: false, reason: 'project-dir' });
    assert.ok(!(await enforceBranchWorktreeCap({ max: 0, busyDirs: new Set(), projectDirOf })).evicted.includes(repo));
    await sweepBranchWorktrees({ keep: 'never', maxCheckouts: 0, busyDirs: new Set(), projectDirOf });
    assert.deepEqual(await removeBranchWorktree(repo, { force: true, projectDirOf }), { removed: false, reason: 'project-dir' });
    assert.ok(existsSync(join(repo, 'a.txt')), 'the checkout and its files are there');
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim(), 'main');
  } finally {
    deleteBranchWorktree(repo);
  }
});
