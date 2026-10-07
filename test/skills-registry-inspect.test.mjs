// test/skills-registry-inspect.test.mjs — one skill folder inspected (skills registry design §2b-8, §3.2 hash,
// §3.3, §5 import consent): frontmatter, files, limits, hash, names, and every finding kind.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyFixture, writeSkill, skillMd, POSIX } from './helpers/skills-registry-fixtures.mjs';
import {
  SKILL_LIMITS, SKILL_LINKS_AND_FOLDERS_MAX, inspectSkillDir, skillHash, skillFileDigests, isValidSkillFolderName, skillNameProblem,
  skillMdFields, readSkillMd,
} from '../src/core/skills-registry/inspect.mjs';
import { SKILL_HOOKS_TEXT } from '../src/core/skills-registry/texts.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'worca-skills-inspect-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
const fresh = () => { const d = join(scratch, `case-${++n}`); mkdirSync(d); return d; };
const kinds = (r) => r.findings.map((f) => `${f.kind} ${f.path}`);

test('SKILL_LIMITS of the contract', () => {
  assert.deepEqual(SKILL_LIMITS, { files: 300, fileBytes: 1048576, totalBytes: 8388608 });
});

test('alpha: a plain skill — the whole inspection', () => {
  const r = inspectSkillDir(copyFixture('alpha', fresh()), { name: 'alpha' });
  assert.match(r.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual({ ...r, hash: undefined }, {
    name: 'alpha',
    description: 'Writes a short status note for the current branch.',
    whenToUse: 'When the user asks for a status note or a standup line.',
    frontmatter: { allowedTools: null, hooks: false, shell: false, disableModelInvocation: false, pluginRootRefs: false },
    files: [{ path: 'SKILL.md', bytes: r.files[0].bytes, executable: false }],
    bytes: r.files[0].bytes, scripts: [], shellBlocks: 0, hash: undefined, problems: [], findings: [],
  });
  assert.equal(inspectSkillDir(copyFixture('alpha', fresh())).name, 'alpha', 'the folder name is the default name');
});

test('beta-scripts: folded description, list allowed-tools, a script, one inline shell block, ${CLAUDE_SKILL_DIR} is no finding', () => {
  const r = inspectSkillDir(copyFixture('beta-scripts', fresh()), { name: 'beta-scripts' });
  assert.equal(r.description, 'Collects build facts with a script and summarizes them.');
  assert.equal(r.frontmatter.allowedTools, 'Bash, Read');
  assert.deepEqual(r.files.map((f) => [f.path, f.executable]), [['SKILL.md', false], ['scripts/run.sh', POSIX]]);
  assert.deepEqual(r.scripts, ['scripts/run.sh']);
  assert.equal(r.shellBlocks, 1);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.findings.filter((f) => f.kind === 'shell-block'), [{ path: 'SKILL.md', kind: 'shell-block', text: 'git branch --show-current' }]);
  assert.deepEqual(kinds(r), ['shell-block SKILL.md', ...(POSIX ? ['executable scripts/run.sh'] : [])]);
});

test('gamma-bad: .claude-plugin/ and an escaping symlink are refused; the frontmatter name must be the folder name', { skip: !POSIX }, () => {
  const dir = copyFixture('gamma-bad', fresh());
  writeFileSync(join(scratch, 'outside.txt'), 'secret\n');
  symlinkSync(join(scratch, 'outside.txt'), join(dir, 'leak.txt'));
  const r = inspectSkillDir(dir, { name: 'gamma-bad' });
  assert.deepEqual(r.problems, [
    '.claude-plugin/: a skill cannot ship a .claude-plugin folder',
    'leak.txt: symlink pointing outside the skill folder',
    'SKILL.md names the skill "gamma", not "gamma-bad"',
  ]);
  assert.deepEqual(kinds(r), ['plugin-manifest .claude-plugin/', 'symlink leak.txt']);
  assert.deepEqual(r.files.map((f) => f.path), ['SKILL.md'], 'neither the manifest nor the link target is read');
  assert.deepEqual(inspectSkillDir(dir, { name: 'gamma' }).problems.length, 2, 'under its frontmatter name only the two refusals remain');
});

