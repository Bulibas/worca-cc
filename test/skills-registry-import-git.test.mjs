// test/skills-registry-import-git.test.mjs — a git URL pinned to a commit (skills registry design §2a F5, §5):
// shallow fetch from a local bare repo over file:// (no network), the folder pick, ref pinning, refusals before
// git runs, the fetchGit seam, nothing left behind on failure.
import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { useTempHome } from './helpers/temp-home.mjs';
import { copyFixture, writeSkill, skillMd, POSIX } from './helpers/skills-registry-fixtures.mjs';
import { stageImport } from '../src/core/skills-registry/import.mjs';
import { SKILL_LIMITS } from '../src/core/skills-registry/inspect.mjs';
import { commitImport, stagesDir, SkillLibraryError } from '../src/core/skills-registry/library.mjs';

const root = useTempHome(after);
beforeEach(() => { process.env.WORCA_HOME = mkdtempSync(join(root, 'h-')); });

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
  { cwd, encoding: 'utf8' }).trim();
const stages = () => (existsSync(stagesDir()) ? readdirSync(stagesDir()) : []);
const rejects = (p, status, re) => assert.rejects(p, (e) => e instanceof SkillLibraryError && e.status === status && re.test(e.message));

/** A work repo published to a bare repo → { url (file://), bare, work, push(files, msg) → sha, first }. */
function repo(name, files) {
  const work = mkdtempSync(join(root, `${name}-`));
  git(work, 'init', '-q', '-b', 'main');
  const bare = join(root, `${name}-${Date.now()}.git`);
  const push = (more, msg) => {
    writeSkill(work, more);
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', msg);
    git(work, 'push', '-q', bare, 'main');
    return git(work, 'rev-parse', 'HEAD');
  };
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  const first = push(files, 'one');
  return { url: pathToFileURL(bare).href, bare, work, push, first };
}

let multi;
let single;
before(() => {
  multi = repo('multi', {
    'README.md': '# skills\n',
    'skills/release-notes/SKILL.md': skillMd('release-notes', 'Drafts release notes.'),
    'skills/release-notes/scripts/collect.sh': '#!/bin/sh\ngit log --oneline -5\n',
    'skills/other/SKILL.md': skillMd('other'),
  });
  single = repo('single', { 'tools/x.txt': 'x\n' });
  copyFixture('alpha', single.work, 'only');
  single.first = single.push({}, 'alpha');
});

test('a folder of a repo at the remote HEAD: staged with url, ref, folder and the commit it is pinned to', async () => {
  const s = await stageImport({ kind: 'git', url: multi.url, subdir: 'skills/release-notes' });
  assert.equal(s.name, 'release-notes');
  assert.deepEqual(s.inspection.files.map((f) => f.path), ['SKILL.md', 'scripts/collect.sh']);
  assert.deepEqual(s.inspection.problems, []);
  const origin = { kind: 'git', url: multi.url, ref: null, subdir: 'skills/release-notes', sha: multi.first };
  assert.deepEqual(JSON.parse(readFileSync(`${s.dir}.json`, 'utf8')), { origin });
  assert.equal(existsSync(`${s.dir}.git`), false, 'the fetch scratch is removed');
  const typed = await stageImport({ kind: 'git', url: multi.url, subdir: './skills/release-notes/' });
  assert.equal(JSON.parse(readFileSync(`${typed.dir}.json`, 'utf8')).origin.subdir, 'skills/release-notes', 'a typed ./ and trailing / are dropped');
  assert.deepEqual((await commitImport(s.dir, s.name)).origin, origin);
});

