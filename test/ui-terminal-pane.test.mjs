// test/ui-terminal-pane.test.mjs — the right-side terminal pane (#573): follows the page, opens, attaches,
// checks out, shows blocks, pipes banner, the hosted message. xterm is faked (jsdom has no canvas).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createTerminalPane, paneTargetOf, formatDuration, blockStatusLabel } from '../ui/public/terminal-pane.mjs';

const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

function fakeXterm() {
  const writes = [];
  let onKeys = null;
  class Terminal {
    constructor(o) { this.options = { ...o }; this.cols = 80; this.rows = 24; }
    loadAddon() {} open() {} focus() {} dispose() {}
    write(d) { writes.push(d); } reset() { writes.length = 0; }
    onData(cb) { onKeys = cb; return { dispose() {} }; }
  }
  class FitAddon { fit() {} }
  return { load: async () => ({ Terminal, FitAddon }), writes, type: (d) => onKeys(d) };
}

function makePane({ ctx, routes }) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost:4317/' });
  const sent = [];
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ method, url, body: opts.body ? JSON.parse(opts.body) : null });
    const h = routes[`${method} ${url.split('?')[0]}`];
    const v = typeof h === 'function' ? h(url, opts) : h;
    const status = v?.__status || (v === undefined ? 404 : 200);
    return { ok: status < 400, status, json: async () => v ?? {} };
  };
  const xt = fakeXterm();
  const pane = createTerminalPane({ doc: dom.window.document, win: dom.window, fetch, sendWs: (m) => sent.push(m),
    getPageContext: () => ctx, storage: null, loadXterm: xt.load });
  dom.window.document.body.append(pane.root, pane.handle);
  return { pane, doc: dom.window.document, sent, calls, xt };
}

const INFO = { enabled: true, pty: { available: true, reason: null }, maxSessions: 16, sessions: [] };
const RUN_CTX = { view: 'running', runId: 'uuid-1', pipelineId: 'r1', projectDir: '/p/app' };
const SNAP = { id: 't-1', scope: 'run', label: 'r1 · app', runId: 'r1', member: 'app-0000aaaa', mode: 'pty', integration: true,
  status: 'running', runLive: true, folder: 'ok', currentBlock: null, createdAt: '2026-10-03T10:00:00.000Z' };

test('paneTargetOf follows the page', () => {
  assert.deepEqual(paneTargetOf(RUN_CTX), { kind: 'run', runId: 'r1', query: 'projectDir=%2Fp%2Fapp' });
  assert.deepEqual(paneTargetOf({ view: 'history-detail', pipelineId: 'r2', workspaceId: 'wks-1' }), { kind: 'run', runId: 'r2', query: 'workspaceId=wks-1' });
  assert.deepEqual(paneTargetOf({ view: 'project-detail', projectKey: 'app-0000aaaa' }), { kind: 'project', projectKey: 'app-0000aaaa' });
  assert.deepEqual(paneTargetOf({ view: 'stats' }), { kind: 'other' });
  assert.deepEqual(paneTargetOf({ view: 'running', runId: 'live-1', pipelineId: 'r3', workspaceId: 'workspaces/wks-2' }),
    { kind: 'run', runId: 'r3', query: 'workspaceId=wks-2' });
  assert.deepEqual(paneTargetOf({ view: 'running', runId: 'live-1' }), { kind: 'pending' });
});

test('formatDuration and blockStatusLabel', () => {
  assert.equal(formatDuration(420), '420 ms');
  assert.equal(formatDuration(2500), '2.5 s');
  assert.equal(formatDuration(125000), '2 min 5 s');
  assert.deepEqual(blockStatusLabel({ status: 'done', exitCode: 0 }), { text: 'exit 0', tone: 'ok' });
  assert.deepEqual(blockStatusLabel({ status: 'done', exitCode: 2 }), { text: 'exit 2', tone: 'bad' });
  assert.deepEqual(blockStatusLabel({ status: 'stopped' }), { text: 'stopped', tone: 'bad' });
});