test('delta-plugin-root: ${CLAUDE_PLUGIN_ROOT} and hooks are findings (hooks shown, not refused); shell, disable-model-invocation are read', () => {
  const r = inspectSkillDir(copyFixture('delta-plugin-root', fresh()), { name: 'delta-plugin-root' });
  assert.equal(r.description, 'Calls a helper that lives elsewhere in its plugin.');
  assert.deepEqual(r.frontmatter, { allowedTools: null, hooks: true, shell: true, disableModelInvocation: true, pluginRootRefs: true });
  assert.deepEqual(kinds(r), ['hooks SKILL.md', 'plugin-root-ref SKILL.md']);
  assert.equal(r.findings[0].text, SKILL_HOOKS_TEXT);
  assert.deepEqual(r.problems, []);
});

test('token-shaped text and ${…} expansions are findings; the token itself is never repeated', () => {
  const token = 'gh' + 'p_' + 'A1b2C3d4E5'.repeat(4);
  const dir = writeSkill(fresh(), {
    'SKILL.md': skillMd('tok', 'Uses env.', 'Home is ${HOME}, twice ${HOME}; dir ${CLAUDE_SKILL_DIR}; session ${CLAUDE_SESSION_ID}; open ${\n'),
    'notes/ref.md': `use ${token} here\n`,
    'scripts/x.sh': 'echo ${PATH}\n',
  });
  const r = inspectSkillDir(dir, { name: 'tok' });
  assert.deepEqual(r.findings, [
    { path: 'SKILL.md', kind: 'expansion', text: '${HOME' },
    { path: 'SKILL.md', kind: 'expansion', text: '${' },
    { path: 'notes/ref.md', kind: 'token', text: 'text shaped like an API token' },
  ]);
  assert.equal(JSON.stringify(r).includes(token), false);
  assert.deepEqual(r.scripts, ['scripts/x.sh'], 'scripts/ files are scripts without an exec bit (Windows)');
});

test('fenced ```! blocks count; inline blocks need a space or line start before the !', () => {
  const md = skillMd('sh', 'Shell.', 'a!`no` b !`one`\n!`two`\n```!\nnpm ls\nnode -v\n```\n```js\nconst x = 1;\n```\n');
  const r = inspectSkillDir(writeSkill(fresh(), { 'SKILL.md': md }), { name: 'sh' });
  assert.equal(r.shellBlocks, 3);
  assert.deepEqual(r.findings.map((f) => f.text), ['npm ls', 'one', 'two']);
});

test('names (§2b-9): Agent Skills names, ≤ 64, synced and anthropic-skills reserved', () => {
  for (const name of ['a', 'deploy-checklist', 'x'.repeat(64)]) assert.equal(isValidSkillFolderName(name), true, name);
  for (const name of ['Deploy', 'a_b', 'a--b', '-a', '', 'x'.repeat(65), 'synced', 'anthropic-skills', undefined, '../x']) {
    assert.equal(isValidSkillFolderName(name), false, String(name));
  }
  assert.equal(skillNameProblem('synced'), 'name "synced" is reserved');
  for (const [name, what] of [[{ toString: 0 }, 'object'], [null, 'null'], [['a'], 'a list'], [7, 'number']]) {
    assert.equal(skillNameProblem(name), `name must be text, not ${what}`);
    assert.equal(isValidSkillFolderName(name), false);
  }
  assert.deepEqual(inspectSkillDir(writeSkill(fresh(), { 'SKILL.md': skillMd('obj') }), { name: { toString: 0 } }).problems, ['name must be text, not object']);
  assert.match(skillNameProblem('A'), /lowercase letters, digits and single hyphens \(at most 64 characters\)/);
  assert.deepEqual(inspectSkillDir(writeSkill(fresh(), { 'SKILL.md': skillMd('Bad_Name') }), { name: 'Bad_Name' }).problems.length, 1);
});

test('SKILL.md missing, without frontmatter, folder missing', () => {
  assert.deepEqual(inspectSkillDir(writeSkill(fresh(), { 'README.md': 'x' }), { name: 'x' }).problems, ['SKILL.md is missing']);
  assert.deepEqual(inspectSkillDir(writeSkill(fresh(), { 'SKILL.md': '# no fence\n' }), { name: 'x' }).problems,
    ['SKILL.md has no frontmatter (a --- block with name and description)']);
  const gone = inspectSkillDir(join(scratch, 'nope'), { name: 'nope' });
  assert.deepEqual([gone.problems, gone.files, gone.hash], [['skill folder not found'], [], skillHash([])]);
});