test('no folder given: the root when it holds a SKILL.md, else the only one; several → pick one (candidates listed)', async () => {
  const s = await stageImport({ kind: 'git', url: single.url, subdir: '' });
  assert.deepEqual([s.name, JSON.parse(readFileSync(`${s.dir}.json`, 'utf8')).origin.subdir], ['alpha', 'only']);
  await assert.rejects(stageImport({ kind: 'git', url: multi.url }), (e) => e.status === 400
    && /pick the skill's folder in .* at [0-9a-f]{7}: skills\/other, skills\/release-notes$/.test(e.message)
    && e.candidates.join() === 'skills/other,skills/release-notes');
  await rejects(stageImport({ kind: 'git', url: multi.url, subdir: 'skills' }), 400, /no SKILL.md in folder "skills" of/);
  const odd = repo('odd', { '-odd/SKILL.md': skillMd('odd') });
  await rejects(stageImport({ kind: 'git', url: odd.url }), 400, /^no SKILL.md in a folder Worca can import in file:.* at [0-9a-f]{7}$/); // never picked: an update could not name it
  odd.push({ 'good/SKILL.md': skillMd('good') }, 'two');
  await assert.rejects(stageImport({ kind: 'git', url: odd.url }), (e) => e.status === 400 && /: good$/.test(e.message) && e.candidates.join() === 'good',
    'only folders the subdir check accepts are offered');
  assert.deepEqual(stages().sort(), [s.stage, `${s.stage}.json`], 'a refused fetch leaves no stage');
});

test('a ref pins the import: a commit or a tag', async () => {
  const second = multi.push({ 'skills/release-notes/SKILL.md': skillMd('release-notes', 'Second version.') }, 'two');
  git(multi.work, 'tag', 'v2');
  git(multi.work, 'push', '-q', multi.bare, 'v2');
  const old = await stageImport({ kind: 'git', url: multi.url, ref: multi.first, subdir: 'skills/release-notes' });
  assert.equal(old.inspection.description, 'Drafts release notes.');
  assert.equal(JSON.parse(readFileSync(`${old.dir}.json`, 'utf8')).origin.sha, multi.first);
  const tagged = await stageImport({ kind: 'git', url: multi.url, ref: 'v2', subdir: 'skills/release-notes' });
  assert.deepEqual([tagged.inspection.description, JSON.parse(readFileSync(`${tagged.dir}.json`, 'utf8')).origin],
    ['Second version.', { kind: 'git', url: multi.url, ref: 'v2', subdir: 'skills/release-notes', sha: second }]);
  await rejects(stageImport({ kind: 'git', url: multi.url, ref: 'no-such-branch', subdir: 'skills/other' }), 400,
    /^git: could not fetch no-such-branch from file:.*: /);
});

