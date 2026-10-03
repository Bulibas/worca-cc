// test/ui-terminal-pane.test.mjs — the right-side terminal pane (#573): follows the page, starts or
// reattaches its shell on open (once), checks out first, Enter restarts an ended shell, shows blocks, the
// pipes banner, the hosted message. xterm is faked (jsdom has no canvas).
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

const MEMBERS = [{ projectKey: 'app-0000aaaa', projectName: 'app', state: 'worktree', cwd: '/x' }];
const attachedRoutes = (extra = {}) => ({
  'GET /api/terminal': { ...INFO, sessions: [SNAP] },
  'GET /api/runs/r1/terminal': { enabled: true, live: true, workspace: false, sessions: [SNAP], members: MEMBERS },
  'GET /api/terminal/sessions/t-1': { session: SNAP, blocks: [] },
  ...extra,
});
const block = (seq, over = {}) => ({ sessionId: 't-1', seq, command: `cmd ${seq}`, status: 'done', exitCode: 0, durationMs: 5, ...over });

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

const posts = (calls, path) => calls.filter((c) => c.method === 'POST' && (!path || c.url.split('?')[0] === path));
const LIVE_MEMBER = { projectKey: 'app-0000aaaa', projectName: 'app', state: 'worktree', cwd: '/runs/r1/repos/app',
  warning: 'This pipeline is still running and changing these files.' };

test('a live run: opening the pane starts a shell in its folder, with the member and size, attaches it and warns', async () => {
  const { pane, doc, sent, calls } = makePane({ ctx: RUN_CTX, routes: {
    'GET /api/terminal': INFO,
    'GET /api/runs/r1/terminal': { enabled: true, live: true, workspace: false, sessions: [], members: [LIVE_MEMBER] },
    'POST /api/runs/r1/terminal': { session: { ...SNAP, cwd: LIVE_MEMBER.cwd }, warning: LIVE_MEMBER.warning },
    'GET /api/terminal/sessions/t-1': { session: SNAP, blocks: [] },
  } });
  await pane.open();
  await tick();
  assert.equal(doc.body.classList.contains('term-open'), true);
  const [post] = posts(calls);
  assert.equal(posts(calls).length, 1);
  assert.equal(post.url, '/api/runs/r1/terminal?projectDir=%2Fp%2Fapp');
  assert.deepEqual(post.body, { member: 'app-0000aaaa', cols: 80, rows: 24 });
  assert.ok(sent.some((m) => m.type === 'term-attach' && m.sessionId === 't-1'));
  const ctx = doc.querySelector('.term-context');
  assert.equal(ctx.querySelector('.term-folder').textContent, '/runs/r1/repos/app');
  assert.match(ctx.querySelector('.term-warn').textContent, /still running and changing these files/);
  assert.equal(ctx.querySelector('button'), null, 'no buttons in the context line');
});

test('the header: title, the hide button and the Commands toggle; no Stop, Close, Open or branch controls', async () => {
  const { pane, doc } = makePane({ ctx: RUN_CTX, routes: attachedRoutes() });
  await pane.open();
  await tick();
  const labels = [...doc.querySelectorAll('.term-pane button')].map((b) => b.getAttribute('aria-label') || b.textContent);
  assert.deepEqual(labels, ['Commands', 'Hide the terminal pane']);
  for (const gone of ['.term-stop', '.term-close-session', '.term-new', '.term-checkout', '.term-branch', '.term-tabs', '.term-wt-remove']) {
    assert.equal(doc.querySelector(gone), null, gone);
  }
});

test('reopening the pane on the same page reattaches its running shell instead of starting another', async () => {
  const routes = attachedRoutes();
  const { pane, calls, sent } = makePane({ ctx: RUN_CTX, routes });
  await pane.open();
  await tick();
  pane.close();
  await pane.open();
  await tick();
  assert.equal(posts(calls).length, 0);
  assert.equal(sent.filter((m) => m.type === 'term-detach').length, 0, 'hiding the pane keeps the shell attached');
});

