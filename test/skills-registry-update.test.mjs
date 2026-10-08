// test/skills-registry-update.test.mjs — library updates are never automatic (skills registry design §5): Check
// for updates re-stages from the origin (folder, ~/.claude/skills, git) and diffs; Update applies that stage.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { useTempHome } from './helpers/temp-home.mjs';
import { copyFixture, writeSkill, skillMd, POSIX } from './helpers/skills-registry-fixtures.mjs';
import { stageImport, updatePreview } from '../src/core/skills-registry/import.mjs';
import {
  commitImport, applyUpdate, removeLibrarySkill, readSkillLibrary, stageDirOf, skillsDir, SkillLibraryError,
} from '../src/core/skills-registry/library.mjs';
import { inspectSkillDir } from '../src/core/skills-registry/inspect.mjs';

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

const rejects = (p, status, re) => assert.rejects(p, (e) => e instanceof SkillLibraryError && e.status === status && re.test(e.message));
const imported = async (source) => { const s = await stageImport(source); await commitImport(s.dir, s.name); return s.name; };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8' }).trim();

test('a folder origin: added, removed and changed files; Update swaps the copy and records the new hash', async () => {
  const from = copyFixture('beta-scripts', src);
  writeFileSync(join(from, 'old.md'), 'old\n');
  const name = await imported({ kind: 'dir', path: from });
  const unchanged = await updatePreview(name);
  assert.deepEqual([unchanged.added, unchanged.removed, unchanged.changed], [[], [], []]);
  writeFileSync(join(from, 'SKILL.md'), skillMd('beta-scripts', 'Now different.'));
  writeFileSync(join(from, 'new.md'), 'new\n');
  rmSync(join(from, 'old.md'));
  if (POSIX) chmodSync(join(from, 'scripts', 'run.sh'), 0o644);
  const p = await updatePreview(name);
  assert.deepEqual(Object.keys(p), ['stage', 'added', 'removed', 'changed', 'inspection']);
  assert.deepEqual([p.added, p.removed, p.changed], [['new.md'], ['old.md'], ['SKILL.md', ...(POSIX ? ['scripts/run.sh'] : [])]]);
  assert.equal(readSkillLibrary().skills[name].hash, inspectSkillDir(join(skillsDir(), name)).hash, 'a preview changes nothing');
  assert.deepEqual(JSON.parse(readFileSync(`${stageDirOf(p.stage)}.json`, 'utf8')), { origin: { kind: 'dir', path: from }, update: name });
  const e = await applyUpdate(name, stageDirOf(p.stage));
  assert.equal(e.hash, p.inspection.hash);
  assert.equal(inspectSkillDir(join(skillsDir(), name)).description, 'Now different.');
  await rejects(commitImport(stageDirOf((await updatePreview(name)).stage), 'other'), 400, /holds an update/);
});

test('a ~/.claude/skills origin follows that folder', async () => {
  const home = join(process.env.HOME, '.claude', 'skills');
  copyFixture('alpha', home);
  const name = await imported({ kind: 'home', name: 'alpha' });
  writeFileSync(join(home, 'alpha', 'extra.md'), 'x\n');
  assert.deepEqual((await updatePreview(name)).added, ['extra.md']);
});

/** A work repo published to a bare repo over file:// → { url, commit(files, msg) → sha }; `null` deletes a file. */
function gitRepo() {
  const work = mkdtempSync(join(root, 'repo-'));
  const bare = `${work}.git`;
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  git(work, 'init', '-q', '-b', 'main');
  const commit = (files, msg) => {
    for (const [rel, text] of Object.entries(files)) if (text === null) rmSync(join(work, rel)); else writeSkill(work, { [rel]: text });
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', msg);
    git(work, 'push', '-q', bare, 'main');
    return git(work, 'rev-parse', 'HEAD');
  };
  return { url: pathToFileURL(bare).href, commit };
}

test('a git origin: the remote HEAD moves on; a commit-pinned ref never does', async () => {
  const { url, commit } = gitRepo();
  const first = commit({ 'skills/notes/SKILL.md': skillMd('notes', 'First.') }, 'one');
  const name = await imported({ kind: 'git', url, subdir: 'skills/notes' });
  const second = commit({ 'skills/notes/SKILL.md': skillMd('notes', 'Second.') }, 'two');
  const p = await updatePreview(name);
  assert.deepEqual([p.added, p.removed, p.changed], [[], [], ['SKILL.md']]);
  const e = await applyUpdate(name, stageDirOf(p.stage));
  assert.deepEqual(e.origin, { kind: 'git', url, ref: null, subdir: 'skills/notes', sha: second });
  await removeLibrarySkill(name);
  const pinned = await imported({ kind: 'git', url, ref: first, subdir: 'skills/notes' });
  const q = await updatePreview(pinned);
  assert.deepEqual([q.added, q.removed, q.changed, q.inspection.description], [[], [], [], 'First.']);
  assert.equal(JSON.parse(readFileSync(`${stageDirOf(q.stage)}.json`, 'utf8')).origin.sha, first);
});

test('an update fetches the recorded folder only: a skill that moved in its repo is refused, never switched', async () => {
  const { url, commit } = gitRepo();
  commit({ 'SKILL.md': skillMd('rooty') }, 'one');
  const name = await imported({ kind: 'git', url });
  commit({ 'SKILL.md': null, 'moved/SKILL.md': skillMd('rooty') }, 'two');
  await rejects(updatePreview(name), 400, /^no SKILL.md at the root of file:/);
});

test('a folder name with a space: picked at import, fetched again by its recorded name', async () => {
  const { url, commit } = gitRepo();
  commit({ 'My Skill/SKILL.md': skillMd('my-skill', 'First.') }, 'one');
  const name = await imported({ kind: 'git', url });
  commit({ 'My Skill/SKILL.md': skillMd('my-skill', 'Second.') }, 'two');
  const p = await updatePreview(name);
  assert.deepEqual([name, p.changed, p.inspection.description, JSON.parse(readFileSync(`${stageDirOf(p.stage)}.json`, 'utf8')).origin.subdir],
    ['my-skill', ['SKILL.md'], 'Second.', 'My Skill']);
});

test('refusals: a pasted skill has no origin; unknown and malformed names; a vanished origin folder', async () => {
  const pasted = await imported({ kind: 'paste', name: 'p', content: skillMd('pasted') });
  await rejects(updatePreview(pasted), 400, /pasted: it has no origin/);
  await rejects(updatePreview('nope'), 404, /no skill named "nope"/);
  await rejects(updatePreview('../x'), 400, /lowercase/);
  const from = copyFixture('alpha', src);
  const name = await imported({ kind: 'dir', path: from });
  rmSync(from, { recursive: true });
  await rejects(updatePreview(name), 404, /folder not found/);
  await rejects(updatePreview({ toString: 0 }), 400, /^name must be text, not object$/);
  writeFileSync(join(skillsDir(), 'library.json'), 'not json{');
  await rejects(updatePreview(name), 409, /^the skill library file skills\/library.json is damaged — fix it or remove it$/);
});
