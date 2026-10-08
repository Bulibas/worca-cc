// test/skills-registry-library.test.mjs — the skill library store (skills registry design §3.2): library.json
// schema 1 and 0600, folders 0700, the lock (never nested, FIFO, busy, crashed holder), newer files refused,
// stage commits, removal order, updates.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, lstatSync, chmodSync, mkdirSync, readdirSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { useTempHome } from './helpers/temp-home.mjs';
import { copyFixture, writeSkill, skillMd, POSIX } from './helpers/skills-registry-fixtures.mjs';
import {
  SkillLibraryError, skillsDir, stagesDir, stageDirOf, readSkillLibrary, withSkillsLock, commitImport, removeLibrarySkill, applyUpdate,
} from '../src/core/skills-registry/library.mjs';
import { inspectSkillDir } from '../src/core/skills-registry/inspect.mjs';

const root = useTempHome(after);
beforeEach(() => { process.env.WORCA_HOME = mkdtempSync(join(root, 'h-')); });

const plain = (v) => JSON.parse(JSON.stringify(v));
const libFile = () => join(skillsDir(), 'library.json');
const disk = () => JSON.parse(readFileSync(libFile(), 'utf8'));
const mode = (p) => statSync(p).mode & 0o777;
/** A stage as import.mjs writes one: <stagesDir>/<16 hex>/ + <16 hex>.json. */
function stage(fill, meta = { origin: null }) {
  const dir = join(stagesDir(), randomBytes(8).toString('hex'));
  mkdirSync(dir, { recursive: true });
  if (typeof fill === 'string') copyFixture(fill, dir, '.'); else writeSkill(dir, fill);
  writeFileSync(`${dir}.json`, JSON.stringify(meta));
  return dir;
}
const rejects = (p, status, re) => assert.rejects(p, (e) => e instanceof SkillLibraryError && e.status === status && re.test(e.message));

test('a fresh home reads an empty library and writes nothing', () => {
  const lib = readSkillLibrary();
  assert.deepEqual(plain(lib), { newer: false, damaged: false, skills: {} });
  assert.equal(Object.getPrototypeOf(lib.skills), null);
  assert.equal(existsSync(skillsDir()), false);
  assert.equal(skillsDir(), join(process.env.WORCA_HOME, '.worca-cc', 'skills'));
  assert.equal(stageDirOf('0123456789abcdef'), join(stagesDir(), '0123456789abcdef'));
  assert.throws(() => stageDirOf('../x'), (e) => e.status === 400);
});

test('commitImport: entry, folder, modes; the stage is gone; the library hash is the folder hash', async () => {
  const dir = stage('beta-scripts', { origin: { kind: 'dir', path: '/src/beta-scripts' } });
  const e = await commitImport(dir, 'beta-scripts');
  assert.deepEqual(Object.keys(e), ['origin', 'hash', 'importedAt', 'updatedAt', 'files', 'bytes', 'scripts', 'shellBlocks']);
  assert.deepEqual([e.origin, e.files, e.scripts, e.shellBlocks], [{ kind: 'dir', path: '/src/beta-scripts' }, 2, ['scripts/run.sh'], 1]);
  assert.equal(e.importedAt, e.updatedAt);
  assert.deepEqual(disk(), { schema: 1, skills: { 'beta-scripts': e } });
  const lib = join(skillsDir(), 'beta-scripts');
  assert.equal(inspectSkillDir(lib, { name: 'beta-scripts' }).hash, e.hash);
  assert.deepEqual([existsSync(dir), existsSync(`${dir}.json`)], [false, false]);
  if (POSIX) {
    assert.deepEqual([mode(skillsDir()), mode(libFile()), mode(lib), mode(join(lib, 'SKILL.md')), mode(join(lib, 'scripts', 'run.sh'))],
      [0o700, 0o600, 0o700, 0o600, 0o700]);
  }
});

