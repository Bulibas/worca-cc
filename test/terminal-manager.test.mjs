// test/terminal-manager.test.mjs — worca-owned sessions: blocks with authors, stop, close, pid file (#573).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, renameSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTempHome } from './helpers/temp-home.mjs';
import { TerminalManager, MAX_SESSIONS, REPLAY_CHARS } from '../src/core/terminal/manager.mjs';
import { listAudit, getBlock, getSession } from '../src/core/terminal/store.mjs';
import { pidAlive } from '../src/core/terminal/pty.mjs';

useTempHome(after);
const work = mkdtempSync(join(tmpdir(), 'term-mgr-'));
after(() => rmSync(work, { recursive: true, force: true }));
const BASH = (() => { const r = spawnSync('/bin/sh', ['-c', 'command -v bash'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; })();
const pidFile = join(work, 'live.json');
const mgr = new TerminalManager({ pidFile, ptyInfo: () => ({ pty: null, reason: 'test' }), shell: () => ({ file: BASH, kind: 'bash', platform: process.platform }) });
after(() => mgr.closeAll());
const baseEnv = { PATH: process.env.PATH, HOME: work };

function waitFor(pred, ms = 15000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => { const v = pred(); if (v) return resolve(v); if (Date.now() - t0 > ms) return reject(new Error('timed out')); setTimeout(tick, 25); };
    tick();
  });
}
const blocks = [];
mgr.on('block', (b) => blocks.push(b));

test('a command becomes a block attributed to whoever pressed Enter', { skip: !BASH }, async () => {
  const s = await mgr.open({ cwd: work, scope: 'run', label: 'r1 · app', runId: 'r1', member: 'app', projectKey: 'app', by: 'ada', baseEnv });
  assert.equal(s.mode, 'pipes');
  mgr.write(s.id, 'echo hi\n', 'bob');
  const done = await waitFor(() => blocks.find((b) => b.sessionId === s.id && b.status === 'done'));
  assert.equal(done.command, 'echo hi');
  assert.equal(done.exitCode, 0);
  assert.equal(done.runBy, 'bob');
  assert.match(getBlock(s.id, done.seq).output, /hi/);
  assert.equal(mgr.get(s.id).integration, true);
  assert.deepEqual(listAudit({ sessionId: s.id }).map((a) => [a.action, a.actor]), [['open', 'ada'], ['command', 'bob']]);
  assert.match(mgr.replay(s.id).data, /hi/);
  const live = JSON.parse(readFileSync(pidFile, 'utf8'));
  assert.deepEqual(live.map((r) => [r.sessionId, r.instanceId]), [[s.id, `term:r1:${s.id}`]]);
});

test('Stop ends a running command and records who stopped it', { skip: !BASH }, async () => {
  const s = mgr.list().find((x) => x.status === 'running');
  mgr.write(s.id, 'sleep 30\n', 'ada');
  await waitFor(() => mgr.get(s.id).currentBlock?.command === 'sleep 30');
  const t0 = Date.now();
  mgr.interrupt(s.id, 'cy');
  const stopped = await waitFor(() => blocks.find((b) => b.sessionId === s.id && b.command === 'sleep 30' && b.status !== 'running'));
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.stoppedBy, 'cy');
  assert.ok(Date.now() - t0 < 2500, 'Ctrl+C ended it; the 3 s SIGKILL escalation was not needed');
  assert.ok(listAudit({ sessionId: s.id }).some((a) => a.action === 'stop' && a.actor === 'cy'));
});

test('close ends the shell and a backgrounded job too; the pid file empties', { skip: !BASH || process.platform === 'win32' }, async () => {
  const s = mgr.list().find((x) => x.status === 'running');
  mgr.write(s.id, 'sleep 300 & echo bg=$!\n', 'ada');        // unquoted: `!"` is history expansion in an interactive bash
  const bg = await waitFor(() => { const m = /bg=(\d+)/.exec(mgr.replay(s.id).data); return m && Number(m[1]); });
  await mgr.close(s.id, 'ada');
  assert.equal(mgr.get(s.id).status, 'closed');
  assert.equal(getSession(s.id).closedBy, 'ada');
  await waitFor(() => !pidAlive(bg));
  assert.deepEqual(JSON.parse(readFileSync(pidFile, 'utf8')), []);
});