test('a live run: the warning, Open terminal posts the member and size, then attaches', async () => {
  const { pane, doc, sent, calls } = makePane({ ctx: RUN_CTX, routes: {
    'GET /api/terminal': INFO,
    'GET /api/runs/r1/terminal': { enabled: true, live: true, workspace: false, sessions: [],
      members: [{ projectKey: 'app-0000aaaa', projectName: 'app', state: 'worktree', cwd: '/runs/r1/repos/app', warning: 'This pipeline is still running and changing these files.' }] },
    'POST /api/runs/r1/terminal': { session: SNAP, warning: null },
    'GET /api/terminal/sessions/t-1': { session: SNAP, blocks: [] },
  } });
  await pane.open();
  await tick();
  assert.equal(doc.body.classList.contains('term-open'), true);
  assert.match(doc.querySelector('.term-context').textContent, /still running and changing these files/);
  doc.querySelector('.term-new').click();
  await tick();
  const post = calls.find((c) => c.method === 'POST');
  assert.equal(post.url, '/api/runs/r1/terminal?projectDir=%2Fp%2Fapp');
  assert.deepEqual(post.body, { member: 'app-0000aaaa', cols: 80, rows: 24 });
  assert.ok(sent.some((m) => m.type === 'term-attach' && m.sessionId === 't-1'));
});

test('a finished run without a checkout offers Check out', async () => {
  const { pane, doc, calls } = makePane({ ctx: RUN_CTX, routes: {
    'GET /api/terminal': INFO,
    'GET /api/runs/r1/terminal': { enabled: true, live: false, finished: true, workspace: false, sessions: [],
      members: [{ projectKey: 'app-0000aaaa', projectName: 'app', state: 'needs-checkout', cwd: null }] },
    'POST /api/runs/r1/checkout': { members: [] },
  } });
  await pane.open();
  await tick();
  doc.querySelector('.term-checkout').click();
  await tick();
  const c = calls.find((x) => x.method === 'POST');
  assert.equal(c.url, '/api/runs/r1/checkout?projectDir=%2Fp%2Fapp');
  assert.deepEqual(c.body, { members: ['app-0000aaaa'] });
});

test('a workspace run has a member picker', async () => {
  const { pane, doc } = makePane({ ctx: { view: 'running', pipelineId: 'w1', workspaceId: 'wks-1' }, routes: {
    'GET /api/terminal': INFO,
    'GET /api/runs/w1/terminal': { enabled: true, live: true, workspace: true, sessions: [], members: [
      { projectKey: 'api-0000bbbb', projectName: 'api', state: 'worktree', cwd: '/a' }, { projectKey: 'web-0000cccc', projectName: 'web', state: 'worktree', cwd: '/w' }] },
  } });
  await pane.open();
  await tick();
  assert.deepEqual([...doc.querySelectorAll('.term-member option')].map((o) => o.textContent), ['api', 'web']);
});

test('pipes mode: the banner, local echo, and a line sent on Enter', async () => {
  const pipes = { ...SNAP, mode: 'pipes' };
  const { pane, doc, sent, xt } = makePane({ ctx: RUN_CTX, routes: {
    'GET /api/terminal': { ...INFO, pty: { available: false, reason: 'node-pty is not installed on this server (MODULE_NOT_FOUND)' }, sessions: [pipes] },
    'GET /api/runs/r1/terminal': { enabled: true, live: false, workspace: false, sessions: [pipes],
      members: [{ projectKey: 'app-0000aaaa', projectName: 'app', state: 'worktree', cwd: '/x' }] },
    'GET /api/terminal/sessions/t-1': { session: pipes, blocks: [] },
  } });
  await pane.open();
  await tick();
  assert.match(doc.querySelector('.term-banners').textContent, /Full-screen programs \(vim, top, less\) do not work here/);
  xt.type('ls\r');
  assert.ok(xt.writes.includes('ls\r\n'));
  assert.ok(sent.some((m) => m.type === 'term-input' && m.data === 'ls\n'));
});