test('commitImport refusals keep the stage: bad name, problems, name in use, update stage; gone stage; not a stage', async () => {
  const dir = stage('alpha');
  await rejects(commitImport(dir, 'Alpha'), 400, /lowercase letters/);
  await rejects(commitImport(dir, 'beta'), 400, /SKILL.md names the skill "alpha", not "beta"/);
  await commitImport(stage('alpha'), 'alpha');
  await rejects(commitImport(dir, 'alpha'), 409, /a skill named "alpha" is already in the library/);
  assert.equal(existsSync(dir), true, 'a refused commit keeps its stage');
  const bad = stage('gamma-bad');
  await assert.rejects(commitImport(bad, 'gamma'), (e) => e.status === 400 && e.problems.length === 1 && /\.claude-plugin/.test(e.problems[0]));
  await rejects(commitImport(stage('alpha', { origin: { kind: 'dir', path: '/x' }, update: 'alpha' }), 'alpha'), 400, /holds an update/);
  await rejects(commitImport(join(stagesDir(), 'ffffffffffffffff'), 'x'), 404, /no longer staged/);
  await rejects(commitImport({ toString: 0 }, 'x'), 400, /^not an import stage$/);
  const noOrigin = stage('alpha', { update: null });
  await rejects(commitImport(noOrigin, 'alpha'), 404, /no longer staged/);
  const outside = writeSkill(join(process.env.WORCA_HOME, 'mine'), { 'SKILL.md': skillMd('mine') });
  writeFileSync(`${outside}.json`, JSON.stringify({ origin: null }));
  await rejects(commitImport(outside, 'mine'), 400, /not an import stage/);
  assert.equal(existsSync(join(outside, 'SKILL.md')), true, 'a folder outside the stages is never copied or removed');
  assert.deepEqual(Object.keys(disk().skills), ['alpha']);
});

test('a link inside the stage becomes a plain file in the library', { skip: !POSIX }, async () => {
  const dir = stage({ 'SKILL.md': skillMd('ln'), 'docs/ref.md': 'ref\n' });
  symlinkSync('docs/ref.md', join(dir, 'ref.md'));
  await commitImport(dir, 'ln');
  const copy = join(skillsDir(), 'ln', 'ref.md');
  assert.deepEqual([lstatSync(copy).isSymbolicLink(), readFileSync(copy, 'utf8')], [false, 'ref\n']);
});

test('a stage that is a link is no stage: nothing is committed through it, nothing it points at is removed', { skip: !POSIX }, async () => {
  const mine = writeSkill(join(process.env.WORCA_HOME, 'mine'), { 'SKILL.md': skillMd('mine'), 'precious.txt': 'keep\n' });
  mkdirSync(stagesDir(), { recursive: true });
  const fake = join(stagesDir(), '0123456789abcdef');
  symlinkSync(mine, fake);
  writeFileSync(`${fake}.json`, JSON.stringify({ origin: null }));
  await rejects(commitImport(fake, 'mine'), 400, /^not an import stage$/);
  writeFileSync(`${fake}.json`, JSON.stringify({ origin: null, update: 'mine' }));
  await rejects(applyUpdate('mine', fake), 400, /^not an import stage$/);
  assert.deepEqual([readdirSync(mine).sort(), existsSync(skillsDir())], [['SKILL.md', 'precious.txt'], false]);
});

test('a library.json with schema > 1: nothing is read, nothing is written', async () => {
  mkdirSync(skillsDir(), { recursive: true });
  writeFileSync(libFile(), JSON.stringify({ schema: 2, skills: { alpha: { hash: 'h' } } }));
  assert.deepEqual(plain(readSkillLibrary()), { newer: true, damaged: false, skills: {} });
  await rejects(commitImport(stage('alpha'), 'alpha'), 409, /the skill library needs a newer Worca/);
  assert.equal(disk().schema, 2);
  assert.equal(existsSync(join(skillsDir(), 'alpha')), false);
});

test('hand-edited entries read as absent and the next write drops them; a BOM or a schema object is no damage', async () => {
  mkdirSync(skillsDir(), { recursive: true });
  writeFileSync(libFile(), JSON.stringify({ schema: 1, skills: { 'Bad Name': {}, ok: { hash: 'h' }, junk: 5, ['__proto__']: { x: 1 } } }));
  assert.deepEqual(plain(readSkillLibrary().skills), { ok: { hash: 'h' } });
  await commitImport(stage('alpha'), 'alpha');
  assert.deepEqual(Object.keys(disk().skills), ['ok', 'alpha']);
  writeFileSync(libFile(), String.fromCharCode(0xfeff) + JSON.stringify(disk()));
  assert.deepEqual(Object.keys(readSkillLibrary().skills), ['ok', 'alpha'], 'a leading BOM is no damage');
  await commitImport(stage({ 'SKILL.md': skillMd('b') }), 'b');
  assert.deepEqual(Object.keys(disk().skills), ['ok', 'alpha', 'b']);
  writeFileSync(libFile(), JSON.stringify({ schema: { toString: 0 }, skills: { ok: { hash: 'h' } } }));
  assert.deepEqual(plain(readSkillLibrary()), { newer: false, damaged: false, skills: { ok: { hash: 'h' } } }, 'a schema that is no number never throws');
});

