// test/ui-projects-sync-chips.test.mjs — Projects / Workspaces sync chips and Sync all
// (#527, plan §6.7 / §6.8). Boot from test/ui-projects-view.test.mjs; the fake socket delivers
// server frames the way test/ui-history-shipit.test.mjs does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));

const PROJECTS = [
  { name: 'alpha', path: '/p/alpha', exists: true, key: 'k1' },
  { name: 'beta', path: '/p/beta', exists: true, key: 'k2' },
];
const WORKSPACES = [
  { id: 'wks-alpha-00000001', name: 'Alpha WS', description: '# x', projectPaths: ['/p/alpha', '/p/beta'],
    projectKeys: ['k1', 'k2'], exists: [true, true], createdAt: 'x', updatedAt: 'x' },
];
const NOW = new Date().toISOString();
const blk = (base, over = {}) => ({ base, remote: 'origin', state: 'up-to-date', ahead: 0, behind: 0, dirty: false,
  checkedOutHere: true, fetchedAt: NOW, stale: false, settings: { beforeRun: true, onDiverged: 'ask' }, ...over });
const ok = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });

async function boot({ chips = () => ({ projects: { k1: blk('dev', { state: 'behind', behind: 3 }), k2: blk('main') } }),
  all = () => ({ projects: { k1: blk('dev'), k2: blk('main') } }), post = () => ({ sync: blk('dev') }) } = {}) {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4321/' });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  let lastWs = null;
  window.WebSocket = class {
    constructor() { this.readyState = 1; this._l = {}; lastWs = this; }
    send() {} close() {}
    addEventListener(t, fn) { (this._l[t] ||= []).push(fn); }
  };
  const calls = [];
  window.fetch = (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || 'GET';
    calls.push({ url: u, method, body: opts.body ? JSON.parse(opts.body) : null });
    if (u.includes('/api/sync/projects')) return ok(chips());
    if (u.includes('/api/sync/all')) return ok(all());
    if (/\/api\/projects\/[^/]+\/sync/.test(u) && method === 'POST') return ok(post());
    if (u.includes('/api/projects')) return ok({ projects: PROJECTS });
    if (u.includes('/api/workspaces')) return ok({ workspaces: WORKSPACES });
    return ok({ config: { steps: {}, customModels: [] }, models: [], efforts: [], branches: [], workspaces: [], agents: [], channels: [] });
  };
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator', 'requestAnimationFrame']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch { /* read-only */ }
  }
  globalThis.window = window; globalThis.document = window.document;
  await import(pathToFileURL(appPath).href + `?b=${Date.now()}_${Math.random()}`);
  await tick();
  lastWs._l.open?.forEach((fn) => fn());
  const recv = (obj) => lastWs._l.message.forEach((fn) => fn({ data: JSON.stringify(obj) }));
  return { window, doc: window.document, calls, recv };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error('waitFor timed out'); await tick(); }
}
const click = (window, node) => node.dispatchEvent(new window.Event('click', { bubbles: true }));
const chipGets = (calls) => calls.filter((c) => c.url.includes('/api/sync/projects')).length;
async function go(window, hash) { window.location.hash = hash; await tick(); await tick(); await tick(); }

test('the chips render from /api/sync/projects, and one render makes exactly one GET', async () => {
  const ctx = await boot();
  await go(ctx.window, 'projects');
  const slot = () => ctx.doc.querySelector('.proj-sync[data-key="k1"]');
  await waitFor(() => slot() && !slot().hidden);
  assert.equal(slot().querySelector('.sync-pill').classList.contains('blue'), true);
  assert.equal(slot().querySelector('.sync-pill-txt').textContent, 'dev · 3 behind');
  assert.match(slot().textContent, /fetched just now/);
  assert.equal(slot().querySelector('button').textContent, 'Sync');
  await sleep(400);
  assert.equal(chipGets(ctx.calls), 1, 'render → refresh never loops back into a render');
});