test('limits: more than 300 files stops the walk; a file over 1 MB is not read; over 8 MB in total', () => {
  const many = writeSkill(fresh(), { 'SKILL.md': skillMd('many') });
  for (let i = 0; i < 320; i++) writeFileSync(join(many, `f${String(i).padStart(3, '0')}.txt`), 'x');
  const r = inspectSkillDir(many, { name: 'many' });
  assert.deepEqual(r.problems, ['more than 300 files']);
  assert.equal(r.files.length, SKILL_LIMITS.files + 1, 'the walk stops at the first file over the limit');

  const big = writeSkill(fresh(), { 'SKILL.md': skillMd('big'), 'blob.bin': Buffer.alloc(SKILL_LIMITS.fileBytes + 1) });
  assert.deepEqual(inspectSkillDir(big, { name: 'big' }).problems, ['blob.bin: larger than 1 MB']);

  const huge = writeSkill(fresh(), { 'SKILL.md': skillMd('huge') });
  for (let i = 0; i < 9; i++) writeFileSync(join(huge, `part${i}.bin`), Buffer.alloc(SKILL_LIMITS.fileBytes - 10));
  writeFileSync(join(huge, 'z.md'), `${'gh' + 'p_'}${'a1B2'.repeat(10)}\n`);
  const h = inspectSkillDir(huge, { name: 'huge' });
  assert.deepEqual(h.problems, ['larger than 8 MB in total']);
  assert.equal(h.bytes > SKILL_LIMITS.totalBytes, true);
  assert.deepEqual(h.findings, [], 'nothing past 8 MB is read');
});

test('hash: content and exec bit change it, creation order and the exact exec bits do not; .git is ignored', () => {
  const a = writeSkill(fresh(), { 'SKILL.md': skillMd('h'), 'b/x.txt': '1', 'a.txt': '2' });
  const b = writeSkill(fresh(), { 'a.txt': '2', 'b/x.txt': '1', 'SKILL.md': skillMd('h') });
  const hash = (d) => inspectSkillDir(d, { name: 'h' }).hash;
  assert.equal(hash(a), hash(b));
  mkdirSync(join(b, '.git'));
  writeFileSync(join(b, '.git', 'HEAD'), 'ref: x\n');
  assert.equal(hash(a), hash(b), '.git is never part of a skill');
  writeFileSync(join(b, 'a.txt'), '3');
  assert.notEqual(hash(a), hash(b));
  if (POSIX) {
    chmodSync(join(a, 'a.txt'), 0o755);
    const x = hash(a);
    assert.notEqual(x, hash(b));
    chmodSync(join(a, 'a.txt'), 0o700);
    assert.equal(hash(a), x, 'one exec bit is one bit');
  }
  const files = [{ path: 'b', mode: 0, sha256: 's1' }, { path: 'a', mode: 0o100, sha256: 's2' }];
  assert.equal(skillHash(files), skillHash([...files].reverse()));
  assert.deepEqual(Object.keys(skillFileDigests(a)), ['SKILL.md', 'a.txt', 'b/x.txt']);
  assert.match(skillFileDigests(a)['b/x.txt'], /^0:[0-9a-f]{64}$/);
});

test('symlinks inside the folder: a file link is read as a copy; folder, broken and chained-out links are refused', { skip: !POSIX }, () => {
  const d = writeSkill(fresh(), { 'SKILL.md': skillMd('ln'), 'docs/ref.md': 'ref\n' });
  symlinkSync('docs/ref.md', join(d, 'ref.md'));
  let r = inspectSkillDir(d, { name: 'ln' });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.files.map((f) => f.path), ['SKILL.md', 'docs/ref.md', 'ref.md']);
  assert.deepEqual(kinds(r), ['symlink ref.md']);
  symlinkSync('docs', join(d, 'more'));
  symlinkSync('nowhere.md', join(d, 'gone.md'));
  writeFileSync(join(scratch, 'out.md'), 'out\n');
  symlinkSync(join(scratch, 'out.md'), join(d, 'docs', 'hop.md'));
  symlinkSync('docs/hop.md', join(d, 'chain.md'));
  symlinkSync(join(scratch, 'no-such-file'), join(d, 'away.md'));
  r = inspectSkillDir(d, { name: 'ln' });
  assert.deepEqual(r.problems, [
    'away.md: symlink pointing outside the skill folder',
    'chain.md: symlink pointing outside the skill folder',
    'docs/hop.md: symlink pointing outside the skill folder',
    'gone.md: broken symlink',
    'more: symlink to a folder',
  ]);
});

