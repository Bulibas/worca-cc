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
  const made = {};
  class Terminal {
    constructor(o) { this.options = { ...o }; this.cols = 80; this.rows = 24; made.options = this.options; }
    loadAddon() {} open(el) { made.openedIn = el; } focus() {} dispose() {}
    write(d) { writes.push(d); } reset() { writes.length = 0; }
    onData(cb) { onKeys = cb; return { dispose() {} }; }
  }
  class FitAddon { fit() {} }
  return { load: async () => ({ Terminal, FitAddon }), writes, made, type: (d) => onKeys(d) };
}

function makePane({ ctx, routes, url = 'http://localhost:4317/', env = {}, beforeCreate = null }) {
  const dom = new JSDOM('<!doctype html><body></body>', { url });
  if (beforeCreate) beforeCreate(dom.window);
  env.ctx ??= ctx;
  env.online ??= true;
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
  // Like app.js: false while /ws is down, and then nothing is sent.
  const sendWs = (m) => { if (!env.online) return false; sent.push(m); return true; };
  const pane = createTerminalPane({ doc: dom.window.document, win: dom.window, fetch, sendWs,
    getPageContext: () => env.ctx, storage: null, loadXterm: xt.load });
  dom.window.document.body.append(pane.root, pane.handle);
  return { pane, doc: dom.window.document, sent, calls, xt, env };
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

test('a branch warning belongs to its terminal: amber, and gone once another terminal is attached', async () => {
  const DEV = { ...SNAP, id: 't-dev', scope: 'branch', runId: null, member: null, projectKey: 'app-0000aaaa', branch: 'dev', label: 'app · dev' };
  const DOCS = { ...DEV, id: 't-docs', branch: 'docs/x', label: 'app · docs/x' };
  const detached = 'Branch "dev" is checked out in /p/app, so this folder is a detached copy of its latest commit.';
  const { pane, doc } = makePane({ ctx: { view: 'project-detail', projectKey: 'app-0000aaaa' }, routes: {
    'GET /api/terminal': INFO,
    'GET /api/projects/app-0000aaaa/terminal': { enabled: true, sessions: [], branches: ['dev', 'docs/x'], current: 'dev', worktrees: [] },
    'POST /api/projects/app-0000aaaa/terminal': (url, opts) => (JSON.parse(opts.body).branch === 'dev'
      ? { session: DEV, warning: detached } : { session: DOCS, warning: null }),
    'GET /api/terminal/sessions/t-dev': { session: DEV, blocks: [] },
    'GET /api/terminal/sessions/t-docs': { session: DOCS, blocks: [] },
  } });
  await pane.open();
  await tick();
  doc.querySelector('.term-new').click();
  await tick();
  const warn = doc.querySelector('.term-context .term-warn');
  assert.match(warn?.textContent || '', /detached copy/);
  assert.equal(doc.querySelector('.term-context .term-error'), null, 'a warning is not shown as an error');
  const sel = doc.querySelector('.term-branch');
  sel.value = 'docs/x';
  sel.dispatchEvent(new doc.defaultView.Event('change'));
  doc.querySelector('.term-new').click();
  await tick();
  assert.doesNotMatch(doc.querySelector('.term-context').textContent, /detached copy/, 'the dev warning does not follow the docs terminal');
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

const MEMBERS = [{ projectKey: 'app-0000aaaa', projectName: 'app', state: 'worktree', cwd: '/x' }];
const attachedRoutes = (extra = {}) => ({
  'GET /api/terminal': { ...INFO, sessions: [SNAP] },
  'GET /api/runs/r1/terminal': { enabled: true, live: true, workspace: false, sessions: [SNAP], members: MEMBERS },
  'GET /api/terminal/sessions/t-1': { session: SNAP, blocks: [] },
  ...extra,
});
const block = (seq, over = {}) => ({ sessionId: 't-1', seq, command: `cmd ${seq}`, status: 'done', exitCode: 0, durationMs: 5, ...over });

test('xterm opens in an unpadded host inside the framed screen, so FitAddon does not count the frame (finding 1)', async () => {
  const { pane, doc, xt } = makePane({ ctx: RUN_CTX, routes: attachedRoutes() });
  await pane.open();
  await tick();
  assert.equal(xt.made.openedIn, doc.querySelector('.term-screen > .term-host'));
});

test('attach fits and sends the size, so a session opened at another width gets this one (finding 5)', async () => {
  const { pane, sent } = makePane({ ctx: RUN_CTX, routes: attachedRoutes() });
  await pane.open();
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(sent.some((m) => m.type === 'term-resize' && m.sessionId === 't-1' && m.cols === 80 && m.rows === 24));
});

test('the Commands list is the newest page: the count is the total, and a note says older ones are not listed (finding 2)', async () => {
  const page = Array.from({ length: 200 }, (_, i) => block(i + 101));
  const { pane, doc } = makePane({ ctx: RUN_CTX, routes: attachedRoutes({ 'GET /api/terminal/sessions/t-1': { session: SNAP, blocks: page, totalBlocks: 300 } }) });
  await pane.open();
  await tick();
  const tab = [...doc.querySelectorAll('.term-tab')].find((b) => /Commands/.test(b.textContent));
  assert.equal(tab.textContent, 'Commands (300)');
  assert.match(doc.querySelector('.term-blocks').textContent, /Showing the latest 200 of 300 commands/);
  pane.onFrame({ type: 'term-block', sessionId: 't-1', block: block(301) });
  assert.equal(tab.textContent, 'Commands (301)');
  assert.match(doc.querySelector('.term-blocks').textContent, /Showing the latest 201 of 301 commands/);
  pane.onFrame({ type: 'term-block', sessionId: 't-1', block: block(301, { exitCode: 1 }) });
  assert.equal(tab.textContent, 'Commands (301)', 'an update of a listed command is not a new one');
});

test('a full page from a server without totalBlocks still says older ones may exist', async () => {
  const page = Array.from({ length: 200 }, (_, i) => block(i + 101));
  const { pane, doc } = makePane({ ctx: RUN_CTX, routes: attachedRoutes({ 'GET /api/terminal/sessions/t-1': { session: SNAP, blocks: page } }) });
  await pane.open();
  await tick();
  assert.equal([...doc.querySelectorAll('.term-tab')].find((b) => /Commands/.test(b.textContent)).textContent, 'Commands (200+)');
  assert.match(doc.querySelector('.term-blocks').textContent, /Showing the latest 200 commands/);
});

test('a short history has a plain count and no note', async () => {
  const { pane, doc } = makePane({ ctx: RUN_CTX, routes: attachedRoutes({ 'GET /api/terminal/sessions/t-1': { session: SNAP, blocks: [block(1), block(2)] } }) });
  await pane.open();
  await tick();
  assert.equal([...doc.querySelectorAll('.term-tab')].find((b) => /Commands/.test(b.textContent)).textContent, 'Commands (2)');
  assert.equal(doc.querySelector('.term-trimmed'), null);
});

test('a permalink to a command older than the listed page fetches that command on its own (finding 2)', async () => {
  const page = Array.from({ length: 200 }, (_, i) => block(i + 101));
  const { doc, calls } = makePane({ ctx: { view: 'stats' }, url: 'http://localhost:4317/?terminal=t-1&block=7', routes: attachedRoutes({
    'GET /api/terminal/sessions/t-1': { session: SNAP, blocks: page, totalBlocks: 300 },
    'GET /api/terminal/sessions/t-1/blocks/7': { ...block(7, { command: 'make old' }), output: 'lots' },
  }) });
  await tick(20);
  assert.ok(calls.some((c) => c.url === '/api/terminal/sessions/t-1/blocks/7'));
  assert.match(doc.querySelector('.term-block[data-seq="7"]').textContent, /make old/);
});

test('a permalink to a command that does not exist says so', async () => {
  const { doc } = makePane({ ctx: { view: 'stats' }, url: 'http://localhost:4317/?terminal=t-1&block=9', routes: attachedRoutes() });
  await tick(20);
  assert.match(doc.querySelector('.term-context').textContent, /Command #9 of this terminal was not found/);
});

test('moving to a run without a terminal lets go of the previous shell (finding 3)', async () => {
  const env = {};
  const { pane, doc, sent, xt } = makePane({ ctx: RUN_CTX, env, routes: attachedRoutes({
    'GET /api/runs/r2/terminal': { enabled: true, live: false, workspace: false, sessions: [], members: [{ ...MEMBERS[0], cwd: '/runs/r2' }] },
  }) });
  await pane.open();
  await tick();
  pane.onFrame({ type: 'term-data', sessionId: 't-1', data: 'old output', seq: 1 });
  env.ctx = { ...RUN_CTX, pipelineId: 'r2' };
  pane.onContextChange();
  await tick();
  assert.ok(sent.some((m) => m.type === 'term-detach' && m.sessionId === 't-1'));
  assert.deepEqual(xt.writes, [], 'the old screen is cleared');
  assert.match(doc.querySelector('.term-context').textContent, /\/runs\/r2/);
  assert.equal(doc.querySelector('.term-new').textContent, 'Open terminal');
  assert.equal(doc.querySelector('.term-sessions').value, '');
  const before = sent.length;
  xt.type('rm -rf build\r');
  assert.equal(sent.slice(before).filter((m) => m.type === 'term-input').length, 0, 'no keystroke reaches the other run\'s shell');
});

test('a page change while the pane is closed also lets go of the shell', async () => {
  const env = {};
  const { pane, sent } = makePane({ ctx: RUN_CTX, env, routes: attachedRoutes() });
  await pane.open();
  await tick();
  pane.close();
  env.ctx = { view: 'project-detail', projectKey: 'web-0000cccc' };
  pane.onContextChange();
  await tick();
  assert.ok(sent.some((m) => m.type === 'term-detach' && m.sessionId === 't-1'));
});

test('an expanded Output and an open select survive unrelated updates (finding 6)', async () => {
  const { pane, doc } = makePane({ ctx: { view: 'running', pipelineId: 'w1', workspaceId: 'wks-1' }, routes: {
    'GET /api/terminal': { ...INFO, sessions: [] },
    'GET /api/runs/w1/terminal': { enabled: true, live: true, workspace: true, sessions: [], members: [
      { projectKey: 'api-0000bbbb', projectName: 'api', state: 'worktree', cwd: '/a' }, { projectKey: 'web-0000cccc', projectName: 'web', state: 'worktree', cwd: '/w' }] },
    'GET /api/terminal/sessions/t-1': { session: SNAP, blocks: [block(1, { status: 'running', exitCode: null })] },
    'GET /api/terminal/sessions/t-1/blocks/1': { ...block(1), output: 'hello' },
  } });
  await pane.open();
  await tick();
  // a shell opens on the api member (its status frame), and the picker attaches it
  pane.onFrame({ type: 'term-status', snapshot: { ...SNAP, runId: 'w1', member: 'api-0000bbbb' } });
  doc.querySelector('.term-sessions').value = 't-1';
  doc.querySelector('.term-sessions').dispatchEvent(new doc.defaultView.Event('change'));
  await tick();
  const member = doc.querySelector('.term-member');
  const pickerOpts = [...doc.querySelectorAll('.term-sessions option')];
  pane.onFrame({ type: 'term-status', snapshot: { ...SNAP, runId: 'w1', member: 'api-0000bbbb', currentBlock: { seq: 1, command: 'cmd 1' } } });
  assert.equal(doc.querySelector('.term-member'), member, 'the member select is not rebuilt by a status frame');
  assert.deepEqual([...doc.querySelectorAll('.term-sessions option')], pickerOpts, 'nor is the session picker');
  const row = doc.querySelector('.term-block[data-seq="1"]');
  [...row.querySelectorAll('button')].find((b) => b.textContent === 'Output').click();
  await tick();
  const out = row.querySelector('.term-out');
  assert.equal(out.hidden, false);
  assert.match(out.textContent, /hello/);
  pane.onFrame({ type: 'term-status', snapshot: { ...SNAP, runId: 'w1', member: 'api-0000bbbb', currentBlock: null } });
  pane.onFrame({ type: 'term-block', sessionId: 't-1', block: block(2) });
  pane.onFrame({ type: 'term-block', sessionId: 't-1', block: block(1, { exitCode: 3 }) });
  assert.equal(doc.querySelector('.term-block[data-seq="1"]'), row, 'the row is patched, not rebuilt');
  assert.equal(out.hidden, false);
  assert.match(row.textContent, /exit 3/);
  assert.deepEqual([...doc.querySelectorAll('.term-block')].map((r) => r.dataset.seq), ['2', '1']);
});

test('xterm gets all 16 ANSI colours, each from its --term-ansi-* token (finding 7)', async () => {
  const { pane, xt } = makePane({ ctx: RUN_CTX, routes: attachedRoutes(), beforeCreate: (win) => {
    const real = win.getComputedStyle.bind(win);
    // jsdom resolves no var(): answer with the token name each probe asks for.
    win.getComputedStyle = (el) => {
      const v = el.style?.getPropertyValue?.('color') || '';
      return v.startsWith('var(') ? { color: v.slice(4, -1) } : real(el);
    };
  } });
  await pane.open();
  await tick();
  const t = xt.made.options.theme;
  assert.equal(t.red, '--term-ansi-red');
  assert.equal(t.brightWhite, '--term-ansi-bright-white');
  assert.equal(['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'].flatMap((c) => [c, `bright${c[0].toUpperCase()}${c.slice(1)}`])
    .filter((k) => t[k]).length, 16);
});

test('pipes mode: Run again drops the half-typed line and echoes the command (finding 8)', async () => {
  const pipes = { ...SNAP, mode: 'pipes' };
  const { pane, doc, sent, xt } = makePane({ ctx: RUN_CTX, routes: attachedRoutes({
    'GET /api/terminal': { ...INFO, sessions: [pipes] },
    'GET /api/runs/r1/terminal': { enabled: true, live: false, workspace: false, sessions: [pipes], members: MEMBERS },
    'GET /api/terminal/sessions/t-1': { session: pipes, blocks: [] },
  }) });
  await pane.open();
  await tick();
  pane.onFrame({ type: 'term-block', sessionId: 't-1', block: block(1, { command: 'npm test' }) });
  xt.type('ab');
  [...doc.querySelectorAll('.term-block[data-seq="1"] button')].find((b) => b.textContent === 'Run again').click();
  assert.ok(xt.writes.includes('\b \b\b \bnpm test\r\n'));
  xt.type('\r');
  assert.deepEqual(sent.filter((m) => m.type === 'term-input').map((m) => m.data), ['npm test\n', '\n']);
});

test('a server restart forgets the shell, its screen, its commands and the stale picker entries (finding 9)', async () => {
  const routes = attachedRoutes({ 'GET /api/terminal/sessions/t-1': { session: SNAP, blocks: [block(1)] } });
  const { pane, doc, sent, xt } = makePane({ ctx: { view: 'stats' }, routes });
  pane.onHello({ type: 'hello', bootId: 'boot-a' });
  await pane.open();
  doc.querySelector('.term-sessions').value = 't-1';
  doc.querySelector('.term-sessions').dispatchEvent(new doc.defaultView.Event('change'));
  await tick();
  pane.onFrame({ type: 'term-data', sessionId: 't-1', data: 'before', seq: 1 });
  assert.ok(doc.querySelector('.term-block[data-seq="1"]'));
  routes['GET /api/terminal'] = { ...INFO, sessions: [] };
  pane.onHello({ type: 'hello', bootId: 'boot-b' });
  await tick();
  assert.deepEqual(xt.writes, []);
  assert.equal(doc.querySelector('.term-block'), null);
  assert.equal(doc.querySelector('.term-sessions').hidden, true);
  assert.match(doc.querySelector('.term-context').textContent, /server restarted/);
  const before = sent.length;
  xt.type('ls\r');
  assert.equal(sent.slice(before).filter((m) => m.type === 'term-input').length, 0);
});

test('the picker drops sessions the server no longer lists', async () => {
  const routes = { 'GET /api/terminal': { ...INFO, sessions: [SNAP, { ...SNAP, id: 't-2', label: 'gone' }] } };
  const { pane, doc } = makePane({ ctx: { view: 'stats' }, routes });
  await pane.open();
  await tick();
  assert.equal(doc.querySelectorAll('.term-sessions option[value^="t-"]').length, 2);
  pane.close();
  routes['GET /api/terminal'] = { ...INFO, sessions: [SNAP] };
  await pane.open();
  await tick();
  assert.deepEqual([...doc.querySelectorAll('.term-sessions option[value^="t-"]')].map((o) => o.value), ['t-1']);
});

test('while /ws reconnects the pane says so and does not echo a line it could not send (finding 10)', async () => {
  const pipes = { ...SNAP, mode: 'pipes' };
  const env = {};
  const { pane, doc, sent, xt } = makePane({ ctx: RUN_CTX, env, routes: attachedRoutes({
    'GET /api/terminal': { ...INFO, sessions: [pipes] },
    'GET /api/runs/r1/terminal': { enabled: true, live: false, workspace: false, sessions: [pipes], members: MEMBERS },
    'GET /api/terminal/sessions/t-1': { session: pipes, blocks: [] },
  }) });
  await pane.open();
  await tick();
  env.online = false;
  pane.onConnection(false);
  assert.match(doc.querySelector('.term-banners').textContent, /Reconnecting to the worca server\. Keys typed now are not sent\./);
  xt.type('ls\r');
  assert.equal(xt.writes.join(''), '', 'no local echo of keys that go nowhere');
  env.online = true;
  pane.onHello({ type: 'hello', bootId: null });
  assert.doesNotMatch(doc.querySelector('.term-banners').textContent, /Reconnecting/);
  xt.type('ls\r');
  assert.ok(sent.some((m) => m.type === 'term-input' && m.data === 'ls\n'));
});

test('a send that fails mid-line (the socket just dropped) shows the reconnecting state and says the line was not sent', async () => {
  const pipes = { ...SNAP, mode: 'pipes' };
  const env = {};
  const { pane, doc, xt } = makePane({ ctx: RUN_CTX, env, routes: attachedRoutes({
    'GET /api/terminal': { ...INFO, sessions: [pipes] },
    'GET /api/runs/r1/terminal': { enabled: true, live: false, workspace: false, sessions: [pipes], members: MEMBERS },
    'GET /api/terminal/sessions/t-1': { session: pipes, blocks: [] },
  }) });
  await pane.open();
  await tick();
  xt.type('ls');
  env.online = false;
  xt.type('\r');
  assert.match(xt.writes.join(''), /\[not sent: reconnecting\]/);
  assert.match(doc.querySelector('.term-banners').textContent, /Reconnecting/);
});
