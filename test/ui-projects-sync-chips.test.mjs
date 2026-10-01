// test/ui-projects-sync-chips.test.mjs — Projects / Workspaces sync rows and Sync all
// (#527, plan §6.7 / §6.8; design board 1: one row model — icon, branch, status + hint, one
// action — on both lists, a rollup sentence per workspace, and one "Checked … ↻" per list).
// Boot from test/ui-projects-view.test.mjs; the fake socket delivers server frames the way
// test/ui-history-shipit.test.mjs does.
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
    if (u.includes('/api/sync/all')) return ok(all(opts.body ? JSON.parse(opts.body) : {}));
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
// A row's status label and tone (Projects sync bar or Workspaces table row).
const label = (node) => node?.querySelector('.ps-label, .ws-tlabel')?.textContent;
const tone = (node) => (/tone-(\w+)/.exec(node?.className || '') || [])[1];
// A Projects bar that has its answer (it reads "Checking…" until the first status read lands).
const settled = (node) => !!node && !node.hidden && tone(node) !== undefined && label(node) !== 'Checking…';

test('the rows render from /api/sync/projects, and one render makes exactly one GET', async () => {
  const ctx = await boot();
  await go(ctx.window, 'projects');
  const slot = () => ctx.doc.querySelector('.proj-sync[data-key="k1"]');
  await waitFor(() => settled(slot()));
  assert.equal(tone(slot()), 'blue');
  assert.equal(slot().querySelector('.ps-bname').textContent, 'dev');
  assert.equal(slot().querySelector('.ps-vs').textContent, 'vs origin/dev', 'the ref it is compared with');
  assert.equal(label(slot()), '3 commits behind');
  assert.equal(slot().querySelector('.ps-hint').textContent, 'Next run syncs it first');
  assert.equal(slot().querySelector('button').textContent, 'Sync');
  assert.equal(tone(ctx.doc.querySelector('.proj-sync[data-key="k2"]')), 'ok');
  assert.equal(ctx.doc.querySelector('.proj-sync[data-key="k2"] button'), null, 'up to date: nothing to do, no button');
  assert.equal(ctx.doc.querySelector('#projects-list .sync-checked-txt').textContent, 'Checked just now');
  // Sync all sits in the card head, beside the last check time — not in the page's topbar.
  assert.equal(ctx.doc.querySelector('#projects-list .saved-head #projects-sync-all').textContent, 'Sync all (1)');
  assert.equal(ctx.doc.querySelectorAll('#projects-sync-all').length, 1);
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

test('a project with no remote says so; a later frame with a remote fills the bar', async () => {
  let remote = null;
  const ctx = await boot({ chips: () => ({ projects: { k1: blk('dev', { remote }), k2: blk('main') } }) });
  await go(ctx.window, 'projects');
  await waitFor(() => chipGets(ctx.calls) === 1);
  await sleep(20);
  const slot = ctx.doc.querySelector('.proj-sync[data-key="k1"]');
  assert.equal(slot.hidden, false);
  assert.equal(tone(slot), 'none');
  assert.equal(slot.textContent, 'No git remoteLocal folder · nothing to sync');
  assert.equal(slot.querySelector('button'), null);
  remote = 'origin';
  ctx.recv({ type: 'project-sync-changed', action: 'k1' });
  await waitFor(() => label(slot) === 'Up to date');
  assert.equal(tone(slot), 'ok');
});

test('before the first status read the bars say Checking…; a project the read skips has no bar', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const ctx = await boot({ chips: () => ({ projects: { k1: blk('dev') } }) });
  const fetch0 = ctx.window.fetch;
  ctx.window.fetch = globalThis.fetch = (url, opts) => (String(url).includes('/api/sync/projects') ? gate.then(() => fetch0(url, opts)) : fetch0(url, opts));
  await go(ctx.window, 'projects');
  const slot = (k) => ctx.doc.querySelector(`.proj-sync[data-key="${k}"]`);
  await waitFor(() => slot('k1') && slot('k2'));
  assert.equal(label(slot('k1')), 'Checking…');
  assert.equal(slot('k1').querySelector('.ps-bnone').textContent, '—', 'no branch known yet');
  release();
  await waitFor(() => label(slot('k1')) === 'Up to date');
  assert.equal(slot('k2').hidden, true, 'no answer after the read: a folder that is gone');
});

test('a long branch name is never cut: it may break after / _ -', async () => {
  const ctx = await boot({ chips: () => ({ projects: { k1: blk('feature/rollouts_tenant-metrics'), k2: blk('main') } }) });
  await go(ctx.window, 'projects');
  const name = () => ctx.doc.querySelector('.proj-sync[data-key="k1"] .ps-bname');
  await waitFor(() => name());
  assert.equal(name().textContent, 'feature/rollouts_tenant-metrics');
  assert.equal(name().querySelectorAll('wbr').length, 3);
  assert.equal(name().closest('.ps-bline').title, 'feature/rollouts_tenant-metrics');
});

test('the head counts double as filters; an empty filter falls back to All', async () => {
  let reads = () => ({ projects: { k1: blk('dev', { state: 'behind', behind: 3 }), k2: blk('main') } });
  const ctx = await boot({ chips: () => reads() });
  await go(ctx.window, 'projects');
  const chips = () => [...ctx.doc.querySelectorAll('#projects-list .proj-fchip')];
  const item = (k) => ctx.doc.querySelector(`#projects-list .pl-item[data-key="${k}"]`);
  await waitFor(() => chips().length === 3);
  assert.deepEqual(chips().map((c) => c.textContent), ['All 2', 'Behind 1', 'Up to date 1']);
  assert.deepEqual(chips().map((c) => c.getAttribute('aria-pressed')), ['true', 'false', 'false']);
  click(ctx.window, chips()[1]);
  assert.equal(chips()[1].getAttribute('aria-pressed'), 'true');
  assert.equal(ctx.doc.activeElement, chips()[1], 'focus stays on the pressed chip');
  assert.deepEqual([item('k1').hidden, item('k2').hidden], [false, true]);
  assert.equal(ctx.window.location.hash, '#projects', 'a filter does not open a project');
  // k1 catches up: nothing is behind any more, so the list goes back to All.
  reads = () => ({ projects: { k1: blk('dev'), k2: blk('main') } });
  ctx.recv({ type: 'project-sync-changed', action: 'k1' });
  await waitFor(() => chips().length === 2);
  assert.deepEqual(chips().map((c) => c.textContent), ['All 2', 'Up to date 2']);
  assert.equal(chips()[0].getAttribute('aria-pressed'), 'true');
  assert.deepEqual([item('k1').hidden, item('k2').hidden], [false, false]);
  assert.equal(ctx.doc.querySelector('#projects-list .proj-empty').hidden, true);
});

test('a row Sync POSTs by key, repaints, and does not open the project page', async () => {
  const ctx = await boot();
  await go(ctx.window, 'projects');
  const slot = () => ctx.doc.querySelector('.proj-sync[data-key="k1"]');
  await waitFor(() => settled(slot()));
  click(ctx.window, slot().querySelector('button'));
  await waitFor(() => label(slot()) === 'Up to date');
  const post = ctx.calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/projects/k1/sync'));
  assert.deepEqual(post.body, { mode: 'ff' });
  assert.equal(ctx.window.location.hash, '#projects', 'the row did not open');
  assert.equal(ctx.doc.querySelector('#projects-sync-all').hidden, true, 'nothing behind: no Sync all');
});

test('Sync all POSTs /api/sync/all and paints from its answer', async () => {
  const ctx = await boot();
  await go(ctx.window, 'projects');
  const slot = () => ctx.doc.querySelector('.proj-sync[data-key="k1"]');
  await waitFor(() => settled(slot()));
  click(ctx.window, ctx.doc.querySelector('#projects-sync-all'));
  await waitFor(() => ctx.calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/sync/all')));
  await waitFor(() => label(slot()) === 'Up to date');
  assert.deepEqual(ctx.calls.find((c) => c.url.endsWith('/api/sync/all')).body, { mode: 'ff' });
  assert.equal(ctx.doc.querySelector('#projects-sync-all').disabled, false);
});

test('Check origin now fetches every project and moves nothing', async () => {
  const ctx = await boot({ all: () => ({ projects: { k1: blk('dev', { state: 'behind', behind: 5 }), k2: blk('main') } }) });
  await go(ctx.window, 'projects');
  const slot = () => ctx.doc.querySelector('.proj-sync[data-key="k1"]');
  await waitFor(() => settled(slot()));
  click(ctx.window, ctx.doc.querySelector('#projects-list .sync-check-now'));
  await waitFor(() => label(slot()) === '5 commits behind');
  assert.deepEqual(ctx.calls.find((c) => c.url.endsWith('/api/sync/all')).body, { mode: 'fetch' });
});

test('a diverged project offers Review…, never a Sync; dirty does not hide behind', async () => {
  const ctx = await boot({ chips: () => ({ projects: {
    k1: blk('dev', { state: 'diverged', ahead: 2, behind: 5 }),
    k2: blk('main', { state: 'behind', behind: 1, dirty: true }),
  } }) });
  await go(ctx.window, 'projects');
  const slot = (k) => ctx.doc.querySelector(`.proj-sync[data-key="${k}"]`);
  await waitFor(() => settled(slot('k1')) && settled(slot('k2')));
  assert.equal(label(slot('k1')), 'Diverged');
  assert.equal(tone(slot('k1')), 'amber');
  assert.equal(slot('k1').querySelector('.ps-hint').textContent, '2 ahead, 5 behind · next run will ask');
  assert.equal(slot('k1').querySelector('button').textContent, 'Review…');
  assert.equal(label(slot('k2')), '1 commit behind', 'dirty no longer hides behind');
  assert.match(slot('k2').querySelector('.ps-hint').textContent, /Uncommitted changes/);
  assert.equal(slot('k2').querySelector('button'), null, 'Sync cannot move a dirty checkout');
});

test('workspace rows: rollup sentence, icon strip, Sync all; the table opens on demand and its Sync does not open the workspace', async () => {
  const ctx = await boot();
  await go(ctx.window, 'workspaces');
  const item = () => ctx.doc.querySelector('.ws-item[data-workspace-id="wks-alpha-00000001"]');
  // The strip paints at once ("Checking…"); the statuses land with /api/sync/projects.
  await waitFor(() => item() && item().querySelector('.ws-rollup-txt').textContent !== 'Checking…');
  assert.equal(item().querySelector('.ws-rollup-txt').textContent, '1 behind · 1 up to date');
  assert.equal(tone(item().querySelector('.ws-rollup')), 'blue');
  assert.deepEqual([...item().querySelectorAll('.ws-strip-name')].map((n) => n.textContent), ['alpha', 'beta']);
  const syncAll = item().querySelector('.ws-sync-all');
  assert.equal(syncAll.hidden, false);
  assert.equal(syncAll.textContent, 'Sync all (1)');
  const table = item().querySelector('.ws-table');
  assert.equal(table.hidden, true, 'nothing diverged: the table starts closed');
  const toggle = item().querySelector('.ws-toggle');
  assert.equal(toggle.textContent, 'Show 2 projects');
  click(ctx.window, toggle);
  assert.equal(ctx.window.location.hash, '#workspaces', 'Show did not open the workspace');
  assert.equal(table.hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  const rows = [...table.querySelectorAll('.ws-trow')];
  assert.deepEqual(rows.map((r) => r.querySelector('.ws-tname').textContent), ['alpha', 'beta']);
  assert.deepEqual(rows.map(label), ['3 commits behind', 'Up to date']);
  click(ctx.window, rows[0].querySelector('button'));
  await waitFor(() => ctx.calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/projects/k1/sync')));
  await tick();
  assert.equal(ctx.window.location.hash, '#workspaces', 'the workspace did not open');
  await waitFor(() => item().querySelector('.ws-rollup-txt').textContent === 'All 2 up to date');
  assert.equal(item().querySelector('.ws-sync-all').hidden, true);
});

test('a diverged member opens the table by itself', async () => {
  const ctx = await boot({ chips: () => ({ projects: { k1: blk('dev', { state: 'diverged', ahead: 1, behind: 2 }), k2: blk('main') } }) });
  await go(ctx.window, 'workspaces');
  const item = () => ctx.doc.querySelector('.ws-item[data-workspace-id="wks-alpha-00000001"]');
  await waitFor(() => item() && !item().querySelector('.ws-table').hidden);
  assert.equal(item().querySelector('.ws-rollup-txt').textContent, '1 diverged · 1 up to date');
  assert.equal(tone(item().querySelector('.ws-rollup')), 'amber');
  assert.equal(item().querySelector('.ws-trow button').textContent, 'Details…');
});

test('a workspace row\'s sync parts survive a team-metrics-changed repaint', async () => {
  const ctx = await boot();
  await go(ctx.window, 'workspaces');
  const item = () => ctx.doc.querySelector('.ws-item[data-workspace-id="wks-alpha-00000001"]');
  await waitFor(() => item() && item().querySelector('.ws-rollup-txt').textContent !== 'Checking…');
  ctx.recv({ type: 'team-metrics-changed', action: 'fetched' });
  await sleep(50);
  assert.equal(item().querySelectorAll('.ws-strip-member').length, 2);
  assert.equal(item().querySelector('.ws-rollup-txt').textContent, '1 behind · 1 up to date');
});

test('the project page\'s BRANCH card: the branch, the list\'s status and its one action', async () => {
  const ctx = await boot();
  await go(ctx.window, 'projects/k1');
  const card = () => ctx.doc.querySelector('#proj-detail .pd-ov-card-branch');
  await waitFor(() => card() && card().querySelector('.pd-ov-value').textContent === 'dev');
  assert.equal(card().querySelector('.ws-tlabel').textContent, '3 commits behind');
  assert.equal(tone(card().querySelector('.pd-ov-status')), 'blue');
  assert.equal(card().querySelector('.pd-ov-sub').textContent, 'Runs sync it first anyway');
  click(ctx.window, card().querySelector('.pd-ov-actrow button'));
  await waitFor(() => card().querySelector('.ws-tlabel')?.textContent === 'Up to date');
  assert.equal(card().querySelector('.pd-ov-actrow button'), null, 'up to date: nothing to do');
  assert.match(ctx.window.location.hash, /^#projects\/k1/, 'Sync did not leave the page');
});

test('the workspace page\'s BRANCHES card: the worst state up front, the rest below, Sync all (N)', async () => {
  const ctx = await boot({ chips: () => ({ projects: { k1: blk('dev', { state: 'behind', behind: 3 }), k2: blk('main', { dirty: true }) } }) });
  await go(ctx.window, 'workspaces/wks-alpha-00000001');
  const card = () => ctx.doc.querySelector('#ws-detail .pd-ov-card-branches');
  await waitFor(() => card() && card().querySelector('.pd-ov-value').textContent === '1 behind');
  assert.equal(card().querySelector('.pd-ov-sub').textContent, '1 with uncommitted changes');
  assert.equal(card().querySelector('.pd-ov-actrow button').textContent, 'Sync all (1)');
  assert.equal(ctx.doc.querySelector('#ws-detail .pd-ov-card-projects .pd-ov-sub').textContent, 'alpha · beta', 'the members, not "all on disk"');
});

// A status read never fetches, but it reports the server's standing fetch failure (git-sync's
// negative cache): the rows follow the server, with no browser-side memory or clock.
const OLD = '2020-01-01T00:00:00.000Z';
const offlineBlk = (base) => blk(base, { fetchedAt: OLD, stale: true, fetchError: { kind: 'network' } });
const offlineReads = () => ({ projects: { k1: offlineBlk('dev'), k2: offlineBlk('main') } });
const OFFLINE = 'Can’t reach origin';

test('a row Sync that could not fetch stays offline through the following repaint, with Retry', async () => {
  let reads = () => ({ projects: { k1: blk('dev', { state: 'behind', behind: 3 }), k2: blk('main') } });
  const ctx = await boot({ chips: () => reads(), post: () => ({ sync: offlineBlk('dev') }) });
  await go(ctx.window, 'projects');
  const slot = () => ctx.doc.querySelector('.proj-sync[data-key="k1"]');
  await waitFor(() => settled(slot()));
  reads = offlineReads;
  click(ctx.window, slot().querySelector('button'));
  await waitFor(() => label(slot()) === OFFLINE);
  const n = chipGets(ctx.calls);
  ctx.recv({ type: 'project-sync-changed', action: 'k1' });
  await waitFor(() => chipGets(ctx.calls) === n + 1);
  await sleep(20);
  assert.equal(label(slot()), OFFLINE);
  assert.equal(slot().querySelector('button').textContent, 'Retry');
});

test('Sync all that could not fetch keeps the rows offline; a later successful fetch clears it', async () => {
  let reads = () => ({ projects: { k1: blk('dev', { state: 'behind', behind: 2 }), k2: blk('main') } });
  const ctx = await boot({ chips: () => reads(), all: () => ({ projects: { k1: offlineBlk('dev'), k2: offlineBlk('main') } }) });
  await go(ctx.window, 'projects');
  const lab = (k) => label(ctx.doc.querySelector(`.proj-sync[data-key="${k}"]`));
  await waitFor(() => lab('k1') === '2 commits behind');
  reads = offlineReads;
  click(ctx.window, ctx.doc.querySelector('#projects-sync-all'));
  await waitFor(() => lab('k1') === OFFLINE && lab('k2') === OFFLINE);
  const n = chipGets(ctx.calls);
  ctx.recv({ type: 'project-sync-changed', action: 'k1' });
  await waitFor(() => chipGets(ctx.calls) === n + 1);
  await sleep(20);
  assert.deepEqual([lab('k1'), lab('k2')], [OFFLINE, OFFLINE]);
  // The server says a good fetch happened since; an OLD fetchedAt (server clock behind the
  // browser's) must not keep it offline.
  reads = () => ({ projects: { k1: blk('dev', { fetchedAt: OLD }), k2: offlineBlk('main') } });
  ctx.recv({ type: 'project-sync-changed', action: 'k1' });
  await waitFor(() => chipGets(ctx.calls) === n + 2);
  await sleep(20);
  assert.deepEqual([lab('k1'), lab('k2')], ['Up to date', OFFLINE]);
});

test('a background refresh that could not fetch turns the row offline with no Sync press, and stays so on reload', async () => {
  let reads = () => ({ projects: { k1: blk('dev'), k2: blk('main') } });
  const ctx = await boot({ chips: () => reads() });
  await go(ctx.window, 'projects');
  const lab = (doc, k) => label(doc.querySelector(`.proj-sync[data-key="${k}"]`));
  await waitFor(() => lab(ctx.doc, 'k1') === 'Up to date');
  reads = () => ({ projects: { k1: offlineBlk('dev'), k2: blk('main') } });
  const n = chipGets(ctx.calls);
  ctx.recv({ type: 'project-sync-changed', action: 'k1' });   // the background tick's frame
  await waitFor(() => chipGets(ctx.calls) === n + 1);
  await waitFor(() => lab(ctx.doc, 'k1') === OFFLINE);
  assert.equal(lab(ctx.doc, 'k2'), 'Up to date');
  const again = await boot({ chips: () => reads() });           // a reload: no client memory at all
  await go(again.window, 'projects');
  await waitFor(() => lab(again.doc, 'k1') === OFFLINE);
});

test('style.css: one sync bar per row, its inner columns shared with the column header; the branch is never cut', () => {
  const css = readFileSync(new URL('../ui/public/style.css', import.meta.url), 'utf8');
  const rule = (sel) => (css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.#()[\]"=]/g, '\\$&')}\\{([^}]*)\\}`)) || [])[1] || '';
  // Every bar and the header's sync cell use one column set, so Sync / Retry / Review… line up down the list.
  assert.match(rule('#projects-list'), /--ps-cols:minmax\(0,1fr\) minmax\(0,1\.3fr\) 92px;/);
  assert.match(rule('.proj-sync'), /grid-template-columns:var\(--ps-cols\);/);
  assert.match(rule('#projects-list .proj-cols-sync'), /grid-template-columns:var\(--ps-cols\);/);
  // Rows: project · sync · team · open, as one grid.
  assert.match(rule('#projects-list .pl-row'), /display:grid;/);
  assert.match(rule('#projects-list .pl-row'), /grid-template-areas:"proj sync team chev";/);
  // The bar is tinted by state, and dashed when there is nothing to sync.
  assert.match(rule('.proj-sync.tone-blue'), /--ps-bg:var\(--blue-wash\);/);
  assert.match(rule('.proj-sync.tone-amber'), /--ps-bg:var\(--amber-wash\);/);
  assert.match(rule('.proj-sync.tone-none'), /border-style:dashed;/);
  // The branch wraps instead of ending in "…".
  const bname = rule('.ps-bname');
  assert.match(bname, /overflow-wrap:anywhere;/);
  assert.doesNotMatch(bname, /ellipsis|nowrap/);
  // Two lines under 1000px of card, a stack under 560px; the bar folds under 440px of its own cell.
  assert.ok(css.includes('@container pl-list (max-width:1000px){'));
  assert.ok(css.includes('@container pl-list (max-width:560px){'));
  assert.ok(css.includes('@container ps (max-width:440px){'));
  // The Workspaces table keeps its own grid.
  assert.match(css, /\.ws-trow\{[^}]*grid-template-columns:22px minmax\(0,190px\) minmax\(0,1fr\) minmax\(0,320px\) 112px;/);
});