test('a project page: the shell opens in the project\'s own folder (no branch in the request)', async () => {
  const PROJ = { ...SNAP, id: 't-p', scope: 'project', runId: null, member: null, projectKey: 'app-0000aaaa', branch: 'dev', cwd: '/p/app', label: 'app · dev', runLive: false };
  const { pane, doc, calls, sent } = makePane({ ctx: { view: 'project-detail', projectKey: 'app-0000aaaa' }, routes: {
    'GET /api/terminal': INFO,
    'GET /api/projects/app-0000aaaa/terminal': { enabled: true, sessions: [], dir: '/p/app', branches: ['dev'], current: 'dev', worktrees: [] },
    'POST /api/projects/app-0000aaaa/terminal': { session: PROJ, warning: null },
    'GET /api/terminal/sessions/t-p': { session: PROJ, blocks: [] },
  } });
  await pane.open();
  await tick();
  const p = posts(calls);
  assert.equal(p.length, 1);
  assert.deepEqual(p[0].body, { cols: 80, rows: 24 });
  assert.ok(sent.some((m) => m.type === 'term-attach' && m.sessionId === 't-p'));
  assert.equal(doc.querySelector('.term-folder').textContent, '/p/app');
  assert.equal(doc.querySelector('.term-warn'), null);
});

test('a project page reattaches its own-folder shell, never a branch-folder one opened through the API', async () => {
  const PROJ = { ...SNAP, id: 't-p', scope: 'project', runId: null, projectKey: 'app-0000aaaa', cwd: '/p/app' };
  const BR = { ...PROJ, id: 't-b', scope: 'branch', cwd: '/home/terminal/worktrees/app/dev', createdAt: '2026-10-03T11:00:00.000Z' };
  const { pane, calls, sent } = makePane({ ctx: { view: 'project-detail', projectKey: 'app-0000aaaa' }, routes: {
    'GET /api/terminal': { ...INFO, sessions: [PROJ, BR] },
    'GET /api/projects/app-0000aaaa/terminal': { enabled: true, sessions: [PROJ, BR], dir: '/p/app', branches: [], current: 'dev', worktrees: [] },
    'GET /api/terminal/sessions/t-p': { session: PROJ, blocks: [] },
  } });
  await pane.open();
  await tick();
  assert.equal(posts(calls).length, 0);
  assert.equal(sent.find((m) => m.type === 'term-attach').sessionId, 't-p');
});

test('a finished run without a checkout: the checkout is made first, then the shell starts in it', async () => {
  let checkedOut = false;
  const DONE = { ...SNAP, runLive: false, cwd: '/home/checkouts/r1/app' };
  const { pane, doc, calls, sent } = makePane({ ctx: RUN_CTX, routes: {
    'GET /api/terminal': INFO,
    'GET /api/runs/r1/terminal': () => ({ enabled: true, live: false, finished: true, workspace: false, sessions: [],
      members: [checkedOut ? { projectKey: 'app-0000aaaa', projectName: 'app', state: 'checkout', cwd: DONE.cwd }
        : { projectKey: 'app-0000aaaa', projectName: 'app', state: 'needs-checkout', cwd: null }] }),
    'POST /api/runs/r1/checkout': () => { checkedOut = true; return { members: [] }; },
    'POST /api/runs/r1/terminal': { session: DONE, warning: null },
    'GET /api/terminal/sessions/t-1': { session: DONE, blocks: [] },
  } });
  await pane.open();
  await tick();
  const p = posts(calls);
  assert.deepEqual(p.map((c) => c.url), ['/api/runs/r1/checkout?projectDir=%2Fp%2Fapp', '/api/runs/r1/terminal?projectDir=%2Fp%2Fapp']);
  assert.deepEqual(p[0].body, { members: ['app-0000aaaa'] });
  assert.ok(sent.some((m) => m.type === 'term-attach' && m.sessionId === 't-1'));
  assert.equal(doc.querySelector('.term-folder').textContent, DONE.cwd);
});

test('a run with no folder shows the reason and starts nothing', async () => {
  const { pane, doc, calls } = makePane({ ctx: RUN_CTX, routes: {
    'GET /api/terminal': INFO,
    'GET /api/runs/r1/terminal': { enabled: true, live: true, workspace: false, sessions: [],
      members: [{ projectKey: 'app-0000aaaa', projectName: 'app', state: 'unavailable', cwd: null, reason: 'This run has no folder yet.' }] },
  } });
  await pane.open();
  await tick();
  assert.equal(posts(calls).length, 0);
  assert.equal(doc.querySelector('.term-context').textContent, 'This run has no folder yet.');
});