test('readSkillMd reads a regular SKILL.md only: a FIFO, or a link to a FIFO or /dev/zero, returns null at once', { skip: !POSIX }, () => {
  const fifo = join(scratch, 'pipe');
  execFileSync('mkfifo', [fifo]);
  const linked = fresh();
  symlinkSync(fifo, join(linked, 'SKILL.md'));
  const piped = fresh();
  execFileSync('mkfifo', [join(piped, 'SKILL.md')]);
  const zero = fresh();
  symlinkSync('/dev/zero', join(zero, 'SKILL.md'));
  for (const d of [linked, piped, zero]) assert.equal(readSkillMd(d), null, d); // the FIFOs first: a regression blocks, it never reads /dev/zero
  assert.deepEqual(inspectSkillDir(linked, { name: 'x' }).problems, ['SKILL.md: symlink pointing outside the skill folder', 'SKILL.md is missing']);
  assert.deepEqual(inspectSkillDir(piped, { name: 'x' }).problems, ['SKILL.md is missing']);
  symlinkSync('pipe-here', join(piped, 'loop.md'));
  execFileSync('mkfifo', [join(piped, 'pipe-here')]);
  assert.deepEqual(inspectSkillDir(piped, { name: 'x' }).problems, ['loop.md: symlink to something that is not a file', 'SKILL.md is missing']);
});

test('skillMdFields and readSkillMd: block scalars, quotes, absent keys', () => {
  assert.equal(skillMdFields('no fence'), null);
  assert.deepEqual(skillMdFields('---\nname: "q"\ndescription: |\n  line one\n  line two\nwhen_to_use: \'x\'\n---\n'), {
    name: 'q', description: 'line one\nline two', whenToUse: 'x', allowedTools: null, hooks: false, shell: false, disableModelInvocation: false,
  });
  const d = writeSkill(fresh(), { 'SKILL.md': skillMd('r', 'Reads.') });
  assert.equal(readSkillMd(d).description, 'Reads.');
  assert.equal(readSkillMd(join(scratch, 'missing')), null);
});

test('shell blocks are found in linear time: an unclosed or whitespace-filled ```! fence costs no more than its size', () => {
  const head = skillMd('lin', 'Linear.', '');
  const unclosed = writeSkill(fresh(), { 'SKILL.md': `${head}\`\`\`!${' \n'.repeat(32768)}` });
  const spaced = writeSkill(fresh(), { 'SKILL.md': `${head}\`\`\`!\nx${' '.repeat(65536)}x\n\`\`\`\n` });
  const t0 = process.cpuUsage();
  const r = [inspectSkillDir(unclosed, { name: 'lin' }), inspectSkillDir(spaced, { name: 'lin' })];
  const cpu = process.cpuUsage(t0);
  const ms = (cpu.user + cpu.system) / 1000;
  assert.equal(ms < 1000, true, `${ms} ms of CPU`);
  assert.deepEqual(r.map((x) => x.shellBlocks), [0, 1]);
  assert.equal(r[1].findings[0].text, `x${' '.repeat(118)}…`);
});

test('findings are capped at 50 per kind, then one finding for the rest; shellBlocks keeps the count', () => {
  const body = `${' !`a`'.repeat(60)}\n${Array.from({ length: 60 }, (_, i) => `\${V${i}}`).join(' ')}\n`;
  const r = inspectSkillDir(writeSkill(fresh(), { 'SKILL.md': skillMd('cap', 'Capped.', body) }), { name: 'cap' });
  assert.equal(r.shellBlocks, 60);
  const of = (kind) => r.findings.filter((f) => f.kind === kind);
  assert.deepEqual([of('shell-block').length, of('shell-block').at(-1)], [51, { path: 'SKILL.md', kind: 'shell-block', text: '… and 10 more' }]);
  assert.deepEqual([of('expansion').length, of('expansion').at(-1).text], [51, '… and 10 more']);
});