test('term-block frames render as command rows with status, author and duration', async () => {
  const { pane, doc } = makePane({ ctx: RUN_CTX, routes: {
    'GET /api/terminal': { ...INFO, sessions: [SNAP] },
    'GET /api/runs/r1/terminal': { enabled: true, live: true, workspace: false, sessions: [SNAP], members: [{ projectKey: 'app-0000aaaa', projectName: 'app', state: 'worktree', cwd: '/x' }] },
    'GET /api/terminal/sessions/t-1': { session: SNAP, blocks: [] },
  } });
  await pane.open();
  await tick();
  pane.onFrame({ type: 'term-block', sessionId: 't-1', block: { sessionId: 't-1', seq: 1, command: 'npm test', status: 'done', exitCode: 1,
    durationMs: 2500, runBy: 'ada@example.com', startedAt: '2026-10-03T10:00:00.000Z' } });
  const row = doc.querySelector('.term-block[data-seq="1"]');
  assert.match(row.textContent, /npm test/);
  assert.match(row.textContent, /exit 1/);
  assert.match(row.textContent, /by ada@example\.com/);
  assert.match(row.textContent, /2\.5 s/);
});

test('hosted and off: the pane says how to turn it on', async () => {
  const { pane, doc } = makePane({ ctx: RUN_CTX, routes: { 'GET /api/terminal': { ...INFO, enabled: false } } });
  await pane.open();
  await tick();
  assert.match(doc.querySelector('.term-context').textContent, /WORCA_TERMINAL_REMOTE=1/);
});

test('replay then data: duplicates by seq are dropped', async () => {
  const { pane, xt } = makePane({ ctx: RUN_CTX, routes: {
    'GET /api/terminal': { ...INFO, sessions: [SNAP] },
    'GET /api/runs/r1/terminal': { enabled: true, live: true, workspace: false, sessions: [SNAP], members: [{ projectKey: 'app-0000aaaa', projectName: 'app', state: 'worktree', cwd: '/x' }] },
    'GET /api/terminal/sessions/t-1': { session: SNAP, blocks: [] },
  } });
  await pane.open();
  await tick();
  pane.onFrame({ type: 'term-replay', sessionId: 't-1', data: 'AB', seq: 2 });
  pane.onFrame({ type: 'term-data', sessionId: 't-1', data: 'B', seq: 2 });
  pane.onFrame({ type: 'term-data', sessionId: 't-1', data: 'C', seq: 3 });
  assert.equal(xt.writes.join(''), 'ABC');
});

test('Ctrl+` toggles the pane even from inside the terminal, where xterm stops the event', async () => {
  const { pane, doc } = makePane({ ctx: { view: 'stats' }, routes: { 'GET /api/terminal': INFO } });
  const inner = doc.createElement('textarea');
  inner.addEventListener('keydown', (e) => e.stopPropagation());
  pane.root.querySelector('.term-screen').appendChild(inner);
  inner.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: '`', code: 'Backquote', ctrlKey: true, bubbles: true, cancelable: true }));
  await tick();
  assert.equal(pane.isOpen(), true);
});

test('Run again clears a half-typed line, and never types into a running command', async () => {
  const { pane, doc, sent } = makePane({ ctx: RUN_CTX, routes: {
    'GET /api/terminal': { ...INFO, sessions: [SNAP] },
    'GET /api/runs/r1/terminal': { enabled: true, live: true, workspace: false, sessions: [SNAP], members: [{ projectKey: 'app-0000aaaa', projectName: 'app', state: 'worktree', cwd: '/x' }] },
    'GET /api/terminal/sessions/t-1': { session: SNAP, blocks: [] },
  } });
  await pane.open();
  await tick();
  pane.onFrame({ type: 'term-block', sessionId: 't-1', block: { sessionId: 't-1', seq: 1, command: 'npm test', status: 'done', exitCode: 0, durationMs: 5 } });
  const again = () => [...doc.querySelectorAll('.term-block[data-seq="1"] button')].find((b) => b.textContent === 'Run again');
  again().click();
  assert.deepEqual(sent.filter((m) => m.type === 'term-input').map((m) => m.data), ['\x15npm test\r']);
  pane.onFrame({ type: 'term-status', snapshot: { ...SNAP, currentBlock: { seq: 2, command: 'python3', startedAt: SNAP.createdAt, runBy: 'local' } } });
  again().click();
  assert.equal(sent.filter((m) => m.type === 'term-input').length, 1);
  assert.match(doc.querySelector('.term-context').textContent, /still running in this terminal/);
});