test('a starting run (no pipeline id yet) starts nothing and says it opens in a moment', async () => {
  const { pane, doc, calls } = makePane({ ctx: { view: 'running', runId: 'live-1' }, routes: { 'GET /api/terminal': INFO } });
  await pane.open();
  await tick();
  assert.equal(posts(calls).length, 0);
  assert.match(doc.querySelector('.term-context').textContent, /starting/);
  pane.destroy();
});

test('other pages start nothing: the hint with no terminals, else the newest running one', async () => {
  const one = makePane({ ctx: { view: 'stats' }, routes: { 'GET /api/terminal': INFO } });
  await one.pane.open();
  await tick();
  assert.equal(posts(one.calls).length, 0);
  assert.equal(one.doc.querySelector('.term-context').textContent, 'Open a run or a project to start a terminal.');

  const older = { ...SNAP, id: 't-old', createdAt: '2026-10-03T09:00:00.000Z' };
  const newer = { ...SNAP, id: 't-new', createdAt: '2026-10-03T12:00:00.000Z' };
  const ended = { ...SNAP, id: 't-end', status: 'exited', createdAt: '2026-10-03T13:00:00.000Z' };
  const two = makePane({ ctx: { view: 'stats' }, routes: { 'GET /api/terminal': { ...INFO, sessions: [older, ended, newer] },
    'GET /api/terminal/sessions/t-new': { session: newer, blocks: [] } } });
  await two.pane.open();
  await tick();
  assert.equal(posts(two.calls).length, 0);
  assert.equal(two.sent.find((m) => m.type === 'term-attach').sessionId, 't-new');
  assert.doesNotMatch(two.doc.querySelector('.term-context').textContent, /Open a run/, 'no hint while a shell is attached');
});

test('a workspace run: the member select, a shell started on the selected member, and one more on the other member', async () => {
  const api = { ...SNAP, id: 't-a', runId: 'w1', member: 'api-0000bbbb', cwd: '/a', runLive: false };
  const web = { ...SNAP, id: 't-w', runId: 'w1', member: 'web-0000cccc', cwd: '/w', runLive: false };
  const { pane, doc, calls, sent } = makePane({ ctx: { view: 'running', pipelineId: 'w1', workspaceId: 'wks-1' }, routes: {
    'GET /api/terminal': INFO,
    'GET /api/runs/w1/terminal': { enabled: true, live: true, workspace: true, sessions: [], members: [
      { projectKey: 'api-0000bbbb', projectName: 'api', state: 'worktree', cwd: '/a' }, { projectKey: 'web-0000cccc', projectName: 'web', state: 'worktree', cwd: '/w' }] },
    'POST /api/runs/w1/terminal': (url, opts) => ({ session: JSON.parse(opts.body).member === 'api-0000bbbb' ? api : web, warning: null }),
    'GET /api/terminal/sessions/t-a': { session: api, blocks: [] },
    'GET /api/terminal/sessions/t-w': { session: web, blocks: [] },
  } });
  await pane.open();
  await tick();
  assert.deepEqual([...doc.querySelectorAll('.term-member option')].map((o) => o.textContent), ['api', 'web']);
  assert.deepEqual(posts(calls).map((c) => c.body.member), ['api-0000bbbb']);
  const sel = doc.querySelector('.term-member');
  sel.value = 'web-0000cccc';
  sel.dispatchEvent(new doc.defaultView.Event('change'));
  await tick();
  assert.deepEqual(posts(calls).map((c) => c.body.member), ['api-0000bbbb', 'web-0000cccc']);
  assert.ok(sent.some((m) => m.type === 'term-detach' && m.sessionId === 't-a'));
  assert.equal(sent.filter((m) => m.type === 'term-attach').at(-1).sessionId, 't-w');
  const sel2 = doc.querySelector('.term-member');
  sel2.value = 'api-0000bbbb';
  sel2.dispatchEvent(new doc.defaultView.Event('change'));
  await tick();
  assert.equal(posts(calls).length, 2, 'back on api: its running shell is reattached, not a new one');
  assert.equal(sent.filter((m) => m.type === 'term-attach').at(-1).sessionId, 't-a');
});