test('frontmatter keys as YAML reads them: a quoted key, a ? key, a flow map or a comment hides neither hooks nor the name', () => {
  const fm = (y) => skillMdFields(`---\n${y}\n---\nBody.\n`);
  assert.equal(fm('name: s\ndescription: d\n"hooks":\n  PreToolUse: []').hooks, true);
  assert.equal(fm("name: s\ndescription: d\n'shell': bash").shell, true);
  assert.equal(fm('name: s\ndescription: d\n? hooks\n: {}').hooks, true);
  assert.deepEqual([fm('{name: s, description: d, hooks: {}}').name, fm('{name: s, description: d, hooks: {}}').hooks], ['s', true]);
  assert.equal(fm('"name": other\ndescription: d').name, 'other');
  assert.equal(fm('name: s # the skill\ndescription: d').name, 's');
  assert.equal(fm('name: s\ndescription: d').hooks, false);
  // the CLI's retry quotes `Use when: x`, so a quoted hooks key still counts and the word inside a value does not;
  // a block over 16 KB is unknown, and shows the badge
  assert.equal(fm('name: s\ndescription: Use when: x\n"hooks": {}').hooks, true);
  assert.equal(fm('name: s\ndescription: Use when: it sets git hooks: up').hooks, false);
  assert.equal(fm(`name: s\ndescription: d\n"hooks": {}\nnotes: ${'a'.repeat(70000)}`).hooks, true);
  const d = writeSkill(fresh(), { 'SKILL.md': '---\n"name": other\ndescription: d\n"hooks": {}\n---\n' });
  assert.deepEqual(inspectSkillDir(d, { name: 'quoted' }).problems, ['SKILL.md names the skill "other", not "quoted"']);
  assert.deepEqual(kinds(inspectSkillDir(d, { name: 'other' })), ['hooks SKILL.md']);
});

test('frontmatter as Claude Code reads it: merge keys, duplicate keys, its quoting retry and its cut hide neither hooks, shell nor the name', () => {
  const fm = (y) => skillMdFields(`---\n${y}\n---\nBody.\n`);
  assert.equal(fm('name: s\ndescription: d\nmetadata: &m\n  hooks: {}\n<<: *m').hooks, true, 'a merge key');
  assert.deepEqual([fm('description: d\nm: &m {name: other}\n<<: *m').name, fm('name: s\ndescription: d\nm: &m {name: other}\n<<: *m').name],
    ['other', 's'], 'a merged name, unless the block has its own');
  assert.equal(fm('name: s\ndescription: d\nname: other').name, 'other', 'a duplicate key: the last one wins');
  assert.equal(fm('name: s\ndescription: d\ndescription: e\n"she\\x6cl": zsh').shell, true);
  assert.equal(fm('name: s\ndescription: Use when: x\n"hoo\\x6bs": {}').hooks, true, "the CLI's retry quotes `Use when: x`");
  assert.equal(fm('name: s\ndescription: d\n!!str hooks: {}\nx:\n\t- y').hooks, true, "the CLI's retry turns leading tabs into spaces");
  assert.equal(fm('name: s\ndescription: d\n"she\\x6cl": zsh\n----').shell, true, "the CLI's block ends at the first ---");
  assert.equal(fm('name: s\ndescription: a---b\nname: other').name, 's', 'even inside a line: the second name is past it');
  assert.deepEqual([fm('name: s\ndescription: Use when: x').hooks, fm('name: s\ndescription: d\nx:\n\t- y').hooks], [false, false],
    'what only the retry reads, and holds no hooks, shows no badge');
  const big = fm(`name: s\ndescription: d\nnotes: ${'a'.repeat(17000)}`);
  assert.deepEqual([big.hooks, big.shell, big.name], [true, true, 's'], 'over 16 KB: unknown, both badges');
  const broken = fm('name: s\ndescription: d\nx: "unterminated');
  assert.deepEqual([broken.hooks, broken.shell, broken.name], [true, true, 's'], 'parses neither way: unknown, both badges');
  // an unknown block's name is the line reader's guess (the first `name:`; the CLI keeps the last): it cannot be checked
  const unread = 'SKILL.md frontmatter cannot be read the way Claude Code reads it (over 16 KB, or YAML Worca cannot parse), so its name cannot be checked';
  for (const y of [`name: un\ndescription: d\nnotes: ${'a'.repeat(17000)}\nname: other`, 'name: un\ndescription: d\n<<: {a: 1}\n"<<": {b: 2}\nname: other']) {
    assert.deepEqual(inspectSkillDir(writeSkill(fresh(), { 'SKILL.md': `---\n${y}\n---\n` }), { name: 'un' }).problems, [unread]);
  }
  // a merge source that is not a map is ignored, as Bun ignores it: the block is read, and its last name is checked
  assert.deepEqual(inspectSkillDir(writeSkill(fresh(), { 'SKILL.md': '---\nname: un\ndescription: d\n<<: 1\nname: other\n---\n' }), { name: 'un' }).problems,
    ['SKILL.md names the skill "other", not "un"']);
  // the CLI names a skill by String(name), untrimmed, up to 256 characters: a list, a number or padded text is a name
  assert.deepEqual([fm('name: "  s  "\ndescription: d').name, fm('name: 5\ndescription: d').name, fm('name: [other]\ndescription: d').name,
    fm('description: d').name, fm(`name: ${'a'.repeat(257)}\ndescription: d`).name], ['  s  ', '5', 'other', null, null]);
  const named = (y) => inspectSkillDir(writeSkill(fresh(), { 'SKILL.md': `---\n${y}\ndescription: d\n---\n` }), { name: 'other' }).problems;
  assert.deepEqual([named('name: [other]'), named('name: 123'), named('name: "  other  "')],
    [[], ['SKILL.md names the skill "123", not "other"'], ['SKILL.md names the skill "  other  ", not "other"']]);
  const d = writeSkill(fresh(), { 'SKILL.md': '---\nname: dup\ndescription: d\nname: other\n---\n' });
  assert.deepEqual(inspectSkillDir(d, { name: 'dup' }).problems, ['SKILL.md names the skill "other", not "dup"']);
});

