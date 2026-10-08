// test/skills-registry-catalog.test.mjs — the skill catalog (skills registry design §3.3): plugin skills (installed,
// linked, disabled), library skills, invalid ones listed and flagged, sorted by id, read-only, cheap to call again.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, writeFileSync, rmSync, realpathSync, existsSync, chmodSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, basename } from 'node:path';
import { useTempHome } from './helpers/temp-home.mjs';
import { copyFixture, writeSkill, skillMd, installSkillPlugin, SKILL_FIXTURES, POSIX } from './helpers/skills-registry-fixtures.mjs';
import { writeMcpPlugin } from './helpers/mcp-plugin-fixture.mjs';
import { linkPlugin } from '../src/core/plugin-store.mjs';
import { loadSkillCatalog } from '../src/core/skills-registry/catalog.mjs';
import { stageImport } from '../src/core/skills-registry/import.mjs';
import { commitImport, readSkillLibrary, skillsDir } from '../src/core/skills-registry/library.mjs';
import { inspectSkillDir } from '../src/core/skills-registry/inspect.mjs';

const root = useTempHome(after);
let scratch;
beforeEach(() => {
  process.env.WORCA_HOME = mkdtempSync(join(root, 'h-'));
  scratch = mkdtempSync(join(root, 's-'));
});

const MOCK_SOURCE = join(SKILL_FIXTURES, '..', 'plugins', 'mock-source');

test('a fresh home has an empty catalog', () => {
  assert.deepEqual(loadSkillCatalog(), []);
});

test('plugin skills: installed, linked and disabled plugins; dir under realpath(current); code; sorted by id', () => {
  const vdir = installSkillPlugin('acme-tools', {
    skills: { 'deploy-checklist': { 'SKILL.md': skillMd('deploy-checklist', 'Checks a deploy.'), 'scripts/check.sh': '#!/bin/sh\n' }, 'not-a-skill': { 'README.md': 'x' } },
  });
  writeFileSync(join(vdir, 'skills', 'loose.md'), 'a file, not a skill folder\n');
  const wdir = mkdtempSync(join(scratch, 'dev-'));
  installSkillPlugin('dev-tools', { linkedDir: wdir, enabled: false, skills: { graphify: { 'SKILL.md': skillMd('graphify') } } });
  installSkillPlugin('mock-source', { linkedDir: MOCK_SOURCE });
  const cat = loadSkillCatalog();
  assert.deepEqual(cat.map((e) => e.id), ['skill:plugin:acme-tools/deploy-checklist', 'skill:plugin:dev-tools/graphify', 'skill:plugin:mock-source/mock-skill']);
  const dc = cat[0];
  const dir = join(realpathSync(vdir), 'skills', 'deploy-checklist');
  assert.deepEqual(dc, {
    id: 'skill:plugin:acme-tools/deploy-checklist', source: 'plugin', plugin: 'acme-tools', name: 'deploy-checklist', dir,
    description: 'Checks a deploy.', whenToUse: null,
    frontmatter: { allowedTools: null, hooks: false, shell: false, disableModelInvocation: false, pluginRootRefs: false },
    files: 2, bytes: dc.bytes, scripts: ['scripts/check.sh'], shellBlocks: 0, hash: inspectSkillDir(dir).hash, code: 'abcdef0',
    pluginEnabled: true, valid: true, problems: [],
  });
  assert.deepEqual([cat[1].dir, cat[1].code, cat[1].pluginEnabled], [join(realpathSync(wdir), 'skills', 'graphify'), 'linked', false]);
  assert.deepEqual([cat[2].description, cat[2].valid], ['Trivial helper skill shipped by the mock-source fixture plugin. Runs helper.sh.', true]);
});

test('invalid skills are listed, flagged and keep their problems; a broken plugin ships nothing', () => {
  const gdir = mkdtempSync(join(scratch, 'g-'));
  copyFixture('gamma-bad', join(gdir, 'skills'));
  writeSkill(join(gdir, 'skills', 'Bad_Name'), { 'SKILL.md': '---\ndescription: Upper case.\n---\n' });
  installSkillPlugin('odd-tools', { linkedDir: gdir });
  installSkillPlugin('a--b', { skills: { x: { 'SKILL.md': skillMd('x') } } });
  const gone = mkdtempSync(join(scratch, 'gone-'));
  installSkillPlugin('gone-tools', { linkedDir: gone, skills: { y: { 'SKILL.md': skillMd('y') } } });
  rmSync(gone, { recursive: true, force: true });
  const byId = Object.fromEntries(loadSkillCatalog().map((e) => [e.id, e]));
  assert.deepEqual(Object.keys(byId), ['skill:plugin:a--b/x', 'skill:plugin:odd-tools/Bad_Name', 'skill:plugin:odd-tools/gamma-bad']);
  assert.deepEqual(byId['skill:plugin:a--b/x'].problems, ['skill:plugin:a--b/x is not a valid skill id']);
  assert.match(byId['skill:plugin:odd-tools/Bad_Name'].problems[0], /^name "Bad_Name": use lowercase letters/);
  assert.deepEqual(byId['skill:plugin:odd-tools/gamma-bad'].problems, [
    '.claude-plugin/: a skill cannot ship a .claude-plugin folder', 'SKILL.md names the skill "gamma", not "gamma-bad"',
  ]);
  assert.equal(Object.values(byId).every((e) => e.valid === false), true);
});