test('refused before git runs: credentials in the URL, option-shaped URLs and refs, paths out of the repo', async () => {
  let ran = false;
  const fetchGit = async () => { ran = true; return { sha: 'x', subdir: null, candidates: [] }; };
  const tok = 'gh' + 'p_' + 'A1b2C3d4E5'.repeat(3);
  const cases = [
    [{ url: 'https://user:ghp_secret@github.com/acme/skills.git' }, /password or token in the URL/],
    [{ url: `https://${tok}@github.com/acme/skills.git` }, /password or token in the URL/],
    [{ url: 'https://alice@bitbucket.org/acme/skills.git' }, /password or token in the URL/],
    [{ url: 'https://example.com/acme/skills.git?private_token=abc' }, /password or token in the URL/],
    [{ url: 'ssh://alice:hunter2@example.com/acme/skills.git' }, /password or token in the URL/],
    [{ url: `${tok}@example.com:acme/skills.git` }, /password or token in the URL/],
    [{ url: `ssh://${tok}@example.com/acme/skills.git` }, /password or token in the URL/],
    [{ url: 'https://github.com/acme/skills.git#access_token=abc' }, /password or token in the URL/],
    [{ url: 'file://alice:hunter2@localhost/srv/skills.git' }, /^git URL: not a valid URL$/],
    [{ url: '-uhttps://x' }, /git URL: use/],
    [{ url: '--upload-pack=touch /tmp/x' }, /git URL: use/],
    [{ url: 'ext::sh -c touch% /tmp/x' }, /git URL: use/],
    [{ url: '/local/path' }, /git URL: use/],
    [{ url: 'https://x/a b' }, /git URL: use/],
    [{ url: 'https://CORP\\jdoe:Secret1@tfs.example.com/acme/skills' }, /git URL: use/],
    [{ url: `https://${tok}\\@github.com/acme/skills.git` }, /git URL: use/],
    [{ url: 'ssh://example.com?alice:hunter2@other.example.com/acme/skills.git' }, /password or token in the URL/],
    [{ url: 'ssh://alice%3Ahunter2@example.com/acme/skills.git' }, /password or token in the URL/],
    [{ url: 'ssh://alice%3Ahunter2%40example.com/acme/skills.git' }, /^git URL: no %-escape in the user name or host/],
    [{ url: `ssh://${tok}%40github.com/acme/skills.git` }, /^git URL: no %-escape in the user name or host/],
    [{ url: 'ssh://evil.example%2F@github.com/acme/skills.git' }, /^git URL: no %-escape in the user name or host/],
    [{ url: 'git://evil.example%2F@github.com/acme/skills.git' }, /^git URL: no %-escape in the user name or host/],
    [{ url: 'ssh://u%0Aname@example.com/acme/skills.git' }, /^git URL: no %-escape in the user name or host/],
    [{ url: 'ssh://[evil.example]@github.com/acme/skills.git' }, /^git URL: a \[ or \] only around an IPv6 address/],
    [{ url: 'ssh://git@[127.0.0.1]@github.com/acme/skills.git' }, /^git URL: a \[ or \] only around an IPv6 address/],
    [{ url: 'git://[127.0.0.1]@github.com/acme/skills.git' }, /^git URL: a \[ or \] only around an IPv6 address/],
    [{ url: `ssh://u${String.fromCharCode(27)}[31m@example.com/acme/skills.git` }, /git URL: use/],
    [{ url: `git@example.com:acme/${String.fromCharCode(1)}skills.git` }, /git URL: use/],
    [{ url: `ssh://u${String.fromCharCode(0x9b)}31m@example.com/acme/skills.git` }, /git URL: use/],
    [{ url: `git@example.com:${tok}@[127.0.0.1]:acme/skills.git` }, /git URL: use/],
    [{ url: 'file://github.com/srv/skills.git' }, /^git URL: a file:\/\/ URL names no host/],
    [{ url: 'https:///github.com/acme/skills.git' }, /git URL: use/],
    [{ url: 'git:///acme/skills.git' }, /git URL: use/],
    [{ url: `https://${String.fromCodePoint(0xff47)}ithub.com/acme/skills.git` }, /^git URL: the user name and host must be plain ASCII/],
    [{ url: `ssh://j${String.fromCodePoint(0xf6)}rg@example.com/acme/skills.git` }, /^git URL: the user name and host must be plain ASCII/],
    [{ url: 'git://alice@example.com/acme/skills.git' }, /password or token in the URL/],
    [{ url: multi.url, ref: '--output=/tmp/x' }, /ref: not a branch/],
    [{ url: multi.url, ref: 'a..b' }, /ref: not a branch/],
    [{ url: multi.url, subdir: '../x' }, /folder: not a path inside/],
    [{ url: multi.url, subdir: '-x/y' }, /folder: not a path inside/],
    [{ url: multi.url, subdir: 'a//b' }, /folder: not a path inside/],
  ];
  for (const [src, re] of cases) await rejects(stageImport({ kind: 'git', ...src }, { fetchGit }), 400, re);
  assert.equal(ran, false);
  assert.deepEqual(stages(), []);
  for (const url of ['git@github.com:acme/skills.git', 'ssh://git@example.com:2222/acme/skills.git', 'ssh://git@example.com/acme/my%20skills.git', 'ssh://git@[::1]/acme/skills.git',
    'https://github.com/acme/sk-agent-skills-collection.git', 'git@github.com:acme/sk-skills-for-claude-code.git', 'file://localhost/srv/skills.git']) {
    assert.equal((await stageImport({ kind: 'git', url, subdir: 'x' }, {
      fetchGit: async ({ dest }) => { writeSkill(dest, { 'SKILL.md': skillMd('x') }); return { sha: 'f'.repeat(40), subdir: 'x', candidates: ['x'] }; },
    })).name, 'x', `${url}: an ssh user name without a password, an IPv6 host, or a repository named sk-…, is accepted`);
  }
});