test('frontmatter as Bun.YAML reads it: a collection key, a quoted << and a lone CR hide neither hooks, shell nor the name', () => {
  const fm = (y) => skillMdFields(`---\n${y}\n---\nBody.\n`);
  // Bun names a key by its JS text: `[hooks]` is "hooks" (to the yaml package it is "[ hooks ]")
  assert.equal(fm('name: s\ndescription: d\n[hooks]:\n  PreToolUse: []').hooks, true, 'a flow-sequence key');
  assert.equal(fm('name: s\ndescription: d\n? - shell\n: zsh').shell, true, 'a block-sequence key');
  assert.equal(fm('description: d\n[name]: other').name, 'other');
  // Bun merges on a key whose text is <<, however it is quoted (the yaml package: a plain << only)
  assert.equal(fm('name: s\ndescription: d\nm: &m {hooks: {}}\n"<<": *m').hooks, true, 'a double-quoted <<');
  assert.equal(fm("name: s\ndescription: d\n'<<': [{x: 1}, {shell: zsh}]").shell, true, 'a single-quoted << over a list');
  assert.deepEqual([fm('description: d\n"<<": {name: other}').name, fm('name: s\ndescription: d\n"<<": {name: other}').name], ['other', 's'],
    'a merged name, unless the block has its own');
  // Bun breaks a line at a lone CR; to the yaml package it is text, and inside a comment it hid the next key
  assert.equal(fm('name: s\ndescription: d # see below\rhooks:\r  PreToolUse: []').hooks, true, 'a lone CR after a comment');
  assert.equal(fm('name: s\ndescription: d #\rname: other').name, 'other');
  const loop = fm('name: s\ndescription: d\nm: &m {"<<": *m}\n"<<": *m');
  assert.deepEqual([loop.hooks, loop.shell], [true, true], 'a merge that loops is unknown: both badges');
  // two quoted << keys: the yaml package keeps the last one only, Bun merges both — a map with two merge keys is unknown
  assert.deepEqual([fm('name: s\ndescription: d\na: &a {shell: zsh}\nb: &b {x: 1}\n"<<": *a\n"<<": *b').shell,
    fm("name: s\ndescription: d\n'<<': {hooks: {}}\n'<<': {x: 1}").hooks, fm('name: s\ndescription: d\nk: &k "<<"\n*k : {hooks: {}}\n"<<": {x: 1}').hooks],
  [true, true, true], 'two merge keys in one map');
  // each merge source is merged in full first (the yaml package's own merge kept a source's quoted << raw and dropped
  // a later source's), and a plain << beside a quoted one is two merge keys in one map
  assert.deepEqual([fm('name: s\ndescription: d\n<<: [{"<<": {}}, {"<<": {shell: zsh}}]').shell,
    fm('name: s\ndescription: d\n<<:\n  - "<<": {}\n  - "<<":\n      hooks: {}').hooks,
    fm("name: s\ndescription: d\n'<<': {}\n<<:\n  '<<':\n    shell: zsh").shell,
    fm('description: d\n<<: [{"<<": {}}, {"<<": {name: other}}]').name], [true, true, true, 'other'], 'merges inside merge sources');
  assert.deepEqual([fm('name: s\ndescription: d\n[x]: y\n"<<": {a: 1}').hooks, fm('name: s\ndescription: d # a\rx: y').shell], [false, false],
    'what declares neither shows no badge');
  // the yaml package and Bun refuse different blocks, and the CLI's retry can read other keys than the first text (a
  // quoted anchor line moves `*m` to an earlier anchor): both texts are read, and a badge either reading declares shows
  const BS = String.fromCharCode(92);
  const shadow = (early, late) => `name: s\ndescription: d\na:\n  m: &m ${early}\nb: &m ${late}\n<<:\n  *m`;
  const many = Array.from({ length: 105 }, (_, i) => `k${String.fromCharCode(97 + Math.floor(i / 26), 97 + (i % 26))}: *q`).join('\n');
  const badges = (y) => { const f = fm(y); return [f.hooks, f.shell]; };
  assert.deepEqual([
    badges(shadow('{}', '{<<: {hooks: {}, shell: zsh}, "<<": {x: 1}}')), // two merge keys: Bun takes the first text
    badges(`${shadow('{}', '{hooks: {}, shell: zsh}')}\nxa: &q 1\n${many}`), // more aliases than the yaml package's cap
    badges(`${shadow('{}', '{hooks: {}, shell: zsh}')}\nx: !<!> a`), // a tag only Bun takes
    badges(`${shadow('{}', '{hooks: {}, shell: zsh}')}\nx: !<!> a\nxa: &q 1\n${many}`), // both: the first text cannot be read
    badges(`${shadow('{hooks: {}, shell: zsh}', '{}')}\nx: "${BS}uD800" #`), // a lone surrogate Bun refuses: it reads the retry
  ], [[true, true], [true, true], [true, true], [true, true], [true, true]], 'either reading declares hooks and shell');
  // a name the two readings give differently, or two keys read as `name` (a Map keeps a key at its first place, Bun
  // keeps the pairs in order), is never checked: the skill is invalid
  const unread = 'SKILL.md frontmatter cannot be read the way Claude Code reads it (over 16 KB, or YAML Worca cannot parse), so its name cannot be checked';
  const problems = (y) => inspectSkillDir(writeSkill(fresh(), { 'SKILL.md': `---\n${y}\n---\n` }), { name: 's' }).problems;
  assert.deepEqual([
    problems('description: d\na:\n  m: &m {name: other}\nb: &m {name: s}\n<<:\n  *m'),
    problems(`name: s #c\ndescription: d\nx: "${BS}uD800" #`),
    problems('description: d\nname: x\n[name]: s\nname: [z]'),
    problems('description: d\n<<: {name: [z], [name]: s}'),
    problems('"x": &n [evil, "#"]\ny: &n s\n"name": *n\ndescription: d\na: !<> b'), // the retry moved *n to another anchor
    problems('name: s # c\n"x": &n [evil, "#"]\ny: &n s\n"name": *n\ndescription: d\na: !<> b'), // ...beside a quoted name line
  ], [[unread], [unread], [unread], [unread], [unread], [unread]]);
  // YAML 1.1's explicit tags stay text or a plain collection, as in Bun: the yaml package's resolveKnownTags decoded
  // `!!binary shell` into a key of bytes, so neither reading declared shell while Claude Code read it
  assert.deepEqual([badges('name: s\ndescription: d\n!!binary shell: zsh'), badges('name: s\ndescription: d\nx: &m {!!binary hooks: {}}\n<<: *m'),
    badges('name: s\ndescription: d\n!!binary <<: {hooks: {}, shell: zsh}'), fm('description: d\nname: !!binary s').name,
    problems('name: s\ndescription: d\n!!binary name: [z]')], [[false, true], [true, false], [true, true], 's', ['SKILL.md names the skill "z", not "s"']], 'tagged keys and names');
  // a retry name that is a value quoted as written (`s # note`) names nothing else, an alias without an anchor reads as
  // nothing (Bun refuses it too), and a block only the retry parses is read: these skills stay valid
  assert.deepEqual([problems('name: s # note\ndescription: d'), problems('name: s\ndescription: *Note* read this'),
    problems('name: s\ndescription: Use when: x')], [[], [], []]);
});

