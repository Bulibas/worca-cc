// test/git-lock.test.mjs
// clearStaleIndexLock: a git killed while holding the index lock (SIGKILL skips git's own
// cleanup) leaves index.lock behind, and every later add/commit in that checkout fails with
// "File exists". The helper removes the lock only when it is old enough that no live git
// can still own it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearStaleIndexLock, STALE_INDEX_LOCK_MS } from '../src/core/git-lock.mjs';

const held = (path) => `fatal: Unable to create '${path}': File exists.\n\nAnother git process seems to be running in this repository`;

async function lockAged(ageMs) {
  const dir = await mkdtemp(join(tmpdir(), 'worca-cc-git-lock-'));
  const path = join(dir, 'index.lock');
  await writeFile(path, '');
  const t = (Date.now() - ageMs) / 1000;
  await utimes(path, t, t);
  return path;
}

test('removes an index.lock older than the stale threshold', async () => {
  const path = await lockAged(STALE_INDEX_LOCK_MS + 60_000);
  const cleared = await clearStaleIndexLock(held(path));
  assert.equal(cleared.path, path);
  assert.ok(cleared.ageMs >= STALE_INDEX_LOCK_MS);
  assert.equal(existsSync(path), false);
});

test('keeps a fresh index.lock: a live git may still own it', async () => {
  const path = await lockAged(5_000);
  assert.equal(await clearStaleIndexLock(held(path)), null);
  assert.equal(existsSync(path), true);
});

test('a lock that vanished since the failure reports cleared, so the caller retries', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'worca-cc-git-lock-')), 'index.lock');
  assert.deepEqual(await clearStaleIndexLock(held(path)), { path, ageMs: null });
});

test('ignores other failures and other lock files', async () => {
  assert.equal(await clearStaleIndexLock('fatal: pathspec did not match'), null);
  assert.equal(await clearStaleIndexLock(''), null);
  const other = join(await mkdtemp(join(tmpdir(), 'worca-cc-git-lock-')), 'HEAD.lock');
  await writeFile(other, '');
  await utimes(other, 0, 0);
  assert.equal(await clearStaleIndexLock(held(other)), null);
  assert.equal(existsSync(other), true);
});