test('a warning belongs to its terminal: shown with it, gone once another member\'s shell is attached', async () => {
  const api = { ...SNAP, id: 't-a', scope: 'run', runId: 'w1', member: 'api-0000bbbb', runLive: true };
  const web = { ...SNAP, id: 't-w', scope: 'run', runId: 'w1', member: 'web-0000cccc', runLive: false };
  const { pane, doc } = makePane({ ctx: { view: 'running', pipelineId: 'w1', workspaceId: 'wks-1' }, routes: {
    'GET /api/terminal': INFO,
    'GET /api/runs/w1/terminal': { enabled: true, live: true, workspace: true, sessions: [], members: [
      { projectKey: 'api-0000bbbb', projectName: 'api', state: 'worktree', cwd: '/a' }, { projectKey: 'web-0000cccc', projectName: 'web', state: 'worktree', cwd: '/w' }] },
    'POST /api/runs/w1/terminal': (url, opts) => (JSON.parse(opts.body).member === 'api-0000bbbb'
      ? { session: api, warning: 'API is still changing.' } : { session: web, warning: null }),
    'GET /api/terminal/sessions/t-a': { session: api, blocks: [] },
    'GET /api/terminal/sessions/t-w': { session: web, blocks: [] },
  } });
  await pane.open();
  await tick();
  assert.equal(doc.querySelector('.term-context .term-warn')?.textContent, 'API is still changing.');
  assert.equal(doc.querySelector('.term-context .term-error'), null, 'a warning is not shown as an error');
  const sel = doc.querySelector('.term-member');
  sel.value = 'web-0000cccc';
  sel.dispatchEvent(new doc.defaultView.Event('change'));
  await tick();
  assert.equal(doc.querySelector('.term-context .term-warn'), null);
});

test('never two shells for one page: quick context changes while the start is in flight post once', async () => {
  const env = {};
  let release;
  const gate = new Promise((r) => { release = r; });
  const { pane, calls, sent } = makePane({ ctx: RUN_CTX, env, routes: {
    'GET /api/terminal': INFO,
    'GET /api/runs/r1/terminal': { enabled: true, live: true, workspace: false, sessions: [], members: [LIVE_MEMBER] },
    'GET /api/runs/r2/terminal': { enabled: true, live: true, workspace: false, sessions: [], members: [{ ...LIVE_MEMBER, cwd: '/r2' }] },
    'POST /api/runs/r1/terminal': () => gate.then(() => ({ session: SNAP, warning: null })),
    'POST /api/runs/r2/terminal': () => gate.then(() => ({ session: { ...SNAP, id: 't-2', runId: 'r2' }, warning: null })),
    'GET /api/terminal/sessions/t-1': { session: SNAP, blocks: [] },
    'GET /api/terminal/sessions/t-2': { session: { ...SNAP, id: 't-2', runId: 'r2' }, blocks: [] },
  } });
  const opening = pane.open();
  pane.onContextChange();
  pane.onContextChange();
  await tick();
  env.ctx = { ...RUN_CTX, pipelineId: 'r2' };
  pane.onContextChange();
  await tick();
  env.ctx = RUN_CTX;
  pane.onContextChange();
  await tick();
  release();
  await opening;
  await tick(12);
  assert.deepEqual(posts(calls).map((c) => c.url.split('?')[0]), ['/api/runs/r1/terminal', '/api/runs/r2/terminal']);
  assert.equal(sent.filter((m) => m.type === 'term-attach').at(-1).sessionId, 't-1', 'the page in view gets its shell; r2\'s waits in the picker');
  await pane.open();
  await tick();
  assert.equal(posts(calls).length, 2, 'a forced refresh on the same page reattaches');
});