test('library skills: every entry, its folder in the library; a missing folder is invalid; plugin + library sorted together', async () => {
  const s = await stageImport({ kind: 'dir', path: copyFixture('beta-scripts', scratch) });
  await commitImport(s.dir, s.name);
  const lost = await stageImport({ kind: 'paste', name: 'lost', content: skillMd('lost') });
  await commitImport(lost.dir, 'lost');
  rmSync(join(skillsDir(), 'lost'), { recursive: true });
  installSkillPlugin('acme-tools', { skills: { zeta: { 'SKILL.md': skillMd('zeta') } } });
  const cat = loadSkillCatalog();
  assert.deepEqual(cat.map((e) => [e.id, e.valid]), [
    ['skill:library:beta-scripts', true], ['skill:library:lost', false], ['skill:plugin:acme-tools/zeta', true],
  ]);
  const beta = cat[0];
  assert.deepEqual([beta.source, beta.plugin, beta.dir, beta.code, beta.pluginEnabled, beta.shellBlocks, beta.scripts],
    ['library', null, join(skillsDir(), 'beta-scripts'), null, true, 1, ['scripts/run.sh']]);
  assert.equal(beta.hash, readSkillLibrary().skills['beta-scripts'].hash);
  assert.deepEqual(cat[1].problems, ['skill folder not found']);
  assert.deepEqual(loadSkillCatalog({ newer: true, skills: readSkillLibrary().skills }).map((e) => e.id), ['skill:plugin:acme-tools/zeta'],
    'a newer library lists only plugin skills');
  assert.deepEqual(loadSkillCatalog({ newer: false, skills: { '../..': {}, 'Bad Name': {} } }).map((e) => e.id), ['skill:plugin:acme-tools/zeta'],
    'a hand-built snapshot never names a folder outside the library');
  assert.deepEqual(loadSkillCatalog(readSkillLibrary()), cat, 'a snapshot reads the same');
});

test('a read never writes', () => {
  installSkillPlugin('acme-tools', { skills: { a: { 'SKILL.md': skillMd('a') } } });
  loadSkillCatalog();
  assert.equal(existsSync(skillsDir()), false);
});

/** Run `fn` and return every path under `roots` it read with readFileSync. */
function readsUnder(roots, fn) {
  const seen = [];
  const orig = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => {
    if (typeof p === 'string' && roots.some((r) => p.startsWith(r))) seen.push(p);
    return orig(p, ...rest);
  };
  syncBuiltinESMExports();
  try { fn(); } finally { fs.readFileSync = orig; syncBuiltinESMExports(); }
  return seen;
}

test('a second call reads no skill file; an edited skill is re-read alone; callers cannot change the cache', () => {
  const acme = installSkillPlugin('acme-tools', { skills: { lint: { 'SKILL.md': skillMd('lint', 'Acme lint.'), 'scripts/run.sh': '#!/bin/sh\n' } } });
  const other = installSkillPlugin('other-tools', { skills: { lint: { 'SKILL.md': skillMd('lint', 'Other lint.') } } });
  const roots = [join(realpathSync(acme), 'skills'), join(realpathSync(other), 'skills')];
  let first;
  assert.equal(readsUnder(roots, () => { first = loadSkillCatalog(); }).length, 3);
  let second;
  assert.deepEqual(readsUnder(roots, () => { second = loadSkillCatalog(); }), [], 'nothing re-read, nothing re-hashed');
  assert.deepEqual(second, first);
  assert.deepEqual(second.map((e) => e.description), ['Acme lint.', 'Other lint.'], 'one cache entry per folder, not per name');
  writeFileSync(join(acme, 'skills', 'lint', 'scripts', 'run.sh'), '#!/bin/sh\necho changed\n');
  let third;
  assert.deepEqual(readsUnder(roots, () => { third = loadSkillCatalog(); }).map((p) => basename(p)).sort(), ['SKILL.md', 'run.sh']);
  assert.notEqual(third[0].hash, first[0].hash);
  assert.equal(third[1].hash, first[1].hash);
  third[0].scripts.push('x');
  third[0].frontmatter.hooks = true;
  third[0].problems.push('x');
  const again = loadSkillCatalog()[0];
  assert.deepEqual([again.scripts, again.frontmatter.hooks, again.problems], [['scripts/run.sh'], false, []]);
});