test('the folder watch notices a removed and a re-created folder', { skip: !BASH }, async () => {
  const dir = join(work, 'wt');
  mkdirSync(dir);
  const s = await mgr.open({ cwd: dir, scope: 'run', runId: 'r2', by: 'ada', baseEnv });
  renameSync(dir, join(work, 'wt-old'));
  mgr.checkFolders();
  assert.equal(mgr.get(s.id).folder, 'gone');
  mkdirSync(dir);
  mgr.checkFolders();
  assert.equal(mgr.get(s.id).folder, 'replaced');
  await mgr.close(s.id, 'ada');
});

test('a flood goes out in bounded frames, and a reload replays exactly the last REPLAY_CHARS', { skip: !BASH }, async () => {
  const s = await mgr.open({ cwd: work, scope: 'run', by: 'ada', baseEnv });
  const sizes = [];
  const onData = (d) => { if (d.sessionId === s.id) sizes.push(d.data.length); };
  mgr.on('data', onData);
  mgr.write(s.id, 'head -c 2000000 /dev/zero | tr "\\0" x; echo; echo END\n', 'ada');
  await waitFor(() => blocks.find((b) => b.sessionId === s.id && b.command.startsWith('head -c') && b.status === 'done'), 30000);
  mgr.off('data', onData);
  assert.ok(Math.max(...sizes) < 192 * 1024, `largest frame ${Math.max(...sizes)} chars`);
  const r = mgr.replay(s.id).data;
  assert.equal(r.length, REPLAY_CHARS);
  assert.match(r, /END/);
  await mgr.close(s.id, 'ada');
});

test('at most MAX_SESSIONS live sessions; a missing folder is refused', async () => {
  await assert.rejects(mgr.open({ cwd: join(work, 'nope'), scope: 'run', by: 'ada', baseEnv }), { code: 'NO_FOLDER' });
  const fake = new TerminalManager({ ptyInfo: () => ({ pty: null }), shell: () => ({ file: '/bin/sh', kind: 'other', platform: process.platform }),
    spawnImpl: () => ({ pid: null, mode: 'pipes', write() {}, resize() {}, signal() {}, onData() {}, onExit() {} }) });
  for (let i = 0; i < MAX_SESSIONS; i++) await fake.open({ cwd: work, scope: 'run', by: 'x', baseEnv });
  await assert.rejects(fake.open({ cwd: work, scope: 'run', by: 'x', baseEnv }), { code: 'TOO_MANY_SESSIONS' });
});

test('a PTY that cannot spawn falls back to pipes, says why, and stays on pipes', async () => {
  const calls = [];
  const fakeProc = { pid: null, mode: 'pipes', write() {}, resize() {}, signal() {}, onData() {}, onExit() {} };
  const m = new TerminalManager({ ptyInfo: () => ({ pty: {}, reason: null }), shell: () => ({ file: '/bin/sh', kind: 'other', platform: process.platform }),
    spawnImpl: (o) => { calls.push([o.pty ? 'pty' : 'pipes', o.env.TERM]); if (o.pty) throw new Error('posix_spawnp failed.'); return fakeProc; } });
  const s = await m.open({ cwd: work, scope: 'run', by: 'ada', baseEnv });
  assert.equal(s.mode, 'pipes');
  assert.match(m.ptyStatus().reason, /posix_spawnp failed/);
  await m.open({ cwd: work, scope: 'run', by: 'ada', baseEnv });
  assert.deepEqual(calls, [['pty', 'xterm-256color'], ['pipes', 'dumb'], ['pipes', 'dumb']]);
});
