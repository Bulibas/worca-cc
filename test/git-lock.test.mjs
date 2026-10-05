// test/git-lock.test.mjs
// clearStaleIndexLock: a git killed while holding the index lock (SIGKILL skips git's own
// cleanup) leaves index.lock behind, and every later add/commit in that checkout fails with
// "File exists". The helper removes the lock only when it is old enough that no live git
// can still own it. Run teardown is the real case, so the linked-worktree gitdir is covered.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, utimes, realpath, rm } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearStaleIndexLock, staleIndexLockNote, STALE_INDEX_LOCK_MS } from '../src/core/git-lock.mjs';
import { snapshotWorktreePatch } from '../src/core/worktree.mjs';
import { checkRows } from './helpers/rows.mjs';
import { templateRepo } from './helpers/git-dir.mjs';

const created = [];
after(async () => { for (const d of created) await rm(d, { recursive: true, force: true }); });

async function tmp() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'worca-cc-git-lock-')));
  created.push(dir);
  return dir;
}

const g = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

function freshRepo() {
  const dir = realpathSync(templateRepo('git-lock', { branch: 'main', user: true, files: { 'seed.txt': 'seed\n' } }));
  created.push(dir);
  return dir;
}

/** A linked worktree, whose lock lives at <repo>/.git/worktrees/<name>/index.lock. */
async function linkedWorktree() {
  const repo = await freshRepo();
  const wt = join(await tmp(), 'wt');
  g(repo, ['worktree', 'add', '-q', '-b', 'feature', wt]);
  return { repo, wt, lock: join(repo, '.git', 'worktrees', 'wt', 'index.lock') };
}

async function plantLock(path, ageMs) {
  await writeFile(path, '');
  const t = (Date.now() - ageMs) / 1000;
  await utimes(path, t, t);
}

// One repo: nothing to clear before any lock exists, then a fresh lock is planted
// and must survive.
test('nothing to clear: no lock, a fresh lock (kept), not a git checkout', async () => {
  const repo = await freshRepo();
  await checkRows([
    { name: 'no lock, or not a git checkout: nothing to clear', run: async () => {
      assert.equal(await clearStaleIndexLock(repo), null);
      assert.equal(await clearStaleIndexLock(await tmp()), null);
    } },
    { name: 'keeps a fresh index.lock: a live git may still own it', run: async () => {
      const lock = join(repo, '.git', 'index.lock');
      await plantLock(lock, 5_000);
      assert.equal(await clearStaleIndexLock(repo), null);
      assert.equal(existsSync(lock), true);
    } },
  ]);
});

// One linked worktree: snapshot with no lock, then plant a stale lock and snapshot
// again to a second path.
test('snapshotWorktreePatch: no clearedLock without a lock; past a stale lock it saves the work and reports the removal', async () => {
  const { wt, lock } = await linkedWorktree();
  await writeFile(join(wt, 'feature.mjs'), 'export {};\n');
  await checkRows([
    { name: 'snapshotWorktreePatch reports no clearedLock when there was no lock', run: async () => {
      const res = await snapshotWorktreePatch(wt, join(await tmp(), 'retained.patch'));
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal('clearedLock' in res, false);
    } },
    { name: 'snapshotWorktreePatch saves the work past a stale lock (retained-run discard/delete)', run: async () => {
      await plantLock(lock, STALE_INDEX_LOCK_MS + 60_000);
      const out = join(await tmp(), 'retained.patch');
      const res = await snapshotWorktreePatch(wt, out);
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.file, out);
      assert.equal(existsSync(lock), false);
      // the caller turns this into a run warning / audit line, so the removal leaves a trace
      assert.equal(res.clearedLock?.path, lock);
      assert.ok(res.clearedLock.ageMs >= STALE_INDEX_LOCK_MS);
      assert.match(staleIndexLockNote(res.clearedLock), /removed a stale git index lock \(\d+ min old/);
    } },
  ]);
});
