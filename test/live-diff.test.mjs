// test/live-diff.test.mjs — the in-flight diff behind GET /api/runs/:id/live-diff
// (run-harness.mjs#liveDiff + git-info untrackedFiles/untrackedPatch).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { untrackedFiles, untrackedPatch } from '../src/core/git-info.mjs';
import { RunHarness } from '../src/core/run-harness.mjs';

let repo;
let base;
const git = (args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });

before(async () => {
  repo = await mkdtemp(join(tmpdir(), 'worca-cc-livediff-'));
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']); git(['config', 'user.name', 't']);
  await writeFile(join(repo, 'keep.txt'), 'one\n');
  await writeFile(join(repo, '.gitignore'), 'ignored.log\n');
  git(['add', '-A']); git(['commit', '-qm', 'base']);
  base = git(['rev-parse', 'HEAD']).stdout.trim();
  // An agent at work: one edit, two created files nobody staged, one ignored file,
  // and one file under an injected (excluded) mount.
  await writeFile(join(repo, 'keep.txt'), 'one\ntwo\n');
  await writeFile(join(repo, 'fresh.js'), 'a\nb\nc\n');
  await mkdir(join(repo, 'src'));
  await writeFile(join(repo, 'src', 'deep.js'), 'x\n');
  await writeFile(join(repo, 'ignored.log'), 'noise\n');
  await mkdir(join(repo, '.claude', 'rules', 'worca'), { recursive: true });
  await writeFile(join(repo, '.claude', 'rules', 'worca', 'm.md'), 'memory\n');
});

after(async () => { await rm(repo, { recursive: true, force: true }); });

function fakeHarness({ isWorkspace = false, dirs = { p: repo } } = {}) {
  const h = Object.create(RunHarness.prototype);
  h.workDirs = new Map(Object.entries(dirs));
  h.checkpointRefs = Object.fromEntries(Object.keys(dirs).map((k) => [k, base]));
  h.isWorkspace = isWorkspace;
  h.injectedPaths = Object.fromEntries(Object.keys(dirs).map((k) => [k, [{ path: '.claude/rules/worca', kind: 'memory' }]]));
  return h;
}

test('untrackedFiles lists created files, honouring .gitignore and exclusions', async () => {
  const all = await untrackedFiles(repo);
  assert.deepEqual([...all].sort(), ['.claude/rules/worca/m.md', 'fresh.js', 'src/deep.js']);
  const ex = await untrackedFiles(repo, [':(exclude).claude/rules/worca']);
  assert.deepEqual([...ex].sort(), ['fresh.js', 'src/deep.js']);
});

test('untrackedPatch builds a creation patch with the pinned header shape', async () => {
  const u = await untrackedPatch(repo, 'fresh.js');
  assert.equal(u.added, 3);
  assert.equal(u.binary, false);
  assert.match(u.patch, /^diff --git a\/fresh\.js b\/fresh\.js$/m);
  assert.match(u.patch, /^\+\+\+ b\/fresh\.js$/m);
});

test('liveDiff merges tracked edits with unstaged new files and never touches the index', async () => {
  const out = await fakeHarness().liveDiff();
  const r = out.results;
  assert.equal(r.summary.filesNew, 2);
  assert.equal(r.summary.filesChanged, 1);
  assert.equal(r.summary.linesAdded, 1 + 3 + 1);
  assert.deepEqual(r.newFiles.map((f) => f.path), ['fresh.js', 'src/deep.js']);
  assert.equal(r.changedFiles[0].path, 'keep.txt');
  assert.match(out.patch, /\+two/);
  assert.match(out.patch, /b\/src\/deep\.js/);
  assert.doesNotMatch(out.patch, /worca\/m\.md/);
  assert.equal(out.untrackedCapped, false);
  // read-only: nothing was staged
  assert.equal(git(['diff', '--cached', '--name-only']).stdout.trim(), '');
});

test('liveDiff caps the untracked list and says so', async () => {
  const out = await fakeHarness().liveDiff({ maxUntracked: 1 });
  assert.equal(out.results.summary.filesNew, 1);
  assert.equal(out.untrackedCapped, true);
});

test('liveDiff returns null before setup and a per-project shape for a workspace', async () => {
  const empty = Object.create(RunHarness.prototype);
  empty.workDirs = new Map();
  empty.checkpointRefs = {};
  assert.equal(await empty.liveDiff(), null);
  const ws = await fakeHarness({ isWorkspace: true, dirs: { a: repo } }).liveDiff();
  assert.ok(ws.results.perProject.a);
  assert.equal(ws.results.summary.filesNew, 2);
  assert.match(ws.patch, /^# a\n/);
});
