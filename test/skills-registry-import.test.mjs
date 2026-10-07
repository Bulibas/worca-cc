// test/skills-registry-import.test.mjs — staging an import (skills registry design §2b-8, §5 import consent, §7):
// a folder, a pasted SKILL.md, one of ~/.claude/skills; the proposed name; limits checked before copying;
// discard; stale stages; the ~/.claude/skills listing; stage → commit.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync, utimesSync, chmodSync, lstatSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { useTempHome } from './helpers/temp-home.mjs';
import { copyFixture, writeSkill, skillMd, POSIX } from './helpers/skills-registry-fixtures.mjs';
import { stageImport, discardStage, listHomeSkills, STAGE_TTL_MS } from '../src/core/skills-registry/import.mjs';
import { commitImport, readSkillLibrary, stagesDir, SkillLibraryError } from '../src/core/skills-registry/library.mjs';

const root = useTempHome(after);
const prevHome = [process.env.HOME, process.env.USERPROFILE];
after(() => {
  for (const [k, v] of [['HOME', prevHome[0]], ['USERPROFILE', prevHome[1]]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});
let src;
beforeEach(() => {
  process.env.WORCA_HOME = mkdtempSync(join(root, 'h-'));
  src = mkdtempSync(join(root, 'src-'));
  process.env.HOME = process.env.USERPROFILE = mkdtempSync(join(root, 'user-'));
});

const meta = (dir) => JSON.parse(readFileSync(`${dir}.json`, 'utf8'));
const stages = () => (existsSync(stagesDir()) ? readdirSync(stagesDir()).sort() : []);
const rejects = (p, status, re) => assert.rejects(p, (e) => e instanceof SkillLibraryError && e.status === status && re.test(e.message));

test('a folder: staged under tmp/skills/<16 hex>, origin recorded, inspected, committed', async () => {
  const from = copyFixture('beta-scripts', src);
  mkdirSync(join(from, '.git'));
  writeFileSync(join(from, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const s = await stageImport({ kind: 'dir', path: from });
  assert.match(s.stage, /^[0-9a-f]{16}$/);
  assert.equal(s.dir, join(process.env.WORCA_HOME, '.worca-cc', 'tmp', 'skills', s.stage));
  assert.deepEqual(Object.keys(s), ['stage', 'dir', 'name', 'inspection']);
  assert.equal(s.name, 'beta-scripts');
  assert.deepEqual([s.inspection.problems, s.inspection.scripts, s.inspection.shellBlocks], [[], ['scripts/run.sh'], 1]);
  assert.equal(existsSync(join(s.dir, '.git')), false, '.git is never staged');
  assert.deepEqual(meta(s.dir), { origin: { kind: 'dir', path: from } });
  const e = await commitImport(s.dir, s.name);
  assert.deepEqual(e.origin, { kind: 'dir', path: from });
  assert.equal(e.hash, s.inspection.hash);
  assert.deepEqual(Object.keys(readSkillLibrary().skills), ['beta-scripts']);
  assert.deepEqual(stages(), []);
});

test('the proposed name: the SKILL.md frontmatter name (folder renamed), else the folder name made valid', async () => {
  const g = await stageImport({ kind: 'dir', path: copyFixture('gamma-bad', src) });
  assert.equal(g.name, 'gamma');
  assert.deepEqual(g.inspection.problems, ['.claude-plugin/: a skill cannot ship a .claude-plugin folder']);
  assert.deepEqual(readdirSync(join(g.dir, '.claude-plugin')), [], 'staged empty: the limits never counted what it holds');
  const odd = writeSkill(join(src, 'My_Odd Skill'), { 'SKILL.md': '---\ndescription: No name here.\n---\nBody.\n' });
  const o = await stageImport({ kind: 'dir', path: odd });
  assert.deepEqual([o.name, o.inspection.problems], ['my-odd-skill', []]);
});

test('folder refusals: relative path, missing, no SKILL.md; too many files is refused before anything is copied', async () => {
  await rejects(stageImport({ kind: 'dir', path: 'skills/alpha' }), 400, /absolute path/);
  await rejects(stageImport({ kind: 'dir', path: join(src, 'nope') }), 404, /folder not found/);
  await rejects(stageImport({ kind: 'dir', path: writeSkill(join(src, 'plain'), { 'README.md': 'x' }) }), 400, /no SKILL.md in/);
  await rejects(stageImport({ kind: 'zip' }), 400, /source.kind must be/);
  await rejects(stageImport(null), 400, /source.kind must be/);
  const big = writeSkill(join(src, 'big'), { 'SKILL.md': skillMd('big') });
  for (let i = 0; i < 310; i++) writeFileSync(join(big, `f${i}.txt`), 'x');
  await assert.rejects(stageImport({ kind: 'dir', path: big }),
    (e) => e.status === 400 && /too large for a skill/.test(e.message) && e.problems.includes('more than 300 files'));
  const farm = writeSkill(join(src, 'farm'), { 'SKILL.md': skillMd('farm') });
  for (let i = 0; i < 1100; i++) mkdirSync(join(farm, `d${i}`));
  await assert.rejects(stageImport({ kind: 'dir', path: farm }),
    (e) => e.status === 400 && /too large for a skill/.test(e.message) && e.problems.join() === 'more than 1000 links and folders');
  assert.deepEqual(stages(), [], 'nothing was staged');
});

test('a pasted SKILL.md: named by its frontmatter, else by the given name', async () => {
  const p = await stageImport({ kind: 'paste', name: 'ignored', content: skillMd('release-notes', 'Drafts release notes.') });
  assert.deepEqual([p.name, p.inspection.description, p.inspection.files.map((f) => f.path)], ['release-notes', 'Drafts release notes.', ['SKILL.md']]);
  assert.deepEqual(meta(p.dir), { origin: null });
  const q = await stageImport({ kind: 'paste', name: 'Quick Note', content: '---\ndescription: Notes.\n---\nWrite.\n' });
  assert.equal(q.name, 'quick-note');
  await rejects(stageImport({ kind: 'paste', name: 'x', content: '  ' }), 400, /SKILL.md text is required/);
  await rejects(stageImport({ kind: 'paste', name: 'x', content: 'x'.repeat(1048577) }), 400, /larger than 1 MB/);
  await rejects(stageImport({ kind: 'paste', name: { toString: 0 }, content: skillMd('x') }), 400, /^paste: the name must be text$/);
  assert.equal((await commitImport(p.dir, 'release-notes')).origin, null, 'a pasted skill has no origin');
});

test('~/.claude/skills: the listing (folders and links to folders with a SKILL.md) and a home import', async () => {
  const skills = join(process.env.HOME, '.claude', 'skills');
  copyFixture('alpha', skills);
  writeSkill(join(skills, 'Bad Name'), { 'SKILL.md': skillMd('bad') });
  writeSkill(join(skills, 'no-md'), { 'README.md': 'x' });
  writeFileSync(join(skills, 'notes.txt'), 'x');
  if (POSIX) symlinkSync(copyFixture('delta-plugin-root', src), join(skills, 'linked'));
  assert.deepEqual(listHomeSkills(), [
    { name: 'alpha', description: 'Writes a short status note for the current branch.' },
    ...(POSIX ? [{ name: 'linked', description: 'Calls a helper that lives elsewhere in its plugin.' }] : []),
  ]);
  const h = await stageImport({ kind: 'home', name: 'alpha' });
  assert.deepEqual([h.name, meta(h.dir)], ['alpha', { origin: { kind: 'home', name: 'alpha' } }]);
  await rejects(stageImport({ kind: 'home', name: '../alpha' }), 400, /not a skill folder name/);
  await rejects(stageImport({ kind: 'home', name: 'gone' }), 404, /no skill named "gone" in ~\/.claude\/skills/);
  process.env.HOME = process.env.USERPROFILE = join(root, 'no-such-home');
  assert.deepEqual(listHomeSkills(), []);
});

test('discardStage removes the stage and its origin; an unknown stage is a no-op; a malformed id is refused', async () => {
  const s = await stageImport({ kind: 'paste', name: 'x', content: skillMd('x') });
  discardStage(s.stage);
  assert.deepEqual(stages(), []);
  discardStage('0123456789abcdef');
  assert.throws(() => discardStage('../../x'), (e) => e instanceof SkillLibraryError && e.status === 400);
  await rejects(commitImport(s.dir, 'x'), 404, /no longer staged/);
});

test('stages left for a day are swept by the next stageImport; fresh ones stay', async () => {
  const old = await stageImport({ kind: 'paste', name: 'old', content: skillMd('old') });
  const fresh = await stageImport({ kind: 'paste', name: 'fresh', content: skillMd('fresh') });
  const t = (Date.now() - STAGE_TTL_MS - 60_000) / 1000;
  utimesSync(old.dir, t, t);
  utimesSync(`${old.dir}.json`, t, t);
  mkdirSync(join(stagesDir(), 'keep-me'));
  utimesSync(join(stagesDir(), 'keep-me'), t, t);
  const next = await stageImport({ kind: 'paste', name: 'next', content: skillMd('next') });
  assert.deepEqual(stages(), [fresh.stage, `${fresh.stage}.json`, 'keep-me', next.stage, `${next.stage}.json`].sort());
});

test('a SKILL.md linked to a FIFO or /dev/zero is staged and listed without being read', { skip: !POSIX }, async () => {
  const fifo = join(src, 'pipe');
  execFileSync('mkfifo', [fifo]);
  const from = writeSkill(join(src, 'piped-skill'), { 'notes.md': 'x\n' });
  symlinkSync(fifo, join(from, 'SKILL.md'));
  const s = await stageImport({ kind: 'dir', path: from }); // the FIFO first: a regression blocks, it never reads /dev/zero
  assert.deepEqual([s.name, s.inspection.problems], ['piped-skill', ['SKILL.md: symlink pointing outside the skill folder', 'SKILL.md is missing']]);
  const skills = join(process.env.HOME, '.claude', 'skills');
  mkdirSync(join(skills, 'zero'), { recursive: true });
  symlinkSync('/dev/zero', join(skills, 'zero', 'SKILL.md'));
  assert.deepEqual(listHomeSkills(), [{ name: 'zero', description: '' }]);
});

test('a read-only source folder (a Nix store, a module cache): the stage commits, and is removed after its commit or a discard', { skip: !POSIX || process.getuid?.() === 0 }, async () => {
  const from = writeSkill(join(src, 'ro-skill'), { 'SKILL.md': skillMd('ro-skill'), 'references/a.md': 'a\n' });
  chmodSync(join(from, 'references'), 0o555);
  chmodSync(from, 0o555);
  try {
    const s = await stageImport({ kind: 'dir', path: from });
    const t = await stageImport({ kind: 'dir', path: from });
    await commitImport(s.dir, s.name);
    discardStage(t.stage);
    assert.deepEqual(stages(), []);
    assert.deepEqual(Object.keys(readSkillLibrary().skills), ['ro-skill']);
  } finally {
    chmodSync(from, 0o755);
    chmodSync(join(from, 'references'), 0o755);
  }
});

test('a source holding something that cannot be read is refused before anything is copied', { skip: !POSIX || process.getuid?.() === 0 }, async () => {
  const from = writeSkill(join(src, 'locked'), { 'SKILL.md': skillMd('locked'), 'data/cache.json': '{}' });
  chmodSync(join(from, 'data', 'cache.json'), 0);
  try {
    await assert.rejects(stageImport({ kind: 'dir', path: from }), (e) => e instanceof SkillLibraryError && e.status === 400
      && e.message === 'some files cannot be read: data/cache.json: cannot be read (EACCES)' && e.problems.length === 1);
    assert.deepEqual(stages(), []);
  } finally {
    chmodSync(join(from, 'data', 'cache.json'), 0o600);
  }
});

test("a copy that fails after the checks is a 400 and leaves nothing behind; a folder holding Worca's own stages is refused", { skip: !POSIX || process.getuid?.() === 0 }, async () => {
  // a file over 1 MB is never read by the checks; either copy order, a read-only folder copied first never pins the stage
  for (const [ro, locked] of [['aa', 'zz.bin'], ['zz', 'aa.bin']]) {
    const from = writeSkill(join(src, `copy-${ro}`), { 'SKILL.md': skillMd(`copy-${ro}`), [`${ro}/x.md`]: 'x\n', [locked]: Buffer.alloc(2 << 20) });
    chmodSync(join(from, ro), 0o555);
    chmodSync(join(from, locked), 0);
    try {
      await rejects(stageImport({ kind: 'dir', path: from }), 400, /^folder: could not copy it \(/);
      assert.deepEqual(stages(), []);
    } finally {
      chmodSync(join(from, ro), 0o755);
      chmodSync(join(from, locked), 0o600);
    }
  }
  writeFileSync(join(process.env.WORCA_HOME, 'SKILL.md'), skillMd('home'));
  await rejects(stageImport({ kind: 'dir', path: process.env.WORCA_HOME }), 400, /^folder: it holds Worca's own import folder$/);
  const upper = process.env.WORCA_HOME.toUpperCase();
  if (upper !== process.env.WORCA_HOME && existsSync(upper)) { // a case-insensitive disk (macOS): one folder, other letters
    await rejects(stageImport({ kind: 'dir', path: upper }), 400, /^folder: it holds Worca's own import folder$/);
  }
  assert.deepEqual(stages(), []);
});

test('a link inside the folder written absolute, or through the folder\'s own name, is staged pointing into the stage', { skip: !POSIX }, async () => {
  const from = writeSkill(join(src, 'linky'), { 'SKILL.md': skillMd('linky'), 'docs/ref.md': 'ref\n' });
  symlinkSync(join(from, 'docs', 'ref.md'), join(from, 'abs.md'));
  symlinkSync(join('..', 'linky', 'docs', 'ref.md'), join(from, 'up.md'));
  const s = await stageImport({ kind: 'dir', path: from });
  assert.deepEqual([s.inspection.problems, s.inspection.files.map((f) => f.path)], [[], ['SKILL.md', 'abs.md', 'docs/ref.md', 'up.md']]);
  await commitImport(s.dir, s.name);
  const lib = join(process.env.WORCA_HOME, '.worca-cc', 'skills', 'linky');
  assert.deepEqual(['abs.md', 'up.md'].map((f) => [lstatSync(join(lib, f)).isSymbolicLink(), readFileSync(join(lib, f), 'utf8')]),
    [[false, 'ref\n'], [false, 'ref\n']], 'imported as plain files');
});

test('a read-only source folder whose links are written absolute, or through its own name, is staged pointing into the stage', { skip: !POSIX || process.getuid?.() === 0 }, async () => {
  const from = writeSkill(join(src, 'ro-linky'), { 'SKILL.md': skillMd('ro-linky'), 'docs/ref.md': 'ref\n' });
  symlinkSync(join(from, 'docs', 'ref.md'), join(from, 'docs', 'abs.md'));
  symlinkSync(join('..', 'ro-linky', 'docs', 'ref.md'), join(from, 'up.md'));
  chmodSync(join(from, 'docs'), 0o555);
  chmodSync(from, 0o555);
  try {
    const s = await stageImport({ kind: 'dir', path: from });
    assert.deepEqual([s.inspection.problems, s.inspection.files.map((f) => f.path)], [[], ['SKILL.md', 'docs/abs.md', 'docs/ref.md', 'up.md']]);
    await commitImport(s.dir, s.name);
    assert.deepEqual(stages(), []);
  } finally {
    chmodSync(from, 0o755);
    chmodSync(join(from, 'docs'), 0o755);
  }
});

test('a folder that grows while it is copied is never copied past the limits', async () => {
  const from = writeSkill(join(src, 'growing'), { 'SKILL.md': skillMd('growing') });
  const cpSync = fs.cpSync;
  fs.cpSync = (...args) => { // the checks have passed; now a build writes into the folder
    for (let i = 0; i < 400; i++) writeFileSync(join(from, `out-${i}.txt`), 'x\n');
    return cpSync(...args);
  };
  syncBuiltinESMExports();
  try {
    await rejects(stageImport({ kind: 'dir', path: from }), 400, /^folder: it grew past the limits while it was copied \(at most 300 files/);
  } finally {
    fs.cpSync = cpSync;
    syncBuiltinESMExports();
  }
  assert.deepEqual(stages(), []);
});
