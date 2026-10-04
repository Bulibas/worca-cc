// test/terminal-shell.test.mjs — shell choice and the bash/zsh rc snippets that print command markers (#573).
// Runs a real bash (and zsh when present) over pipes, exactly as the pipes fallback does.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickShell, shellKind, shellLaunch, ensureZshDir, BASH_RC } from '../src/core/terminal/shell.mjs';
import { MarkerParser } from '../src/core/terminal/markers.mjs';

const home = mkdtempSync(join(tmpdir(), 'term-shell-'));
after(() => rmSync(home, { recursive: true, force: true }));
const which = (b) => { const r = spawnSync('/bin/sh', ['-c', `command -v ${b}`], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };
const BASH = which('bash');
const ZSH = which('zsh');
const NONCE = 'a1b2c3d4e5f60718';
const FORGE = `printf '\\033]133;C;%s;%s\\007' fake "$(printf 'rm -rf /' | base64)"`;

/** Run `lines` through the shell over pipes; return the parsed blocks. */
function runShell(file, launch, lines) {
  return new Promise((resolve) => {
    const child = spawn(file, launch.args, { cwd: home, env: { PATH: process.env.PATH, HOME: home, ...launch.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const p = new MarkerParser({ nonce: NONCE });
    const blocks = [];
    let cur = null;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      for (const e of p.push(d)) {
        if (e.type === 'start') cur = { command: e.command, out: '' };
        else if (e.type === 'output' && cur) cur.out += e.text;
        else if (e.type === 'end' && cur) { blocks.push({ ...cur, exitCode: e.exitCode }); cur = null; }
      }
    });
    child.on('close', () => resolve(blocks.filter((b) => b.command !== 'exit')));
    child.stdin.end(lines.join('\n') + '\nexit\n');
  });
}

test('pickShell prefers $SHELL, then bash, then sh; kind is bash, zsh or other', () => {
  const exists = (f) => ['/bin/zsh', '/bin/bash', '/bin/sh'].includes(f);
  assert.deepEqual(pickShell({ env: { SHELL: '/bin/zsh' }, platform: 'darwin', exists }), { file: '/bin/zsh', kind: 'zsh', platform: 'darwin' });
  assert.equal(pickShell({ env: { SHELL: '/nope/fish' }, platform: 'linux', exists }).file, '/bin/bash');
  assert.equal(pickShell({ env: {}, platform: 'linux', exists: (f) => f === '/bin/sh' }).kind, 'other');
  assert.deepEqual(pickShell({ env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, platform: 'win32' }),
    { file: 'C:\\Windows\\system32\\cmd.exe', kind: 'other', platform: 'win32' });
  assert.equal(shellKind('/usr/local/bin/bash'), 'bash');
});

test('shellLaunch: bash gets --rcfile, zsh gets ZDOTDIR; only they get the nonce; others run plain', () => {
  const bash = shellLaunch({ file: '/bin/bash', kind: 'bash', platform: 'linux' }, { nonce: 'n1' });
  assert.deepEqual(bash, { args: ['--rcfile', BASH_RC, '-i'], env: { BASH_SILENCE_DEPRECATION_WARNING: '1', WORCA_TERMINAL_NONCE: 'n1' } });
  const z = shellLaunch({ file: '/bin/zsh', kind: 'zsh', platform: 'darwin' }, { env: { HOME: '/h' }, zshDir: '/w/zsh', nonce: 'n1' });
  assert.deepEqual(z, { args: ['-i'], env: { ZDOTDIR: '/w/zsh', WORCA_USER_ZDOTDIR: '/h', WORCA_TERMINAL_NONCE: 'n1' } });
  assert.deepEqual(shellLaunch({ file: '/bin/zsh', kind: 'zsh', platform: 'darwin' }, { env: {}, zshDir: null, nonce: 'n1' }).env, {});
  assert.deepEqual(shellLaunch({ file: 'cmd.exe', kind: 'other', platform: 'win32' }, { nonce: 'n1' }), { args: [], env: {} });
});

test('bash: each command becomes a block with its output and exit code; an empty Enter makes none', { skip: !BASH }, async () => {
  const launch = shellLaunch({ file: BASH, kind: 'bash', platform: process.platform }, { nonce: NONCE });
  const blocks = await runShell(BASH, launch, ['echo hi', '', 'false']);
  assert.deepEqual(blocks.map((b) => [b.command, b.exitCode]), [['echo hi', 0], ['false', 1]]);
  assert.match(blocks[0].out, /^hi\r?\n$/);
});

test('bash: a forged mark in command output stays output; commands never see the nonce', { skip: !BASH }, async () => {
  const launch = shellLaunch({ file: BASH, kind: 'bash', platform: process.platform }, { nonce: NONCE });
  const blocks = await runShell(BASH, launch, [FORGE, 'echo "n=[$WORCA_TERMINAL_NONCE]"']);
  assert.deepEqual(blocks.map((b) => b.command), [FORGE, 'echo "n=[$WORCA_TERMINAL_NONCE]"']);
  assert.match(blocks[0].out, /133;C;fake;/);
  assert.equal(blocks[1].out.trim(), 'n=[]');
});

test('zsh: the same blocks through ZDOTDIR, and no nonce for commands', { skip: !ZSH }, async () => {
  const dir = ensureZshDir(join(home, 'zsh'));
  assert.ok(existsSync(join(dir, '.zshrc')) && existsSync(join(dir, '.zshenv')));
  const launch = shellLaunch({ file: ZSH, kind: 'zsh', platform: process.platform }, { env: { HOME: home }, zshDir: dir, nonce: NONCE });
  const blocks = await runShell(ZSH, launch, ['echo hi', 'false', FORGE, 'echo "n=[$WORCA_TERMINAL_NONCE]"']);
  assert.deepEqual(blocks.map((b) => [b.command, b.exitCode]), [['echo hi', 0], ['false', 1], [FORGE, 0], ['echo "n=[$WORCA_TERMINAL_NONCE]"', 0]]);
  assert.equal(blocks[3].out.trim(), 'n=[]');
});

test('ensureZshDir rewrites only when the shipped files changed', () => {
  const dir = ensureZshDir(join(home, 'zsh2'));
  const before = readFileSync(join(dir, '.zshrc'), 'utf8');
  ensureZshDir(dir);
  assert.equal(readFileSync(join(dir, '.zshrc'), 'utf8'), before);
});

const BASH_V = BASH ? Number(spawnSync(BASH, ['-c', 'echo $((BASH_VERSINFO[0]*100+BASH_VERSINFO[1]))'], { encoding: 'utf8' }).stdout.trim()) : 0;

test('bash: the person\'s own PROMPT_COMMAND still runs and is never recorded as a command', { skip: !BASH }, async () => {
  writeFileSync(join(home, '.bashrc'), 'PROMPT_COMMAND=\'__mine=$((__mine+1))\'\n');
  try {
    const launch = shellLaunch({ file: BASH, kind: 'bash', platform: process.platform }, { nonce: NONCE });
    const blocks = await runShell(BASH, launch, ['echo hi', 'echo "m=$__mine"']);
    assert.deepEqual(blocks.map((b) => b.command), ['echo hi', 'echo "m=$__mine"']);
    assert.match(blocks[1].out, /m=[1-9]/);
  } finally { rmSync(join(home, '.bashrc'), { force: true }); }
});

test('bash 5.1+: an array PROMPT_COMMAND keeps every element, and none is recorded', { skip: BASH_V < 501 }, async () => {
  writeFileSync(join(home, '.bashrc'), 'PROMPT_COMMAND=(\'__a=1\' \'__b=$((__b+1))\')\n');
  try {
    const launch = shellLaunch({ file: BASH, kind: 'bash', platform: process.platform }, { nonce: NONCE });
    const blocks = await runShell(BASH, launch, ['echo hi', 'echo "b=$__b"']);
    assert.deepEqual(blocks.map((b) => b.command), ['echo hi', 'echo "b=$__b"']);
    assert.match(blocks[1].out, /b=[1-9]/);
  } finally { rmSync(join(home, '.bashrc'), { force: true }); }
});