test('reading the frontmatter costs little CPU: nothing over 16 KB is parsed, and the parser is tried twice at most', () => {
  const gens = [
    (n) => 'x\n'.repeat(n / 2),
    (n) => Array.from({ length: n / 8 }, (_, i) => `k${i}: v`).join('\n'),
    (n) => `x: ${'{, '.repeat(n / 3)}`,
    (n) => `x: ${'['.repeat(n)}`,
  ];
  const t0 = process.cpuUsage();
  for (const g of gens) for (const n of [16000, 1 << 20]) skillMdFields(`---\nname: s\ndescription: d\n${g(n)}\n---\nBody.\n`);
  const cpu = process.cpuUsage(t0);
  const ms = (cpu.user + cpu.system) / 1000;
  assert.equal(ms < 5000, true, `${ms} ms of CPU`); // ~0.4 s here; the uncapped parse (M34) costs ~8 s even on a fast machine
  // an alias used as a key is resolved in one pass over the anchors (~20 ms here); one walk per alias (M45) cost ~3.5 s
  const t1 = process.cpuUsage();
  skillMdFields(`---\nname: s\ndescription: d\nk: &k x\n${'*k :\n'.repeat(3200)}---\nBody.\n`);
  const alias = process.cpuUsage(t1);
  assert.equal((alias.user + alias.system) / 1000 < 1000, true, `${(alias.user + alias.system) / 1000} ms of CPU for 3200 alias keys`);
});