test('project-sync-changed frames refetch once, coalesced', async () => {
  const ctx = await boot();
  await go(ctx.window, 'projects');
  await waitFor(() => chipGets(ctx.calls) === 1);
  await sleep(50);
  ctx.recv({ type: 'project-sync-changed', action: 'k1' });
  await waitFor(() => chipGets(ctx.calls) === 2);
  await sleep(400);
  assert.equal(chipGets(ctx.calls), 2, 'one frame, one refetch');
  for (let i = 0; i < 5; i++) ctx.recv({ type: 'project-sync-changed', action: 'k1' });
  await waitFor(() => chipGets(ctx.calls) === 3);
  await sleep(400);
  assert.equal(chipGets(ctx.calls), 3, 'five frames, one refetch');
});

test('a project with no remote has a hidden slot; a later frame with a remote fills it', async () => {
  let remote = null;
  const ctx = await boot({ chips: () => ({ projects: { k1: blk('dev', { remote }), k2: blk('main') } }) });
  await go(ctx.window, 'projects');
  await waitFor(() => chipGets(ctx.calls) === 1);
  await sleep(20);
  const slot = ctx.doc.querySelector('.proj-sync[data-key="k1"]');
  assert.equal(slot.hidden, true);
  assert.equal(slot.children.length, 0);
  remote = 'origin';
  ctx.recv({ type: 'project-sync-changed', action: 'k1' });
  await waitFor(() => !slot.hidden);
  assert.equal(slot.querySelector('.sync-pill-txt').textContent, 'dev · up to date');
});

test('a chip Sync POSTs by key, repaints, and does not open the project page', async () => {
  const ctx = await boot();
  await go(ctx.window, 'projects');
  const slot = () => ctx.doc.querySelector('.proj-sync[data-key="k1"]');
  await waitFor(() => slot() && !slot().hidden);
  click(ctx.window, slot().querySelector('button'));
  await waitFor(() => slot().querySelector('.sync-pill-txt').textContent === 'dev · up to date');
  const post = ctx.calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/projects/k1/sync'));
  assert.deepEqual(post.body, { mode: 'ff' });
  assert.equal(ctx.window.location.hash, '#projects', 'the row did not open');
});

