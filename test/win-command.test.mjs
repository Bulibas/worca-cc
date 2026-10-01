// test/win-command.test.mjs
// MCP registry §5.4 / §14: what a command reaches on a Windows PATH (PATH × PATHEXT, .exe/.com first),
// and the cmd.exe metacharacters a shim line refuses. Pure: runs on every host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWindowsCommand, WIN_CMD_METACHAR_RE } from '../src/core/win-command.mjs';

const files = (...ps) => { const set = new Set(ps.map((p) => p.toLowerCase())); return (p) => set.has(p.toLowerCase()); };
const pathEnv = 'C:\\tools;C:\\Program Files\\nodejs';

test('a bare name walks PATH × PATHEXT: first directory wins, .exe/.com before .bat/.cmd inside it', () => {
  const r = (bin, isFile, pathext) => resolveWindowsCommand(bin, { pathEnv, pathext, isFile });
  assert.deepEqual(r('npx', files('C:\\Program Files\\nodejs\\npx.cmd')), { path: 'C:\\Program Files\\nodejs\\npx.CMD', kind: 'shim' });
  assert.deepEqual(r('npx', files('C:\\Program Files\\nodejs\\npx.cmd', 'C:\\Program Files\\nodejs\\npx.exe'), '.BAT;.CMD;.EXE'),
    { path: 'C:\\Program Files\\nodejs\\npx.EXE', kind: 'exe' }, '.exe before .cmd even when PATHEXT lists it last');
  assert.deepEqual(r('uv', files('C:\\tools\\uv.bat', 'C:\\Program Files\\nodejs\\uv.exe')), { path: 'C:\\tools\\uv.BAT', kind: 'shim' });
  assert.deepEqual(r('uv', files('C:\\tools\\uv.com')), { path: 'C:\\tools\\uv.COM', kind: 'exe' });
  assert.deepEqual(r('run.ps1', files('C:\\tools\\run.ps1')), { path: 'C:\\tools\\run.ps1', kind: 'ps1' });
  assert.equal(r('npx', files()), null);
  assert.equal(r('server.js', files('C:\\tools\\server.js')), null, 'not an executable kind');
  assert.deepEqual(r('tool', files('C:\\tools\\tool.ps1')), { path: 'C:\\tools\\tool.ps1', kind: 'ps1' }, 'PowerShell-only: reported as such');
  assert.deepEqual(r('tool', files('C:\\tools\\tool.ps1', 'C:\\Program Files\\nodejs\\tool.cmd')),
    { path: 'C:\\Program Files\\nodejs\\tool.CMD', kind: 'shim' }, 'anything PATHEXT reaches wins over a .ps1');
  assert.deepEqual(resolveWindowsCommand('npx', { pathEnv: '"C:\\Program Files\\nodejs";C:\\tools', isFile: files('C:\\Program Files\\nodejs\\npx.cmd') }),
    { path: 'C:\\Program Files\\nodejs\\npx.CMD', kind: 'shim' }, 'a quoted PATH entry');
  const ps1ext = '.COM;.EXE;.BAT;.CMD;.PS1';
  assert.deepEqual(r('tool', files('C:\\tools\\tool.ps1', 'C:\\Program Files\\nodejs\\tool.cmd'), ps1ext),
    { path: 'C:\\Program Files\\nodejs\\tool.CMD', kind: 'shim' }, 'a .PS1 in PATHEXT never shadows a .cmd further down PATH');
  assert.deepEqual(r('tool', files('C:\\tools\\tool.ps1'), ps1ext), { path: 'C:\\tools\\tool.ps1', kind: 'ps1' });
});

test('a path is probed as written, or with each PATHEXT extension', () => {
  assert.deepEqual(resolveWindowsCommand('C:\\srv\\mcp.cmd', { isFile: files('C:\\srv\\mcp.cmd') }), { path: 'C:\\srv\\mcp.cmd', kind: 'shim' });
  assert.deepEqual(resolveWindowsCommand('C:\\srv\\mcp', { pathext: '', isFile: files('C:\\srv\\mcp.exe') }), { path: 'C:\\srv\\mcp.EXE', kind: 'exe' });
  assert.equal(resolveWindowsCommand('C:\\srv\\mcp.exe', { pathEnv, isFile: files() }), null);
});

test('WIN_CMD_METACHAR_RE: & | < > ^ % " ! are cmd.exe metacharacters; spaces and paths are not', () => {
  for (const c of ['&', '|', '<', '>', '^', '%', '"', '!']) assert.ok(WIN_CMD_METACHAR_RE.test(`a${c}b`), c);
  for (const s of ['-y', 'a b', 'C:\\Program Files\\nodejs\\npx.cmd', '@scope/pkg@1.2.3']) assert.ok(!WIN_CMD_METACHAR_RE.test(s), s);
});