test('links and folders count too: past 1000 the walk stops, and the skill is invalid', { skip: !POSIX }, () => {
  const links = writeSkill(fresh(), { 'SKILL.md': skillMd('links') });
  for (let i = 0; i < 1500; i++) symlinkSync(`nowhere-${i}`, join(links, `l${String(i).padStart(4, '0')}`));
  const r = inspectSkillDir(links, { name: 'links' });
  assert.deepEqual([r.problems.length, r.problems.at(-1)], [SKILL_LINKS_AND_FOLDERS_MAX + 1, 'more than 1000 links and folders']);
  const folders = writeSkill(fresh(), { 'SKILL.md': skillMd('folders') });
  for (let i = 0; i < 1500; i++) mkdirSync(join(folders, `d${String(i).padStart(4, '0')}`));
  assert.deepEqual(inspectSkillDir(folders, { name: 'folders' }).problems, ['more than 1000 links and folders']);
});

test('a file or folder that cannot be read is a problem, never a throw and never a silent gap', { skip: !POSIX || process.getuid?.() === 0 }, () => {
  const d = writeSkill(fresh(), { 'SKILL.md': skillMd('lk'), 'data/cache.json': '{}', 'half/y.md': 'y\n', 'shut/x.md': 'x\n' });
  const modes = [['data/cache.json', 0], ['half', 0o600], ['shut', 0]];
  for (const [p, m] of modes) chmodSync(join(d, p), m);
  try {
    assert.deepEqual(inspectSkillDir(d, { name: 'lk' }).problems, [
      'data/cache.json: cannot be read (EACCES)', 'half/y.md: cannot be read (EACCES)', 'shut/: cannot be read (EACCES)',
    ]);
  } finally {
    for (const [p] of modes) chmodSync(join(d, p), 0o700);
  }
});
