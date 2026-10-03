// test/terminal-store.test.mjs — sessions, blocks, audit and branch worktree rows (#573).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempHome } from './helpers/temp-home.mjs';
import * as store from '../src/core/terminal/store.mjs';

useTempHome(after);
const T0 = Date.parse('2026-10-03T10:00:00.000Z');
const session = (id, extra = {}) => ({ id, scope: 'run', label: 'run r1 · app', runId: 'r1', member: 'app-0000aaaa', projectKey: 'app-0000aaaa',
  branch: 'f', cwd: '/tmp/x', shell: '/bin/bash', shellKind: 'bash', mode: 'pipes', integration: false, status: 'running',
  pid: 4242, createdBy: 'ada@example.com', createdAt: new Date(T0).toISOString(), ...extra });

test('a block records command, output, exit, duration and who ran it', () => {
  store.insertSession(session('t-1'));
  const started = store.startBlock({ sessionId: 't-1', seq: 1, command: 'npm test', cwd: '/tmp/x', runId: 'r1', member: 'app-0000aaaa', runBy: 'ada@example.com', now: T0 });
  assert.equal(started.status, 'running');
  const done = store.finishBlock({ sessionId: 't-1', seq: 1, status: 'done', exitCode: 1, output: 'FAIL\n', outputBytes: 5, now: T0 + 1500 });
  assert.deepEqual({ ...done, output: undefined }, { sessionId: 't-1', seq: 1, source: 'person', runId: 'r1', member: 'app-0000aaaa',
    command: 'npm test', cwd: '/tmp/x', status: 'done', exitCode: 1, startedAt: '2026-10-03T10:00:00.000Z', endedAt: '2026-10-03T10:00:01.500Z',
    durationMs: 1500, outputBytes: 5, truncated: false, runBy: 'ada@example.com', stoppedBy: null, output: undefined });
  assert.equal(store.getBlock('t-1', 1).output, 'FAIL\n');
  assert.equal(store.listBlocks({ runId: 'r1' }).length, 1);
  assert.equal(store.listBlocks({ sessionId: 't-1', afterSeq: 1 }).length, 0);
});

test('the audit log keeps who did what, and when', () => {
  store.recordAudit({ sessionId: 't-1', runId: 'r1', actor: 'ada@example.com', action: 'open', detail: '/tmp/x', now: T0 });
  store.recordAudit({ sessionId: 't-1', blockSeq: 1, runId: 'r1', actor: 'ada@example.com', action: 'command', detail: 'npm test', now: T0 + 1 });
  assert.deepEqual(store.listAudit({ sessionId: 't-1' }).map((a) => [a.action, a.actor, a.detail]),
    [['open', 'ada@example.com', '/tmp/x'], ['command', 'ada@example.com', 'npm test']]);
});

test('endSession and getSession', () => {
  store.endSession('t-1', { status: 'closed', exitCode: 0, closedBy: 'bob', now: T0 + 2000 });
  const s = store.getSession('t-1');
  assert.equal(s.status, 'closed');
  assert.equal(s.closedBy, 'bob');
  assert.equal(s.endedAt, '2026-10-03T10:00:02.000Z');
});

test('markInterruptedSessions marks a dead owner\'s rows and their running blocks', async () => {
  store.insertSession(session('t-2'));
  store.startBlock({ sessionId: 't-2', seq: 1, command: 'sleep 99', now: T0 });
  // insertSession stamps owner_pid = this process; pretend another, dead server owned it.
  const { getDb } = await import('../src/core/db.mjs');
  getDb().prepare('UPDATE terminal_sessions SET owner_pid = 999999 WHERE id = ?').run('t-2');
  assert.equal(store.markInterruptedSessions({ isAlive: () => false, now: T0 + 5 }), 1);
  assert.equal(store.getSession('t-2').status, 'interrupted');
  assert.equal(store.getBlock('t-2', 1).status, 'interrupted');
  assert.equal(store.markInterruptedSessions({ isAlive: () => false }), 0, 'idempotent');
});

test('a running row stamped with this very pid is stale unless it is live here (pid reuse after a container restart)', () => {
  store.insertSession(session('t-3'));                         // owner_pid = process.pid
  store.insertSession(session('t-4'));
  assert.equal(store.markInterruptedSessions({ isAlive: () => true, liveIds: new Set(['t-4']) }), 1);
  assert.equal(store.getSession('t-3').status, 'interrupted');
  assert.equal(store.getSession('t-4').status, 'running', 'a live session of this server is left alone');
});

test('branch worktree rows', () => {
  store.insertBranchWorktree({ dir: '/w/a', projectKey: 'app-0000aaaa', branch: 'feat/x', by: 'ada', now: T0 });
  store.insertBranchWorktree({ dir: '/w/b', projectKey: 'app-0000aaaa', branch: 'feat/y', detached: true, now: T0 + 10 });
  assert.equal(store.findBranchWorktree('app-0000aaaa', 'feat/x').dir, '/w/a');
  store.touchBranchWorktree('/w/a', T0 + 20);
  assert.deepEqual(store.listBranchWorktrees().map((w) => w.dir), ['/w/b', '/w/a'], 'least recently used first');
  store.deleteBranchWorktree('/w/b');
  assert.equal(store.getBranchWorktree('/w/b'), null);
});