test('a typed folder, or a URL, over its length cap is refused before any pattern runs; a run of slashes under it is trimmed', async () => {
  let ran = false;
  const fetchGit = async ({ dest }) => { ran = true; writeSkill(dest, { 'SKILL.md': skillMd('slashes') }); return { sha: 'f'.repeat(40), subdir: '', candidates: [''] }; };
  const t0 = process.cpuUsage();
  await rejects(stageImport({ kind: 'git', url: 'https://example.com/acme/skills.git', subdir: '/'.repeat(8 << 20) }, { fetchGit }), 400,
    /^folder: at most 1024 characters$/);
  await rejects(stageImport({ kind: 'git', url: `https://example.com/${'a@'.repeat(4 << 20)}` }, { fetchGit }), 400, /^git URL: at most 4096 characters$/);
  const cpu = process.cpuUsage(t0);
  const ms = (cpu.user + cpu.system) / 1000;
  assert.equal(ms < 500, true, `${ms} ms of CPU`);
  assert.equal(ran, false);
  await rejects(stageImport({ kind: 'git', url: 'https://example.com/acme/skills.git', subdir: `a${'/'.repeat(1000)}a` }, { fetchGit }), 400,
    /folder: not a path inside/);
  const s = await stageImport({ kind: 'git', url: `https://example.com/acme/slashes${'/'.repeat(4000)}`, subdir: `./skill${'/'.repeat(1000)}` }, {
    fetchGit: async (a) => { writeSkill(a.dest, { 'SKILL.md': skillMd('slashes') }); return { sha: 'f'.repeat(40), subdir: a.subdir, candidates: [a.subdir] }; },
  });
  assert.deepEqual([s.name, JSON.parse(readFileSync(`${s.dir}.json`, 'utf8')).origin.subdir], ['slashes', 'skill']);
});

test('a git folder over the limits is refused from the tree, before anything is extracted', async () => {
  const files = { 'many/SKILL.md': skillMd('many'), 'huge/SKILL.md': skillMd('huge'), 'huge/blob.bin': Buffer.alloc(SKILL_LIMITS.totalBytes + 1) };
  for (let i = 0; i < SKILL_LIMITS.files; i++) files[`many/f${i}.txt`] = 'x\n';
  // four files 260 folders deep: 1040 folders (one shared tree object would keep such a repository tiny); three, and
  // 250 links: 1030 links and folders; 1001 submodules, which git archive writes as empty folders
  files['deep/SKILL.md'] = skillMd('deep');
  for (let c = 0; c < 4; c++) files[`deep/c${c}/${'a/'.repeat(260)}f`] = 'x\n';
  files['linked/SKILL.md'] = skillMd('linked');
  for (let c = 0; c < 3; c++) files[`linked/c${c}/${'a/'.repeat(260)}f`] = 'x\n';
  files['subs/SKILL.md'] = skillMd('subs');
  // under the bound: 702 folders, 100 files in the deepest one (each folder counts once, however many files it holds)
  files['okdeep/SKILL.md'] = skillMd('okdeep');
  files[`okdeep/c1/${'a/'.repeat(350)}f`] = 'x\n';
  for (let i = 0; i < 100; i++) files[`okdeep/c0/${'a/'.repeat(350)}f${i}`] = 'x\n';
  const big = repo('big', files);
  if (POSIX) {
    for (let i = 0; i < 250; i++) symlinkSync('SKILL.md', join(big.work, 'linked', `l${i}.md`));
    big.push({}, 'links');
  }
  execFileSync('git', ['update-index', '--index-info'], { cwd: big.work, input: Array.from({ length: 1001 }, (_, i) => `160000 ${big.first}\tsubs/m${i}\n`).join('') });
  git(big.work, 'commit', '-q', '-m', 'submodules');
  git(big.work, 'push', '-q', big.bare, 'main');
  const cases = [['many', 'more than 300 files'], ['huge', 'larger than 8 MB in total'], ['deep', 'more than 1000 links and folders'],
    ...(POSIX ? [['linked', 'more than 1000 links and folders']] : []), ['subs', 'more than 1000 links and folders']];
  for (const [subdir, problem] of cases) {
    await assert.rejects(stageImport({ kind: 'git', url: big.url, subdir }), (e) => e instanceof SkillLibraryError && e.status === 400
      && e.message === `too large for a skill (at most 300 files, 1000 links and folders and 8 MB): ${problem}` && e.problems.join() === problem, subdir);
  }
  assert.deepEqual(stages(), []);
  const ok = await stageImport({ kind: 'git', url: big.url, subdir: 'okdeep' });
  assert.deepEqual([ok.inspection.problems, ok.inspection.files.length], [[], 102]);
});