test('a damaged library.json is never replaced: reads are empty and damaged, every write is 409, the file is kept', async () => {
  await commitImport(stage('alpha'), 'alpha');
  const good = readFileSync(libFile(), 'utf8');
  for (const text of [`${good.trimEnd().slice(0, -1)}, }`, 'not json{', '[]', JSON.stringify({ schema: 1, skills: [] })]) {
    writeFileSync(libFile(), text);
    assert.deepEqual(plain(readSkillLibrary()), { newer: false, damaged: true, skills: {} }, text);
    await rejects(commitImport(stage({ 'SKILL.md': skillMd('b') }), 'b'), 409, /^the skill library file skills\/library.json is damaged — fix it or remove it$/);
    await rejects(removeLibrarySkill('alpha'), 409, /is damaged/);
    assert.equal(readFileSync(libFile(), 'utf8'), text, 'the damaged file is left for the user');
  }
  assert.equal(existsSync(join(skillsDir(), 'b')), false);
  assert.equal(existsSync(join(skillsDir(), 'alpha')), true);
  if (POSIX) {
    rmSync(libFile());
    symlinkSync(join(skillsDir(), 'gone.json'), libFile());
    assert.equal(readSkillLibrary().damaged, true, 'a dangling link is no missing file');
    await rejects(commitImport(stage({ 'SKILL.md': skillMd('c') }), 'c'), 409, /is damaged/);
    assert.equal(lstatSync(libFile()).isSymbolicLink(), true);
  }
});

test('a stage removed while its commit waits for the lock: 404, nothing copied', async () => {
  const dir = stage('alpha');
  const pending = commitImport(dir, 'alpha');
  rmSync(dir, { recursive: true, force: true });
  rmSync(`${dir}.json`, { force: true });
  await rejects(pending, 404, /no longer staged/);
  assert.deepEqual(readdirSync(skillsDir()).sort(), []);
});

test('the lock is never nested: a library operation inside withSkillsLock rejects at once', { timeout: 5000 }, async () => {
  await commitImport(stage('alpha'), 'alpha');
  await assert.rejects(withSkillsLock(() => removeLibrarySkill('alpha')), /never nest/);
  await assert.rejects(withSkillsLock(() => withSkillsLock(async () => {})), /never nest/);
  let called = false;
  await assert.rejects(withSkillsLock(() => removeLibrarySkill('alpha', { beforeRemove: () => { called = true; } })), /never nest/);
  assert.equal(called, false, 'a nested removal changes nothing, memberships included');
  assert.deepEqual(Object.keys(disk().skills), ['alpha']);
});

test('the lock: FIFO in-process, busy after the timeout, a crashed holder does not block', async () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f'];
  await Promise.all(names.map((n) => commitImport(stage({ 'SKILL.md': skillMd(n) }), n)));
  assert.deepEqual(Object.keys(disk().skills), names);
  writeFileSync(join(skillsDir(), '.lock'), JSON.stringify({ pid: process.ppid, token: 'x', at: new Date().toISOString() }));
  let ran = false;
  await rejects(withSkillsLock(() => { ran = true; }, { timeoutMs: 150 }), 503, /^the skill library is busy$/);
  assert.equal(ran, false);
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  writeFileSync(join(skillsDir(), '.lock'), JSON.stringify({ pid: dead, token: 'x', at: new Date().toISOString() }));
  await commitImport(stage({ 'SKILL.md': skillMd('after-crash') }), 'after-crash');
  let kept;
  await withSkillsLock(async (tx) => { kept = tx; });
  assert.throws(() => kept.write(), /after the lock was released/);
});

test('leftovers of a crash are swept by the next locked write; a folder no entry names is replaced by a commit', async () => {
  mkdirSync(join(skillsDir(), '.incoming-0a1b2c3d', 'x'), { recursive: true });
  mkdirSync(join(skillsDir(), '.outgoing-0a1b2c3d'), { recursive: true });
  mkdirSync(join(skillsDir(), '.keep'), { recursive: true });
  writeFileSync(join(skillsDir(), 'library.json.0a1b2c3d.tmp'), '{');
  writeSkill(join(skillsDir(), 'alpha'), { 'stale.txt': 'old' });
  await commitImport(stage('alpha'), 'alpha');
  assert.deepEqual(readdirSync(skillsDir()).sort(), ['.keep', 'alpha', 'library.json']);
  assert.deepEqual(readdirSync(join(skillsDir(), 'alpha')), ['SKILL.md']);
});

