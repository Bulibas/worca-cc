// test/skills-mount.test.mjs
// Skills registry §4.1: materializeSkillMount — one generated plugin per set under <base>/<pluginName>, the manifest,
// a dereferenced copy (no symlinks, nested ones included), links out of a skill refused, explicit group-readable modes
// (0750 / 0640, exec bit kept, setgid kept), names re-validated before they become path segments, the limits and `.git`,
// the base guard (a `skills` folder, or one folder right under it: Ask mounts per message; never a .claude folder, the
// Claude config dir's skills / plugins or the skill library), and idempotent re-materialization.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { PLUGIN_MANIFEST, materializeSkillMount } from '../src/core/skills-registry/mount.mjs';
import { skillsDir } from '../src/core/skills-registry/library.mjs';
import { checkRows } from './helpers/rows.mjs';

const POSIX = process.platform !== 'win32';
const dirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'worca-skills-mount-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const put = (file, text, mode) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); if (mode) chmodSync(file, mode); };
/** Every path under `root` (relative, sorted), dirs with a trailing slash, symlinks marked `@`. */
const tree = (root) => {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const st = lstatSync(p);
      const rel = relative(root, p).split('\\').join('/');
      if (st.isSymbolicLink()) out.push(`${rel}@`);
      else if (st.isDirectory()) { out.push(`${rel}/`); walk(p); } else out.push(rel);
    }
  };
  walk(root);
  return out;
};
/** A skill folder with SKILL.md (+ files). */
const skill = (root, name, files = {}) => {
  const dir = join(root, name);
  put(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\nBody\n`);
  for (const [rel, [text, mode]] of Object.entries(files)) put(join(dir, rel), text, mode);
  return dir;
};
const mountRow = (setId, pluginName, name, dir) => ({ id: `skill:library:${name}`, name, qualifiedName: `${pluginName}:${name}`, pluginName,
  setId, setName: setId === 'general' ? 'General' : 'Billing', setSlug: setId === 'general' ? null : setId, dir, projects: [], description: '', plugin: null });
const resultOf = (rows) => {
  const plugins = [];
  for (const m of rows) {
    let p = plugins.find((x) => x.pluginName === m.pluginName);
    if (!p) plugins.push((p = { setId: m.setId, setName: m.setName, pluginName: m.pluginName, renamedPlugin: false, skills: [] }));
    p.skills.push(m.name);
  }
  return { mounted: rows, plugins, skipped: [], sets: [] };
};

test('materializeSkillMount: one plugin per set with its manifest and a copy of each skill; plugin dirs in name order', () => {
  const src = tmp();
  const deploy = skill(src, 'deploy-checklist', { 'scripts/collect.sh': ['#!/bin/sh\necho hi\n', 0o755], 'ref/notes.md': ['notes', 0o600] });
  const graph = skill(src, 'graphify');
  const base = join(tmp(), 'skills');
  const r = materializeSkillMount({ base, result: resultOf([mountRow('general', 'general', 'graphify', graph), mountRow('billing', 'billing', 'deploy-checklist', deploy)]) });
  assert.deepEqual(r.pluginDirs, [join(base, 'billing'), join(base, 'general')]);
  assert.deepEqual(r.plugins, [
    { setId: 'billing', pluginName: 'billing', dir: join(base, 'billing'), skills: ['deploy-checklist'] },
    { setId: 'general', pluginName: 'general', dir: join(base, 'general'), skills: ['graphify'] },
  ]);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(tree(base), [
    'billing/', 'billing/.claude-plugin/', 'billing/.claude-plugin/plugin.json', 'billing/skills/', 'billing/skills/deploy-checklist/',
    'billing/skills/deploy-checklist/SKILL.md', 'billing/skills/deploy-checklist/ref/', 'billing/skills/deploy-checklist/ref/notes.md',
    'billing/skills/deploy-checklist/scripts/', 'billing/skills/deploy-checklist/scripts/collect.sh',
    'general/', 'general/.claude-plugin/', 'general/.claude-plugin/plugin.json', 'general/skills/', 'general/skills/graphify/',
    'general/skills/graphify/SKILL.md',
  ]);
  assert.deepEqual(JSON.parse(readFileSync(join(base, 'billing', '.claude-plugin', 'plugin.json'), 'utf8')),
    { name: 'billing', version: '1.0.0', description: 'Worca set Billing' });
  assert.deepEqual(PLUGIN_MANIFEST('general', 'General'), { name: 'general', version: '1.0.0', description: 'Worca set General' });
  assert.equal(readFileSync(join(base, 'billing', 'skills', 'deploy-checklist', 'scripts', 'collect.sh'), 'utf8'), '#!/bin/sh\necho hi\n');
  if (POSIX) {
    assert.equal(statSync(join(base, 'billing', 'skills', 'deploy-checklist', 'scripts', 'collect.sh')).mode & 0o777, 0o750, 'exec bit kept');
    assert.equal(statSync(join(base, 'billing', 'skills', 'deploy-checklist', 'ref', 'notes.md')).mode & 0o777, 0o640, 'group-readable');
  }
});

test('materializeSkillMount: folders 0750, files 0640 / 0750 whatever the umask or the source modes (agent users read through the group)', { skip: POSIX ? false : 'POSIX modes' }, () => {
  const src = tmp();
  const deploy = skill(src, 'deploy-checklist', { 'scripts/collect.sh': ['#!/bin/sh\n', 0o700], 'ref/notes.md': ['n', 0o600] });
  const base = join(tmp(), 'skills');
  const prev = process.umask(0o077);
  try { materializeSkillMount({ base, result: resultOf([mountRow('billing', 'billing', 'deploy-checklist', deploy)]) }); }
  finally { process.umask(prev); }
  const modes = { '.': (statSync(base).mode & 0o777).toString(8) };
  for (const rel of tree(base)) modes[rel.replace(/\/$/, '')] = (statSync(join(base, rel)).mode & 0o777).toString(8);
  assert.deepEqual(modes, {
    '.': '750', billing: '750', 'billing/.claude-plugin': '750', 'billing/.claude-plugin/plugin.json': '640', 'billing/skills': '750',
    'billing/skills/deploy-checklist': '750', 'billing/skills/deploy-checklist/SKILL.md': '640', 'billing/skills/deploy-checklist/ref': '750',
    'billing/skills/deploy-checklist/ref/notes.md': '640', 'billing/skills/deploy-checklist/scripts': '750',
    'billing/skills/deploy-checklist/scripts/collect.sh': '750',
  });
});

test('materializeSkillMount: under a setgid shared folder every mount folder keeps the setgid bit (Linux)', { skip: process.platform === 'linux' ? false : 'setgid inheritance is a Linux rule' }, (t) => {
  const src = tmp();
  const graph = skill(src, 'graphify', { 'ref/a.md': ['a'] });
  const shared = tmp();
  chmodSync(shared, 0o2770);
  if (!(statSync(shared).mode & 0o2000)) { t.skip('this filesystem drops the setgid bit'); return; }
  const base = join(shared, 'skills');
  materializeSkillMount({ base, result: resultOf([mountRow('general', 'general', 'graphify', graph)]) });
  for (const rel of ['.', ...tree(base).filter((p) => p.endsWith('/'))]) {
    assert.equal(statSync(join(base, rel)).mode & 0o2777, 0o2750, `${rel} keeps setgid`);
  }
});

test('materializeSkillMount: links are dereferenced, never copied; a link out of the skill, a loop or a broken link drops that skill only', { skip: POSIX ? false : 'symlinks need privileges on Windows' }, async () => {
  const src = tmp();
  const outside = join(src, 'outside.txt');
  put(outside, 'secret');
  const good = skill(src, 'good', { 'data/real.txt': ['real'], 'nested/deeper/target.md': ['deep'] });
  symlinkSync(join(good, 'data', 'real.txt'), join(good, 'alias.txt'));
  symlinkSync(join(good, 'data'), join(good, 'data-link'));
  symlinkSync(join('deeper', 'target.md'), join(good, 'nested', 'rel-link.md'));          // a relative link, nested
  symlinkSync(join(good, 'alias.txt'), join(good, 'nested', 'deeper', 'chain.txt'));     // a link to a link
  const escaping = skill(src, 'escaping');
  symlinkSync(outside, join(escaping, 'leak.txt'));
  const looping = skill(src, 'looping');
  symlinkSync(looping, join(looping, 'self'));
  const broken = skill(src, 'broken');
  symlinkSync(join(src, 'gone'), join(broken, 'dangling'));
  const base = join(tmp(), 'skills');
  const r = materializeSkillMount({ base, result: resultOf(['good', 'escaping', 'looping', 'broken']
    .map((n) => mountRow('billing', 'billing', n, join(src, n)))) });
  await checkRows([
    { name: 'only the good skill mounts', run: () => assert.deepEqual(r.plugins.map((p) => p.skills), [['good']]) },
    { name: 'no symlink anywhere in the mount; links became regular copies', run: () => {
      const t = tree(base);
      assert.ok(!t.some((p) => p.endsWith('@')), t.join('\n'));
      assert.ok(t.includes('billing/skills/good/alias.txt') && t.includes('billing/skills/good/data-link/real.txt'));
      assert.equal(readFileSync(join(base, 'billing', 'skills', 'good', 'alias.txt'), 'utf8'), 'real');
      assert.equal(readFileSync(join(base, 'billing', 'skills', 'good', 'nested', 'rel-link.md'), 'utf8'), 'deep');
      assert.equal(readFileSync(join(base, 'billing', 'skills', 'good', 'nested', 'deeper', 'chain.txt'), 'utf8'), 'real');
    } },
    { name: 'the refused skills leave no folder and name their reason', run: () => {
      assert.deepEqual(r.failed.map((f) => f.name), ['broken', 'escaping', 'looping']);
      assert.match(r.failed.find((f) => f.name === 'escaping').error, /out of the skill folder/);
      assert.match(r.failed.find((f) => f.name === 'looping').error, /loops back/);
      assert.match(r.failed.find((f) => f.name === 'broken').error, /broken link/);
      for (const n of ['escaping', 'looping', 'broken']) assert.equal(existsSync(join(base, 'billing', 'skills', n)), false);
    } },
  ]);
});

test('materializeSkillMount: names are re-validated before they become path segments; size limits apply again', async () => {
  const src = tmp();
  const ok = skill(src, 'ok');
  const big = skill(src, 'big', { 'blob.bin': [Buffer.alloc(1048577)] });
  const base = join(tmp(), 'skills');
  const r = materializeSkillMount({ base, result: {
    plugins: [
      { setId: 'a', setName: 'A', pluginName: '../escape', renamedPlugin: false, skills: ['ok'] },
      { setId: 'b', setName: 'B', pluginName: 'Billing', renamedPlugin: false, skills: ['ok'] },
      { setId: 'c', setName: 'C', pluginName: 'c', renamedPlugin: false, skills: ['ok'] },
      { setId: 'd', setName: 'D', pluginName: 'c', renamedPlugin: false, skills: ['ok'] },
      { setId: 'e', setName: 'E', pluginName: 'e', renamedPlugin: false, skills: ['big'] },
    ],
    mounted: [
      { ...mountRow('a', '../escape', 'ok', ok) }, { ...mountRow('b', 'Billing', 'ok', ok) },
      { ...mountRow('c', 'c', '../../evil', ok) }, { ...mountRow('c', 'c', 'synced', ok) }, { ...mountRow('c', 'c', 'big', big) },
      { ...mountRow('c', 'c', 'ok', ok) }, { ...mountRow('c', 'c', 'ok', ok) }, { ...mountRow('c', 'c', 'rel', 'relative/dir') },
      { ...mountRow('e', 'e', 'big', big) },
    ],
  } });
  await checkRows([
    { name: 'only c/ok mounts', run: () => assert.deepEqual(r.plugins.map((p) => [p.pluginName, p.skills]), [['c', ['ok']]]) },
    { name: 'bad plugin names and a repeated plugin are refused: one row per skill they carried, else one name-less row', run: () => {
      assert.deepEqual(r.failed.filter((f) => f.error === 'not a usable plugin name').map((f) => [f.setId, f.pluginName, f.name]),
        [['a', '../escape', 'ok'], ['b', 'Billing', 'ok'], ['d', 'c', null]]);
    } },
    { name: 'bad / reserved / repeated skill names, a relative folder and an over-limit skill are refused', run: () => {
      assert.deepEqual(r.failed.filter((f) => f.pluginName === 'c' && f.name !== null).map((f) => `${f.name}: ${f.error}`), [
        '../../evil: not a usable skill name', 'big: over the skill size limits', 'ok: not a usable skill name',
        'rel: no skill folder', 'synced: not a usable skill name']);
    } },
    { name: 'a plugin whose every skill fails is not written at all', run: () => {
      assert.deepEqual(r.failed.filter((f) => f.pluginName === 'e').map((f) => `${f.name}: ${f.error}`), ['big: over the skill size limits']);
      assert.equal(existsSync(join(base, 'e')), false);
    } },
    { name: 'nothing was written outside the base', run: () => {
      assert.deepEqual(readdirSync(join(base, '..')), ['skills']);
      assert.ok(tree(base).every((p) => p.startsWith('c/')), tree(base).join('\n'));
    } },
  ]);
});

test('materializeSkillMount: each limit bites on its own, a 65-character name is refused, .git is never copied or counted, special files are skipped', async () => {
  const src = tmp();
  const many = skill(src, 'many', Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`f/${i}.txt`, ['x']])));
  const heavy = skill(src, 'heavy', Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`blob${i}.bin`, [Buffer.alloc(1048576)]])));
  const gitty = skill(src, 'gitty', { '.git/config': ['[remote "origin"]\n\turl = https://u:ghp_SECRET@example.com/x.git\n'],
    ...Object.fromEntries(Array.from({ length: 301 }, (_, i) => [`.git/objects/${i}`, ['o']])) });
  const ok = skill(src, 'ok');
  if (POSIX) execFileSync('mkfifo', [join(ok, 'pipe')]);   // copying a fifo would block the synchronous mount forever
  const long = 'a'.repeat(65);
  const base = join(tmp(), 'skills');
  const r = materializeSkillMount({ base, result: resultOf([mountRow('billing', 'billing', 'many', many),
    mountRow('billing', 'billing', 'heavy', heavy), mountRow('billing', 'billing', 'gitty', gitty),
    mountRow('billing', 'billing', long, ok), mountRow('billing', 'billing', 'ok', ok)]) });
  await checkRows([
    { name: 'the file count and the total size each refuse a skill; so does a name over 64 characters', run: () => {
      assert.deepEqual(r.failed.map((f) => `${f.name}: ${f.error}`),
        [`${long}: not a usable skill name`, 'heavy: over the skill size limits', 'many: over the skill size limits']);
    } },
    { name: '.git is skipped (never copied, never counted); a fifo is skipped', run: () => {
      assert.deepEqual(r.plugins.map((p) => p.skills), [['gitty', 'ok']]);
      assert.ok(!tree(base).some((p) => p.includes('.git')), tree(base).join('\n'));
      assert.deepEqual(tree(join(base, 'billing', 'skills', 'ok')), ['SKILL.md']);
    } },
  ]);
});

test('materializeSkillMount: the base guard, an empty result, and idempotent re-materialization', async () => {
  const src = tmp();
  const graph = skill(src, 'graphify');
  const result = resultOf([mountRow('general', 'general', 'graphify', graph)]);
  await checkRows([
    { name: 'a base that is relative, not named skills, or two folders under skills is refused before anything is removed', run: () => {
      const refused = /base must be an absolute path that is or sits right under a "skills" folder/;
      const precious = tmp();
      put(join(precious, 'keep.txt'), 'x');
      put(join(precious, 'skills', 'a', 'b', 'keep.txt'), 'y');
      assert.throws(() => materializeSkillMount({ base: precious, result }), refused);
      assert.throws(() => materializeSkillMount({ base: join(precious, 'skills', 'a', 'b'), result }), refused);
      assert.equal(readFileSync(join(precious, 'keep.txt'), 'utf8'), 'x');
      assert.equal(readFileSync(join(precious, 'skills', 'a', 'b', 'keep.txt'), 'utf8'), 'y');
      // Relative bases resolve against the cwd (the checkout, which has a real skills/ folder): only names that cannot
      // exist and an empty result, so even a broken guard can neither delete nor write anything here.
      for (const base of [join('p3-mount-guard-never-exists', 'skills'), '', null]) {
        assert.throws(() => materializeSkillMount({ base, result: { mounted: [], plugins: [] } }), refused);
      }
    } },
    { name: 'a base in a .claude folder, the Claude config dir\'s skills or plugins, or the skill library, or not normalized, is refused before anything is removed; P4\'s and P6\'s bases are not', run: () => {
      const refused = /base must be an absolute path that is or sits right under a "skills" folder/;
      const root = tmp();
      const cfg = tmp();
      const home = join(tmp(), 'skills', 'worca-home');   // so a `skills` base can hold the library
      const bases = [join(root, '.claude', 'skills', 'graphify'), join(root, '.claude', 'skills'), join(root, '.CLAUDE', 'skills'),
        join(root, 'repo', '.claude', 'skills'), [root, 'x', '..', 'skills'].join(sep), `${join(root, 'skills')}${sep}`];
      for (const b of bases) put(join(b, 'keep.txt'), 'mine');
      put(join(cfg, 'skills', 'keep.txt'), 'cfg');
      const prev = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, WORCA_HOME: process.env.WORCA_HOME };
      process.env.CLAUDE_CONFIG_DIR = cfg;
      process.env.WORCA_HOME = home;
      try {
        const lib = skillsDir();
        put(join(lib, 'deploy', 'SKILL.md'), 'library');
        const cfgPlugin = join(cfg, 'plugins', 'cache', 'acme', 'billing', '1.0.0', 'skills');
        put(join(cfgPlugin, 'keep.txt'), 'plugin');
        for (const b of [...bases, join(cfg, 'skills'), cfgPlugin, lib, join(lib, 'deploy'), join(home, '..')]) {
          assert.throws(() => materializeSkillMount({ base: b, result }), refused, b);
        }
        for (const b of bases) assert.equal(readFileSync(join(b, 'keep.txt'), 'utf8'), 'mine');
        assert.equal(readFileSync(join(cfg, 'skills', 'keep.txt'), 'utf8'), 'cfg');
        assert.equal(readFileSync(join(cfgPlugin, 'keep.txt'), 'utf8'), 'plugin');
        assert.equal(readFileSync(join(lib, 'deploy', 'SKILL.md'), 'utf8'), 'library');
        const p4 = join(home, 'store', 'proj', 'pipelines', 'run-1', 'skills');
        const p6 = join(home, 'ask', 'ask_1', 'skills', 'askm_1');
        for (const b of [p4, p6]) assert.deepEqual(materializeSkillMount({ base: b, result }).pluginDirs, [join(b, 'general')]);
        // A deployment whose CLAUDE_CONFIG_DIR holds the Worca home (one volume): only its skills / plugins are off limits.
        const vol = tmp();
        process.env.CLAUDE_CONFIG_DIR = vol;
        process.env.WORCA_HOME = join(vol, 'worca');
        const p4vol = join(vol, 'worca', 'store', 'proj', 'pipelines', 'run-1', 'skills');
        assert.deepEqual(materializeSkillMount({ base: p4vol, result }).pluginDirs, [join(p4vol, 'general')]);
      } finally {
        for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      }
    } },
    { name: 'an Ask per-message base (<home>/ask/<thread>/skills/<message>) is accepted; only its own folder is rebuilt', run: () => {
      const skills = join(tmp(), 'skills');
      put(join(skills, 'askm_0000000b', 'keep.txt'), 'another message');
      const b = join(skills, 'askm_0000000a');
      assert.deepEqual(materializeSkillMount({ base: b, result }).pluginDirs, [join(b, 'general')]);
      assert.equal(readFileSync(join(skills, 'askm_0000000b', 'keep.txt'), 'utf8'), 'another message');
    } },
    { name: 'an empty result removes the base and returns no plugin dirs', run: () => {
      const base = join(tmp(), 'skills');
      put(join(base, 'stale', 'x.txt'), 'old');
      assert.deepEqual(materializeSkillMount({ base, result: { mounted: [], plugins: [] } }), { base, pluginDirs: [], plugins: [], failed: [] });
      assert.equal(existsSync(base), false);
    } },
    { name: 'a second call rebuilds the same tree and drops what is no longer resolved', run: () => {
      const base = join(tmp(), 'skills');
      const first = materializeSkillMount({ base, result });
      put(join(base, 'old-set', 'skills', 'x', 'SKILL.md'), 'stale');
      put(join(base, 'general', 'skills', 'graphify', 'agent-edit.md'), 'an agent wrote here');
      const second = materializeSkillMount({ base, result });
      assert.deepEqual(second, first);
      assert.deepEqual(tree(base), ['general/', 'general/.claude-plugin/', 'general/.claude-plugin/plugin.json', 'general/skills/',
        'general/skills/graphify/', 'general/skills/graphify/SKILL.md']);
    } },
  ]);
});
