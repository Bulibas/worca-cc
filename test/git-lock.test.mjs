// test/git-lock.test.mjs
// clearStaleIndexLock: a git killed while holding the index lock (SIGKILL skips git's own
// cleanup) leaves index.lock behind, and every later add/commit in that checkout fails with
// "File exists". The helper removes the lock only when it is old enough that no live git
// can still own it. Run teardown is the real case, so the linked-worktree gitdir is covered.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, utimes, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearStaleIndexLock, STALE_INDEX_LOCK_MS } from '../src/core/git-lock.mjs';
import { snapshotWorktreePatch } from '../src/core/worktree.mjs';

const created = [];
after(async () => { for (const d of created) await rm(d, { recursive: true, force: true }); });

async function tmp() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'worca-cc-git-lock-')));
  created.push(dir);
  return dir;
}

const g = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

async function freshRepo() {
  const dir = await tmp();
  g(dir, ['init', '-q', '-b', 'main']);
  g(dir, ['config', 'user.email', 't@t']);
  g(dir, ['config', 'user.name', 't']);
  await writeFile(join(dir, 'seed.txt'), 'seed\n');
  g(dir, ['add', '-A']);
  g(dir, ['commit', '-qm', 'init']);
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

test('removes a stale index.lock in a linked worktree gitdir', async () => {
  const { wt, lock } = await linkedWorktree();
  await plantLock(lock, STALE_INDEX_LOCK_MS + 60_000);
  const cleared = await clearStaleIndexLock(wt);
  assert.equal(cleared.path, lock);
  assert.ok(cleared.ageMs >= STALE_INDEX_LOCK_MS);
  assert.equal(existsSync(lock), false);
});

test('keeps a fresh index.lock: a live git may still own it', async () => {
  const repo = await freshRepo();
  const lock = join(repo, '.git', 'index.lock');
  await plantLock(lock, 5_000);
  assert.equal(await clearStaleIndexLock(repo), null);
  assert.equal(existsSync(lock), true);
});

test('no lock, or not a git checkout: nothing to clear', async () => {
  assert.equal(await clearStaleIndexLock(await freshRepo()), null);
  assert.equal(await clearStaleIndexLock(await tmp()), null);
});

test('snapshotWorktreePatch saves the work past a stale lock (retained-run discard/delete)', async () => {
  const { wt, lock } = await linkedWorktree();
  await writeFile(join(wt, 'feature.mjs'), 'export {};\n');
  await plantLock(lock, STALE_INDEX_LOCK_MS + 60_000);
  const out = join(await tmp(), 'retained.patch');
  const res = await snapshotWorktreePatch(wt, out);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.file, out);
  assert.equal(existsSync(lock), false);
});