test('removeLibrarySkill: beforeRemove first and outside the lock; a failing beforeRemove removes nothing', async () => {
  await commitImport(stage('alpha'), 'alpha');
  await rejects(removeLibrarySkill('alpha', { beforeRemove: async () => { throw new SkillLibraryError(503, 'MCP registry is busy'); } }), 503, /busy/);
  assert.deepEqual([Object.keys(disk().skills), existsSync(join(skillsDir(), 'alpha'))], [['alpha'], true]);
  const seen = [];
  const removed = await removeLibrarySkill('alpha', {
    beforeRemove: async () => {
      seen.push(Object.keys(readSkillLibrary().skills), existsSync(join(skillsDir(), 'alpha')));
      await withSkillsLock(async () => {}); // not inside the library lock
    },
  });
  assert.deepEqual(seen, [['alpha'], true]);
  assert.match(removed.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual([Object.keys(disk().skills), existsSync(join(skillsDir(), 'alpha'))], [[], false]);
  let called = false;
  await rejects(removeLibrarySkill('alpha', { beforeRemove: () => { called = true; } }), 404, /no skill named "alpha"/);
  assert.equal(called, false);
  await rejects(removeLibrarySkill('../x'), 400, /lowercase/);
  await rejects(removeLibrarySkill({ toString: 0 }), 400, /^name must be text, not object$/);
  await commitImport(stage('alpha'), 'alpha');
  writeFileSync(libFile(), JSON.stringify({ schema: 2, skills: disk().skills }));
  await rejects(removeLibrarySkill('alpha', { beforeRemove: () => { called = true; } }), 409, /needs a newer Worca/);
  assert.equal(called, false);
});

test('applyUpdate: swaps the folder, keeps importedAt, takes the stage origin; refusals leave the library alone', async () => {
  const before = await commitImport(stage('alpha', { origin: { kind: 'dir', path: '/a' } }), 'alpha');
  const upd = stage({ 'SKILL.md': skillMd('alpha', 'New words.'), 'ref.md': 'more\n' }, { origin: { kind: 'dir', path: '/a' }, update: 'alpha' });
  await rejects(applyUpdate('alpha', stage('alpha')), 400, /not an update of "alpha"/);
  await rejects(applyUpdate('beta', upd), 400, /not an update of "beta"/);
  await rejects(applyUpdate({ toString: 0 }, upd), 400, /^name must be text, not object$/);
  const broken = stage({ 'README.md': 'x' }, { origin: { kind: 'dir', path: '/a' }, update: 'alpha' });
  await rejects(applyUpdate('alpha', broken), 400, /SKILL.md is missing/);
  assert.equal(disk().skills.alpha.hash, before.hash);
  await new Promise((r) => setTimeout(r, 5));
  const after = await applyUpdate('alpha', upd);
  assert.deepEqual([after.importedAt, after.files, after.origin], [before.importedAt, 2, { kind: 'dir', path: '/a' }]);
  assert.notEqual(after.updatedAt, before.updatedAt);
  assert.notEqual(after.hash, before.hash);
  assert.equal(inspectSkillDir(join(skillsDir(), 'alpha')).description, 'New words.');
  assert.deepEqual(readdirSync(skillsDir()).sort(), ['alpha', 'library.json']);
  await rejects(applyUpdate('gone', stage({ 'SKILL.md': skillMd('gone') }, { origin: null, update: 'gone' })), 404, /no skill named "gone"/);
});

test('a library.json that exists but cannot be read aborts a write instead of being replaced', { skip: !POSIX || process.getuid?.() === 0 }, async () => {
  await commitImport(stage('alpha'), 'alpha');
  chmodSync(libFile(), 0);
  try {
    assert.deepEqual(plain(readSkillLibrary().skills), {}, 'a read never throws');
    await assert.rejects(commitImport(stage({ 'SKILL.md': skillMd('b') }), 'b'), { code: 'EACCES' });
  } finally { chmodSync(libFile(), 0o600); }
  assert.deepEqual(Object.keys(disk().skills), ['alpha']);
});