test('an exited shell is not replaced on its own: a dim line, then Enter (only) starts one', async () => {
  const T2 = { ...SNAP, id: 't-2', createdAt: '2026-10-03T11:00:00.000Z' };
  const { pane, calls, sent, xt } = makePane({ ctx: RUN_CTX, routes: attachedRoutes({
    'POST /api/runs/r1/terminal': { session: T2, warning: null },
    'GET /api/terminal/sessions/t-2': { session: T2, blocks: [] },
  }) });
  await pane.open();
  await tick();
  pane.onFrame({ type: 'term-status', snapshot: { ...SNAP, status: 'exited', exitCode: 0 } });
  await tick();
  assert.match(xt.writes.join(''), /\x1b\[2m\[shell exited with code 0 — press Enter for a new one\]/);
  pane.onContextChange();
  await tick();
  assert.equal(posts(calls).length, 0, 'no respawn');
  xt.type('ls');
  await tick();
  assert.equal(posts(calls).length, 0, 'other keys do nothing');
  assert.equal(sent.filter((m) => m.type === 'term-input').length, 0);
  xt.type('\r');
  xt.type('\r');
  await tick();
  assert.equal(posts(calls).length, 1, 'one Enter, one shell');
  assert.equal(sent.filter((m) => m.type === 'term-attach').at(-1).sessionId, 't-2');
  assert.equal(sent.filter((m) => m.type === 'term-input').length, 0, 'the Enter itself is not sent');
});

test('the session picker shows only when more than one terminal is open', async () => {
  const routes = attachedRoutes();
  const { pane, doc } = makePane({ ctx: RUN_CTX, routes });
  await pane.open();
  await tick();
  assert.equal(doc.querySelector('.term-sessions').hidden, true);
  pane.onFrame({ type: 'term-status', snapshot: { ...SNAP, id: 't-9', label: 'other', runId: 'r9' } });
  assert.equal(doc.querySelector('.term-sessions').hidden, false);
  assert.deepEqual([...doc.querySelectorAll('.term-sessions option')].map((o) => o.value).sort(), ['t-1', 't-9']);
  pane.onFrame({ type: 'term-status', snapshot: { ...SNAP, id: 't-9', label: 'other', runId: 'r9', status: 'exited' } });
  assert.equal(doc.querySelector('.term-sessions').hidden, true, 'an ended terminal is not one to pick');
});

test('the Commands toggle switches views and says which way it goes', async () => {
  const { pane, doc } = makePane({ ctx: RUN_CTX, routes: attachedRoutes() });
  await pane.open();
  await tick();
  const btn = doc.querySelector('.term-cmds');
  assert.equal(btn.getAttribute('aria-label'), 'Commands');
  assert.equal(btn.getAttribute('aria-pressed'), 'false');
  assert.ok(btn.querySelector('svg'));
  btn.click();
  assert.equal(btn.getAttribute('aria-label'), 'Back to terminal');
  assert.equal(btn.getAttribute('aria-pressed'), 'true');
  assert.equal(doc.querySelector('.term-blocks').hidden, false);
  assert.equal(doc.querySelector('.term-screen').hidden, true);
  btn.click();
  assert.equal(btn.getAttribute('aria-label'), 'Commands');
  assert.equal(doc.querySelector('.term-blocks').hidden, true);
  assert.equal(doc.querySelector('.term-screen').hidden, false);
});

test('pipes mode: Ctrl+C typed in the pane calls the stop API', async () => {
  const pipes = { ...SNAP, mode: 'pipes' };
  const { pane, calls, xt } = makePane({ ctx: RUN_CTX, routes: attachedRoutes({
    'GET /api/terminal': { ...INFO, sessions: [pipes] },
    'GET /api/runs/r1/terminal': { enabled: true, live: false, workspace: false, sessions: [pipes], members: MEMBERS },
    'GET /api/terminal/sessions/t-1': { session: pipes, blocks: [] },
    'POST /api/terminal/sessions/t-1/stop': { ok: true, blockSeq: 1 },
  }) });
  await pane.open();
  await tick();
  xt.type('\x03');
  await tick();
  assert.deepEqual(posts(calls).map((c) => c.url), ['/api/terminal/sessions/t-1/stop']);
});

test('pty mode: Ctrl+C goes to the shell as a keystroke, not to the stop API', async () => {
  const { pane, calls, sent, xt } = makePane({ ctx: RUN_CTX, routes: attachedRoutes() });
  await pane.open();
  await tick();
  xt.type('\x03');
  await tick();
  assert.equal(posts(calls).length, 0);
  assert.ok(sent.some((m) => m.type === 'term-input' && m.data === '\x03'));
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
  const tab = doc.querySelector('.term-cmds');
  assert.equal(tab.title, 'Commands (300)');
  assert.match(doc.querySelector('.term-blocks').textContent, /Showing the latest 200 of 300 commands/);
  pane.onFrame({ type: 'term-block', sessionId: 't-1', block: block(301) });
  assert.equal(tab.title, 'Commands (301)');
  assert.match(doc.querySelector('.term-blocks').textContent, /Showing the latest 201 of 301 commands/);
  pane.onFrame({ type: 'term-block', sessionId: 't-1', block: block(301, { exitCode: 1 }) });
  assert.equal(tab.title, 'Commands (301)', 'an update of a listed command is not a new one');
});

test('a full page from a server without totalBlocks still says older ones may exist', async () => {
  const page = Array.from({ length: 200 }, (_, i) => block(i + 101));
  const { pane, doc } = makePane({ ctx: RUN_CTX, routes: attachedRoutes({ 'GET /api/terminal/sessions/t-1': { session: SNAP, blocks: page } }) });
  await pane.open();
  await tick();
  assert.equal(doc.querySelector('.term-cmds').title, 'Commands (200+)');
  assert.match(doc.querySelector('.term-blocks').textContent, /Showing the latest 200 commands/);
});

test('a short history has a plain count and no note', async () => {
  const { pane, doc } = makePane({ ctx: RUN_CTX, routes: attachedRoutes({ 'GET /api/terminal/sessions/t-1': { session: SNAP, blocks: [block(1), block(2)] } }) });
  await pane.open();
  await tick();
  assert.equal(doc.querySelector('.term-cmds').title, 'Commands (2)');
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

test('moving to another run lets go of the previous shell and starts that run\'s own (finding 3)', async () => {
  const env = {};
  const T2 = { ...SNAP, id: 't-2', runId: 'r2', cwd: '/runs/r2' };
  let releaseT2;
  const t2Gate = new Promise((r) => { releaseT2 = r; });
  const { pane, doc, sent, xt, calls } = makePane({ ctx: RUN_CTX, env, routes: attachedRoutes({
    'GET /api/runs/r2/terminal': { enabled: true, live: false, workspace: false, sessions: [], members: [{ ...MEMBERS[0], cwd: '/runs/r2' }] },
    'POST /api/runs/r2/terminal': () => t2Gate.then(() => ({ session: T2, warning: null })),
    'GET /api/terminal/sessions/t-2': { session: T2, blocks: [] },
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
  const before = sent.length;
  xt.type('rm -rf build\r');
  assert.equal(sent.slice(before).filter((m) => m.type === 'term-input').length, 0, 'no keystroke reaches the other run\'s shell');
  releaseT2();
  await tick();
  assert.deepEqual(posts(calls).map((c) => c.url.split('?')[0]), ['/api/runs/r2/terminal']);
  assert.equal(sent.filter((m) => m.type === 'term-attach').at(-1).sessionId, 't-2');
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
  const api = { ...SNAP, runId: 'w1', member: 'api-0000bbbb' };
  const other = { ...SNAP, id: 't-9', runId: 'r9', member: 'x', label: 'other', createdAt: '2026-10-03T09:00:00.000Z' };
  const { pane, doc } = makePane({ ctx: { view: 'running', pipelineId: 'w1', workspaceId: 'wks-1' }, routes: {
    'GET /api/terminal': { ...INFO, sessions: [api, other] },
    'GET /api/runs/w1/terminal': { enabled: true, live: true, workspace: true, sessions: [api], members: [
      { projectKey: 'api-0000bbbb', projectName: 'api', state: 'worktree', cwd: '/a' }, { projectKey: 'web-0000cccc', projectName: 'web', state: 'worktree', cwd: '/w' }] },
    'GET /api/terminal/sessions/t-1': { session: api, blocks: [block(1, { status: 'running', exitCode: null })] },
    'GET /api/terminal/sessions/t-1/blocks/1': { ...block(1), output: 'hello' },
  } });
  await pane.open();
  await tick();
  const member = doc.querySelector('.term-member');
  assert.equal(doc.querySelector('.term-sessions').hidden, false, 'two open terminals: the picker shows');
  const pickerOpts = [...doc.querySelectorAll('.term-sessions option')];
  pane.onFrame({ type: 'term-status', snapshot: { ...api, currentBlock: { seq: 1, command: 'cmd 1' } } });
  assert.equal(doc.querySelector('.term-member'), member, 'the member select is not rebuilt by a status frame');
  assert.deepEqual([...doc.querySelectorAll('.term-sessions option')], pickerOpts, 'nor is the session picker');
  doc.querySelector('.term-cmds').click();
  const row = doc.querySelector('.term-block[data-seq="1"]');
  [...row.querySelectorAll('button')].find((b) => b.textContent === 'Output').click();
  await tick();
  const out = row.querySelector('.term-out');
  assert.equal(out.hidden, false);
  assert.match(out.textContent, /hello/);
  pane.onFrame({ type: 'term-status', snapshot: { ...api, currentBlock: null } });
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

test('a server restart forgets the shell, its screen and its commands, and starts a new one only on Enter (finding 9)', async () => {
  const T2 = { ...SNAP, id: 't-2' };
  const routes = attachedRoutes({ 'GET /api/terminal/sessions/t-1': { session: SNAP, blocks: [block(1)] },
    'POST /api/runs/r1/terminal': { session: T2, warning: null }, 'GET /api/terminal/sessions/t-2': { session: T2, blocks: [] } });
  const { pane, doc, sent, xt, calls } = makePane({ ctx: RUN_CTX, routes });
  pane.onHello({ type: 'hello', bootId: 'boot-a' });
  await pane.open();
  await tick();
  pane.onFrame({ type: 'term-data', sessionId: 't-1', data: 'before', seq: 1 });
  assert.ok(doc.querySelector('.term-block[data-seq="1"]'));
  routes['GET /api/terminal'] = { ...INFO, sessions: [] };
  routes['GET /api/runs/r1/terminal'] = { enabled: true, live: true, workspace: false, sessions: [], members: MEMBERS };
  pane.onHello({ type: 'hello', bootId: 'boot-b' });
  await tick(12);
  assert.doesNotMatch(xt.writes.join(''), /before/);
  assert.match(xt.writes.join(''), /\[the worca server restarted — press Enter for a new one\]/);
  assert.equal(doc.querySelector('.term-block'), null);
  assert.equal(doc.querySelector('.term-sessions').hidden, true);
  assert.match(doc.querySelector('.term-context').textContent, /server restarted/);
  assert.equal(posts(calls).length, 0, 'no respawn');
  const before = sent.length;
  xt.type('ls');
  assert.equal(sent.slice(before).filter((m) => m.type === 'term-input').length, 0);
  xt.type('\r');
  await tick();
  assert.equal(posts(calls).length, 1);
  assert.equal(sent.filter((m) => m.type === 'term-attach').at(-1).sessionId, 't-2');
});
test('the picker drops sessions the server no longer lists', async () => {
  const routes = { 'GET /api/terminal': { ...INFO, sessions: [SNAP, { ...SNAP, id: 't-2', label: 'gone', createdAt: '2026-10-03T09:00:00.000Z' }] },
    'GET /api/terminal/sessions/t-1': { session: SNAP, blocks: [] } };
  const { pane, doc } = makePane({ ctx: { view: 'stats' }, routes });
  await pane.open();
  await tick();
  assert.equal(doc.querySelectorAll('.term-sessions option[value^="t-"]').length, 2);
  pane.close();
  routes['GET /api/terminal'] = { ...INFO, sessions: [SNAP] };
  await pane.open();
  await tick();
  assert.deepEqual([...doc.querySelectorAll('.term-sessions option[value^="t-"]')].map((o) => o.value), ['t-1']);
  assert.equal(doc.querySelector('.term-sessions').hidden, true);
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

test('hiding and reopening the pane after the shell exited starts one new shell (an open shows a live shell)', async () => {
  const T2 = { ...SNAP, id: 't-2' };
  const routes = attachedRoutes({
    'POST /api/runs/r1/terminal': { session: T2, warning: null },
    'GET /api/terminal/sessions/t-2': { session: T2, blocks: [] },
  });
  const { pane, calls, sent } = makePane({ ctx: RUN_CTX, routes });
  await pane.open();
  await tick();
  const ended = { ...SNAP, status: 'exited', exitCode: 0 };
  pane.onFrame({ type: 'term-status', snapshot: ended });
  routes['GET /api/terminal'] = { ...INFO, sessions: [ended] };
  routes['GET /api/runs/r1/terminal'] = { enabled: true, live: true, workspace: false, sessions: [ended], members: MEMBERS };
  pane.close();
  await pane.open();
  await tick();
  await pane.open();
  await tick();
  assert.equal(posts(calls).length, 1);
  assert.equal(sent.filter((m) => m.type === 'term-attach').at(-1).sessionId, 't-2');
});