test('Sync all POSTs /api/sync/all and paints from its answer', async () => {
  const ctx = await boot();
  await go(ctx.window, 'projects');
  const slot = () => ctx.doc.querySelector('.proj-sync[data-key="k1"]');
  await waitFor(() => slot() && !slot().hidden);
  click(ctx.window, ctx.doc.querySelector('#projects-sync-all'));
  await waitFor(() => ctx.calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/sync/all')));
  await waitFor(() => slot().querySelector('.sync-pill-txt').textContent === 'dev · up to date');
  assert.deepEqual(ctx.calls.find((c) => c.url.endsWith('/api/sync/all')).body, { mode: 'ff' });
  assert.equal(ctx.doc.querySelector('#projects-sync-all').disabled, false);
});

test('workspace rows: worst pill, member chips; a member Sync does not open the workspace', async () => {
  const ctx = await boot();
  await go(ctx.window, 'workspaces');
  const item = () => ctx.doc.querySelector('.ws-item[data-workspace-id="wks-alpha-00000001"]');
  await waitFor(() => item() && !item().querySelector('.ws-sync').hidden);
  const worst = item().querySelector('.ws-sync-worst');
  assert.equal(worst.hidden, false);
  assert.equal(worst.textContent, 'behind');
  const members = [...item().querySelectorAll('.ws-sync .ws-sync-member')];
  assert.deepEqual(members.map((m) => m.querySelector('.sync-pill-txt').textContent), ['alpha · dev · 3 behind', 'beta · main · up to date']);
  click(ctx.window, members[0].querySelector('button'));
  await waitFor(() => ctx.calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/projects/k1/sync')));
  await tick();
  assert.equal(ctx.window.location.hash, '#workspaces', 'the workspace did not open');
});

test('a workspace row\'s .ws-sync survives a team-metrics-changed repaint', async () => {
  const ctx = await boot();
  await go(ctx.window, 'workspaces');
  const item = () => ctx.doc.querySelector('.ws-item[data-workspace-id="wks-alpha-00000001"]');
  await waitFor(() => item() && !item().querySelector('.ws-sync').hidden);
  ctx.recv({ type: 'team-metrics-changed', action: 'fetched' });
  await sleep(50);
  const slot = item().querySelector('.ws-sync');
  assert.equal(slot.hidden, false);
  assert.equal(slot.querySelectorAll('.ws-sync-member').length, 2);
});

// A status read never fetches, but it reports the server's standing fetch failure (git-sync's
// negative cache): the chips follow the server, with no browser-side memory or clock.
const OLD = '2020-01-01T00:00:00.000Z';
const offlineBlk = (base) => blk(base, { fetchedAt: OLD, stale: true, fetchError: { kind: 'network' } });
const offlineReads = () => ({ projects: { k1: offlineBlk('dev'), k2: offlineBlk('main') } });

test('a chip Sync that could not fetch stays offline through the following repaint', async () => {
  let reads = () => ({ projects: { k1: blk('dev', { state: 'behind', behind: 3 }), k2: blk('main') } });
  const ctx = await boot({ chips: () => reads(), post: () => ({ sync: offlineBlk('dev') }) });
  await go(ctx.window, 'projects');
  const slot = () => ctx.doc.querySelector('.proj-sync[data-key="k1"]');
  await waitFor(() => slot() && !slot().hidden);
  reads = offlineReads;
  click(ctx.window, slot().querySelector('button'));
  await waitFor(() => slot().querySelector('.sync-pill-txt').textContent === 'dev · offline');
  const n = chipGets(ctx.calls);
  ctx.recv({ type: 'project-sync-changed', action: 'k1' });
  await waitFor(() => chipGets(ctx.calls) === n + 1);
  await sleep(20);
  assert.equal(slot().querySelector('.sync-pill-txt').textContent, 'dev · offline');
  assert.equal(slot().querySelector('.sync-pill').classList.contains('grey'), true);
});

test('Sync all that could not fetch keeps the chips offline; a later successful fetch clears it', async () => {
  let reads = () => ({ projects: { k1: blk('dev'), k2: blk('main') } });
  const ctx = await boot({ chips: () => reads(), all: () => ({ projects: { k1: offlineBlk('dev'), k2: offlineBlk('main') } }) });
  await go(ctx.window, 'projects');
  const txt = (k) => ctx.doc.querySelector(`.proj-sync[data-key="${k}"] .sync-pill-txt`)?.textContent;
  await waitFor(() => txt('k1') === 'dev · up to date');
  reads = offlineReads;
  click(ctx.window, ctx.doc.querySelector('#projects-sync-all'));
  await waitFor(() => txt('k1') === 'dev · offline' && txt('k2') === 'main · offline');
  const n = chipGets(ctx.calls);
  ctx.recv({ type: 'project-sync-changed', action: 'k1' });
  await waitFor(() => chipGets(ctx.calls) === n + 1);
  await sleep(20);
  assert.deepEqual([txt('k1'), txt('k2')], ['dev · offline', 'main · offline']);
  // The server says a good fetch happened since; an OLD fetchedAt (server clock behind the
  // browser's) must not keep it offline.
  reads = () => ({ projects: { k1: blk('dev', { fetchedAt: OLD }), k2: offlineBlk('main') } });
  ctx.recv({ type: 'project-sync-changed', action: 'k1' });
  await waitFor(() => chipGets(ctx.calls) === n + 2);
  await sleep(20);
  assert.deepEqual([txt('k1'), txt('k2')], ['dev · up to date', 'main · offline']);
});

test('a background refresh that could not fetch turns the chip offline with no Sync press, and stays so on reload', async () => {
  let reads = () => ({ projects: { k1: blk('dev'), k2: blk('main') } });
  const ctx = await boot({ chips: () => reads() });
  await go(ctx.window, 'projects');
  const txt = (k) => ctx.doc.querySelector(`.proj-sync[data-key="${k}"] .sync-pill-txt`)?.textContent;
  await waitFor(() => txt('k1') === 'dev · up to date');
  reads = () => ({ projects: { k1: offlineBlk('dev'), k2: blk('main') } });
  const n = chipGets(ctx.calls);
  ctx.recv({ type: 'project-sync-changed', action: 'k1' });   // the background tick's frame
  await waitFor(() => chipGets(ctx.calls) === n + 1);
  await waitFor(() => txt('k1') === 'dev · offline');
  assert.equal(txt('k2'), 'main · up to date');
  const again = await boot({ chips: () => reads() });           // a reload: no client memory at all
  await go(again.window, 'projects');
  await waitFor(() => again.doc.querySelector('.proj-sync[data-key="k1"] .sync-pill-txt')?.textContent === 'dev · offline');
});