/** A bare repo whose trees are written entry by entry (names as raw bytes) → { mktree(rows), md(name), subs(names), publish(tree) → url }. */
function rawRepo(name) {
  const bare = join(mkdtempSync(join(root, `${name}-`)), 'r.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  const entry = ([mode, type, sha, n]) => Buffer.concat([Buffer.from(`${mode} ${type} ${sha}\t`), Buffer.from(n), Buffer.from([0])]);
  const mktree = (rows) => execFileSync('git', ['--git-dir', bare, 'mktree', '-z', '--missing'], { input: Buffer.concat(rows.map(entry)) }).toString().trim();
  const md = (n) => execFileSync('git', ['--git-dir', bare, 'hash-object', '-w', '--stdin'], { input: skillMd(n) }).toString().trim();
  const subs = (names) => names.map((n) => ['160000', 'commit', '1'.repeat(40), n]); // submodule commits need not exist
  const publish = (tree) => {
    git(root, '--git-dir', bare, 'update-ref', 'refs/heads/main', git(root, '--git-dir', bare, 'commit-tree', tree, '-m', name));
    return pathToFileURL(bare).href;
  };
  return { mktree, md, subs, publish };
}

test('a git folder is counted by the bytes of its names: names that are not UTF-8 never read as one folder', async () => {
  const { mktree, md, subs, publish } = rawRepo('bytes');
  // 1001 submodules named by two bytes that are not UTF-8: decoded as text, every name reads U+FFFD U+FFFD
  const bytes = mktree([['100644', 'blob', md('bytes'), 'SKILL.md'],
    ...subs(Array.from({ length: 1001 }, (_, i) => Buffer.from([0x80 + (i >> 7), 0x80 + (i & 0x7f)])))]);
  // 1000 submodules, at the bound, in a folder named outside ASCII (its entries are cut off by its bytes, not its letters)
  const naive = `na${String.fromCodePoint(0xef)}ve`;
  const full = mktree([['100644', 'blob', md('naive'), 'SKILL.md'], ...subs(Array.from({ length: 1000 }, (_, i) => `m${i}`))]);
  const url = publish(mktree([['040000', 'tree', bytes, 'bytes'], ['040000', 'tree', full, naive]]));
  await assert.rejects(stageImport({ kind: 'git', url, subdir: 'bytes' }), (e) => e instanceof SkillLibraryError && e.status === 400
    && e.message === 'too large for a skill (at most 300 files, 1000 links and folders and 8 MB): more than 1000 links and folders');
  assert.deepEqual(stages(), []);
  const ok = await stageImport({ kind: 'git', url, subdir: naive });
  assert.deepEqual([ok.name, ok.inspection.problems], ['naive', []]);
});

// git on macOS (core.precomposeunicode, which git init turns on there) reads a decomposed (NFD) folder name given as a
// path as its composed (NFC) twin. A twin's entries, cut off by the decomposed name's longer bytes, would all read as one
// folder, and git archive would extract the twin.
const nfd = `e${String.fromCodePoint(0x301)}`.repeat(3);
const twinRepo = (withTwin = true) => {
  const { mktree, md, subs, publish } = rawRepo(withTwin ? 'twin' : 'nfd');
  const skill = mktree([['100644', 'blob', md('nfd'), 'SKILL.md']]);
  // 1001 submodules whose names differ only in the three bytes the decomposed name is longer by
  const twin = () => mktree(subs(Array.from({ length: 1001 }, (_, i) => `${i.toString(36).padStart(3, '0')}T`)));
  return publish(mktree([['040000', 'tree', skill, nfd], ...(withTwin ? [['040000', 'tree', twin(), nfd.normalize('NFC')]] : [])]));
};

test('a folder named in decomposed Unicode is fetched by its own bytes, never as its composed twin', async () => {
  const url = twinRepo();
  const alone = twinRepo(false);
  for (const [u, subdir] of [[url, null], [url, nfd], [alone, null], [alone, nfd]]) {
    const s = await stageImport({ kind: 'git', url: u, subdir });
    assert.deepEqual([s.name, s.inspection.problems, readdirSync(s.dir), JSON.parse(readFileSync(`${s.dir}.json`, 'utf8')).origin.subdir],
      ['nfd', [], ['SKILL.md'], nfd], `${u === url ? 'twin' : 'alone'} ${subdir === null ? 'picked' : 'typed'}`);
  }
});

test('a git listing outside the picked folder is refused before anything is extracted, whatever git matched', { skip: process.platform !== 'darwin' && 'git precomposes paths only on macOS' }, async () => {
  const url = twinRepo();
  const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.precomposeunicode', GIT_CONFIG_VALUE_0: 'true' };
  Object.assign(process.env, env); // outranks the scratch repo's own config: git reads the composed twin again
  try {
    await rejects(stageImport({ kind: 'git', url }), 400, /^git: folder ".+" lists files of another folder/);
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
  }
  assert.deepEqual(stages(), []);
});

test('the fetchGit seam: its arguments; a failure becomes a 400 and leaves nothing behind', async () => {
  let args;
  await rejects(stageImport({ kind: 'git', url: 'https://example.com/acme/skills.git', ref: 'main' }, {
    fetchGit: async (a) => { args = a; throw Object.assign(new Error('Command failed'), { stderr: 'fatal: unable to access\nfatal: could not resolve host\n' }); },
  }), 400, /^git: could not fetch main from https:\/\/example.com\/acme\/skills.git: fatal: could not resolve host$/);
  assert.deepEqual(Object.keys(args), ['url', 'ref', 'subdir', 'dest', 'scratch']);
  assert.deepEqual([args.ref, args.subdir, args.scratch], ['main', null, `${args.dest}.git`]);
  assert.deepEqual(stages(), []);
  await rejects(stageImport({ kind: 'git', url: 'https://example.com/x.git' }, {
    fetchGit: async ({ dest, scratch }) => { writeSkill(dest, { 'SKILL.md': skillMd('x') }); writeSkill(scratch, { HEAD: 'x' }); throw new Error('tar: broken'); },
  }), 400, /tar: broken$/);
  assert.deepEqual(stages(), [], 'a fetch that fails half-way leaves nothing behind');
});

test("the repository's .gitattributes cannot change what is extracted: export-subst, ident and export-ignore are off", async () => {
  const pad = '$Format:%<(16000)%H$\n'.repeat(200);
  const attrs = repo('attrs', {
    '.gitattributes': '* export-subst ident\nhidden.txt export-ignore\n',
    'skills/a/SKILL.md': skillMd('a'),
    'skills/a/pad.txt': pad,
    'skills/a/id.txt': '$Id$\nline\n',
    'skills/a/hidden.txt': 'here\n',
  });
  const s = await stageImport({ kind: 'git', url: attrs.url, subdir: 'skills/a' });
  assert.deepEqual(s.inspection.problems, []);
  for (const [f, text] of [['pad.txt', pad], ['id.txt', '$Id$\nline\n'], ['hidden.txt', 'here\n']]) assert.equal(readFileSync(join(s.dir, f), 'utf8'), text, f);
});