test('the fingerprint counts what the inspection counts: .git files in sub-folders never hide a later edit', () => {
  const files = { 'SKILL.md': skillMd('many') };
  for (let i = 0; i < 150; i++) files[`d${String(i).padStart(3, '0')}/.git`] = 'gitdir: ../.git/modules/x\n';
  for (let i = 0; i < 200; i++) files[`f${String(i).padStart(3, '0')}.txt`] = 'x\n';
  files['zz.txt'] = 'one\n';
  const vdir = installSkillPlugin('acme-tools', { skills: { many: files } });
  const before = loadSkillCatalog()[0];
  assert.deepEqual([before.valid, before.files], [true, 202]);
  writeFileSync(join(vdir, 'skills', 'many', 'zz.txt'), 'two, longer\n');
  assert.notEqual(loadSkillCatalog()[0].hash, before.hash);
});

test('the fingerprint stops where the walk stops: links never count as files, and a farm of folders is not walked again', { skip: !POSIX }, () => {
  const wdir = mkdtempSync(join(scratch, 'farm-'));
  installSkillPlugin('farm-tools', { linkedDir: wdir, skills: { links: { 'SKILL.md': skillMd('links'), 'zz.md': 'one\n' }, dirs: { 'SKILL.md': skillMd('dirs') } } });
  for (let i = 0; i < 400; i++) fs.symlinkSync(`nowhere-${i}`, join(wdir, 'skills', 'links', `l${String(i).padStart(3, '0')}`));
  for (let i = 0; i < 3000; i++) fs.mkdirSync(join(wdir, 'skills', 'dirs', `d${String(i).padStart(4, '0')}`));
  const before = loadSkillCatalog();
  assert.deepEqual(before.map((e) => [e.name, e.valid, e.problems.at(-1)]), [
    ['dirs', false, 'more than 1000 links and folders'], ['links', false, 'l399: broken symlink'],
  ]);
  writeFileSync(join(wdir, 'skills', 'links', 'zz.md'), 'two, longer\n');
  assert.notEqual(loadSkillCatalog()[1].hash, before[1].hash, 'an edit after 400 dangling links is seen');
  const orig = fs.readdirSync;
  let reads = 0;
  fs.readdirSync = (...args) => { reads++; return orig(...args); };
  syncBuiltinESMExports();
  try { loadSkillCatalog(); } finally { fs.readdirSync = orig; syncBuiltinESMExports(); }
  assert.equal(reads < 1100, true, `${reads} folders read by one more call`);
});

test('a plugin linked with linkPlugin lists its skills/<name>/SKILL.md as a valid skill', async () => {
  const wdir = writeMcpPlugin(join(scratch, 'acme'), {
    name: 'acme-tools', mcpServers: {},
    files: { 'skills/deploy-checklist/SKILL.md': '---\nname: deploy-checklist\ndescription: deploy-checklist for acme-tools\n---\n# deploy-checklist\n' },
  });
  await linkPlugin('acme-tools', wdir);
  const cat = loadSkillCatalog();
  assert.deepEqual(cat.map((e) => [e.id, e.valid, e.code, e.pluginEnabled, e.description, e.dir]), [[
    'skill:plugin:acme-tools/deploy-checklist', true, 'linked', true, 'deploy-checklist for acme-tools', join(realpathSync(wdir), 'skills', 'deploy-checklist'),
  ]]);
});

test('a skill holding a file that cannot be read is listed invalid with that problem; every other skill stays listed', { skip: !POSIX || process.getuid?.() === 0 }, () => {
  const wdir = mkdtempSync(join(scratch, 'locked-'));
  installSkillPlugin('locked-tools', { linkedDir: wdir, skills: { mine: { 'SKILL.md': skillMd('mine'), 'data/cache.json': '{}' }, fine: { 'SKILL.md': skillMd('fine') } } });
  const locked = join(wdir, 'skills', 'mine', 'data', 'cache.json');
  chmodSync(locked, 0);
  try {
    assert.deepEqual(loadSkillCatalog().map((e) => [e.id, e.valid, e.problems]), [
      ['skill:plugin:locked-tools/fine', true, []],
      ['skill:plugin:locked-tools/mine', false, ['data/cache.json: cannot be read (EACCES)']],
    ]);
  } finally {
    chmodSync(locked, 0o600);
  }
  assert.equal(loadSkillCatalog()[1].valid, true, 'readable again: its changed ctime re-inspects it');
});
