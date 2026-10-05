// test/store-canonical-root-cache.test.mjs — canonicalProjectRoot() memo (suite reduction Task 8e).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalProjectRoot, _resetCanonicalRootCache } from '../src/core/store.mjs';

const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
const tmp = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'worca-cc-croot-'))); made.push(d); return d; };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const withPath = (p, fn) => { const old = process.env.PATH; process.env.PATH = p; try { return fn(); } finally { process.env.PATH = old; } };

test('a repeat call is answered from the cache (with no git on PATH it still names the repo)', () => {
  _resetCanonicalRootCache();
  const repo = tmp(); git(repo, 'init', '-q');
  const svc = join(repo, 'svc'); mkdirSync(svc);
  assert.equal(canonicalProjectRoot(svc), repo);
  assert.equal(withPath('', () => canonicalProjectRoot(svc)), repo, 'a live call without git would answer svc itself');
});

test('a nested git init, and its removal, re-resolve', () => {
  _resetCanonicalRootCache();
  const repo = tmp(); git(repo, 'init', '-q');
  const svc = join(repo, 'svc'); mkdirSync(svc);
  assert.equal(canonicalProjectRoot(svc), repo);
  git(svc, 'init', '-q');
  assert.equal(canonicalProjectRoot(svc), svc);
  rmSync(join(svc, '.git'), { recursive: true, force: true });
  assert.equal(canonicalProjectRoot(svc), repo);
});

test('an empty .git dir is no repo (git skips it) until git init fills it in place', () => {
  _resetCanonicalRootCache();
  const repo = tmp(); git(repo, 'init', '-q');
  const svc = join(repo, 'svc'); mkdirSync(join(svc, '.git'), { recursive: true });
  assert.equal(canonicalProjectRoot(svc), repo);
  git(svc, 'init', '-q');
  assert.equal(canonicalProjectRoot(svc), svc);
});

test('the non-git fallback is never cached: a later git init on the parent wins', () => {
  _resetCanonicalRootCache();
  const parent = tmp(); const pkg = join(parent, 'pkg'); mkdirSync(pkg);
  assert.equal(canonicalProjectRoot(pkg), pkg);
  git(parent, 'init', '-q');
  assert.equal(canonicalProjectRoot(pkg), parent);
});

test('a removed worktree stops resolving to its main repo', () => {
  _resetCanonicalRootCache();
  const repo = tmp(); git(repo, 'init', '-q');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init');
  const wt = join(tmp(), 'wt');
  git(repo, 'worktree', 'add', '-q', '--detach', wt);
  assert.equal(canonicalProjectRoot(wt), repo);
  git(repo, 'worktree', 'remove', '--force', wt);
  mkdirSync(wt);
  assert.equal(canonicalProjectRoot(wt), wt);
});
