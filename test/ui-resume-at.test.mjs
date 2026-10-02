// test/ui-resume-at.test.mjs — "Resume at…" (scheduled resume of a paused run):
// the paused run page's split (Resume + caret → "Resume at…"), its cap-pause refusal
// (arrow kept, item disabled), the History-detail split, the simple-level gate
// contract, and the schedule sheet opening with the missed-slot policy pre-selected
// to Skip (changeable). Harness: jsdom boot of the REAL index.html + app.js with
// the dispatchable WebSocket stub from test/ui-cost-paused.test.mjs:37-42, the
// URL-armed fetch mock (most-specific arm FIRST), and the afterEach window-close
// OOM guard from test/ui-history-detail.test.mjs:37-38.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { useDomRelease } from './helpers/jsdom-release.mjs';

// Release each booted window after its test (see test/helpers/jsdom-release.mjs).
const trackDom = useDomRelease(afterEach);

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));
const PROJECT = '/tmp/proj-resume-at';
const KEY = 'proj-resume-at-abcd1234';

const live = [];   // OOM guard: close every window we boot (ui-history-detail.test.mjs:37-38 idiom)
afterEach(() => { while (live.length) { try { live.pop().close(); } catch {} } });

const ok = (body, status = 200) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });

async function boot({ fetchHandler, level } = {}) {
  // `level`: the server-rendered interface mode (docs/ui-levels.md); null = no attribute (gates nothing).
  let html = readFileSync(htmlPath, 'utf8');
  if (level) html = html.replace('<html lang="en" data-theme="system">',
    `<html lang="en" data-theme="system" data-level="${level}">`);
  const dom = trackDom(new JSDOM(html, { url: 'http://localhost:4317/' }));
  live.push(dom);
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  const sockets = [];
  window.WebSocket = class {
    constructor() { this.readyState = 1; this._listeners = {}; sockets.push(this); }
    send() {} close() {}
    addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
    dispatch(type, evt) { for (const fn of this._listeners[type] || []) fn(evt); }
  };
  const fetchCalls = [];
  window.fetch = (url, opts) => {
    fetchCalls.push({ url: String(url), opts });
    if (fetchHandler) { const r = fetchHandler(String(url), opts || {}); if (r) return r; }
    // most specific FIRST
    if (String(url).includes('/api/schedules/resume')) {
      return Promise.resolve({ ok: true, status: 202, json: async () => ({ runId: 'ticket-1', status: 'scheduled', scheduledFor: JSON.parse(opts.body).scheduledFor, resumePipelineId: JSON.parse(opts.body).pipelineId }) });
    }
    if (String(url).includes('/api/resume')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, runId: 'r-new', pipelineId: 'pl_1' }) });
    }
    if (String(url).includes('/api/schedules')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ schedules: [], tickets: [], counts: {}, defaults: { ifMissed: 'run', graceMin: 360, maxFailures: 3 } }) });
    }
    if (String(url).includes('/api/projects')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ projects: [{ name: 'proj', path: PROJECT, exists: true }] }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ config: { steps: {}, customModels: [] }, models: [], efforts: [] }) });
  };
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch {}
  }
  globalThis.window = window; globalThis.document = window.document;
  await import(pathToFileURL(appPath).href + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0));
  const recv = (msg) => { for (const s of sockets) s.dispatch('message', { data: JSON.stringify(msg) }); };
  const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
  const go = (hash) => { window.location.hash = hash; window.dispatchEvent(new window.Event('hashchange')); };
  return { window, doc: window.document, recv, settle, go, fetchCalls };
}

/** A paused run is open on its run page (the Runs list has no cards; the page's split is the control). */
async function pausedCard(ctx, { reason = null, detail = null } = {}) {
  const { doc, recv, settle, go } = ctx;
  go('runs');
  recv({ type: 'hello', runs: [{ runId: 'r1', title: 'Feat', projectDir: PROJECT, status: 'running', startedAt: '00:00:00', pipelineId: 'pl_1' }] });
  await settle();
  go('running/r1');
  await settle(8);
  recv({ type: 'done', runId: 'r1', status: 'paused', ...(reason ? { reason } : {}), ...(detail ? { detail } : {}) });
  await settle(8);
  const page = doc.querySelector('#run-detail');
  assert.ok(page && page.querySelector('.rd-resume-split'), 'the paused run has its run page');
  return page;
}

/** Drive the sheet: pick tomorrow 02:00, then OK. The sheet's inputs update state on `input`. */
async function confirmSheet(ctx) {
  const { window, doc, settle } = ctx;
  const modal = doc.getElementById('schedule-modal');
  assert.ok(modal, 'the schedule sheet opened');
  const missed = modal.querySelector('#sched-missed');
  assert.equal(missed.value, 'skip', 'missed policy is pre-selected to Skip');
  assert.equal(missed.disabled, false, 'the user may still pick "Start it late"');
  // Tomorrow in LOCAL time: the sheet reads date + time in the browser's zone, and a UTC
  // date is still today's local date past midnight east of UTC, putting 02:00 in the past.
  const d = new Date(Date.now() + 86400000);
  const dateIn = modal.querySelector('#sched-date');
  dateIn.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  dateIn.dispatchEvent(new window.Event('input', { bubbles: true }));
  const timeIn = modal.querySelector('#sched-time');
  timeIn.value = '02:00';
  timeIn.dispatchEvent(new window.Event('input', { bubbles: true }));
  await settle();
  const ok = modal.querySelector('.sched-ok');
  assert.equal(ok.disabled, false, 'a valid time enables OK');
  ok.click();
  await settle(6);
}

test('a paused run page offers Resume + a caret; "Resume at…" opens the sheet and posts', async () => {
  const ctx = await boot({});
  const card = await pausedCard(ctx);
  const split = card.querySelector('.rd-resume-split');
  assert.ok(split, 'the split exists on the run page');
  assert.equal(split.hidden, false, 'wrapper shown for a plain pause');
  assert.equal(card.querySelector('.rd-pause').dataset.action, 'resume', 'the toggle offers Resume');
  assert.equal(card.querySelector('.rd-pause').hidden, false, 'default Resume is shown');
  const more = card.querySelector('.rd-resume-more');
  assert.ok(more, 'the caret exists');
  assert.equal(more.hidden, false, 'caret shown for a plain pause');
  const menu = card.querySelector('.rd-resume-menu');
  assert.equal(menu.hidden, true, 'menu closed initially');
  more.click();                                          // open the menu
  await ctx.settle();
  assert.equal(menu.hidden, false, 'caret opens the menu');
  const item = card.querySelector('.rd-resume-at');
  assert.equal(item.disabled, false, 'item enabled for a plain pause');
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  item.click();                                          // schedule
  await ctx.settle();
  await confirmSheet(ctx);                               // unchanged helper
  const posts = ctx.fetchCalls.filter((c) => c.url.includes('/api/schedules/resume'));
  assert.equal(posts.length, 1);
  const body = JSON.parse(posts[0].opts.body);
  assert.equal(body.pipelineId, 'pl_1');
  assert.equal(body.ifMissed, 'skip');
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(body.scheduledFor), 'an ISO instant is posted');
});

test('cap-paused run pages keep the arrow but disable "Resume at…" (all four cap reasons)', async () => {
  for (const reason of ['cost_pipeline', 'cost_total', 'cost_pipeline_policy', 'cost_total_policy']) {
    const ctx = await boot({});
    const card = await pausedCard(ctx, { reason, detail: 'cap reached' });
    const more = card.querySelector('.rd-resume-more');
    assert.ok(more, 'caret exists');
    assert.equal(more.hidden, false, `caret is KEPT for ${reason} (clarify: arrow stays)`);
    more.click();
    await ctx.settle();
    const item = card.querySelector('.rd-resume-at');
    assert.equal(item.disabled, true, `item disabled for ${reason}`);
    item.click();                                        // a disabled item must not schedule
    await ctx.settle();
    const posts = ctx.fetchCalls.filter((c) => c.url.includes('/api/schedules/resume'));
    assert.equal(posts.length, 0, `no schedule POST for ${reason}`);
    assert.equal(card.querySelector('.rd-pause').dataset.action, 'resume', `Resume still offered for ${reason}`);
  }
});

test('usage_limit pause keeps "Resume at…" enabled (the quota-reset case)', async () => {
  const ctx = await boot({});
  const card = await pausedCard(ctx, { reason: 'usage_limit', detail: 'quota resets at 02:00' });
  const item = card.querySelector('.rd-resume-at');
  assert.ok(item);
  assert.equal(item.disabled, false);
});

// ── History detail ───────────────────────────────────────────────────────────

const detailFor = ({ pauseReason = null } = {}) => ({
  state: {
    id: 'fcec04e8', title: 'Paused feat', status: 'paused', startedAt: '2026-08-17T20:54:42Z',
    stepper: null, steps: [], subAgents: [], totalCostUsd: 1.5, totalActiveMs: 60000,
    branch: { source: 'main', feature: 'worca-cc/feat', worktreeDir: '/tmp/wt' },
    prompt: 'Do the thing.',
    ...(pauseReason ? { pauseReason } : {}),
  },
  results: null, overview: null, clarify: { questions: [], answers: [] },
  reviews: [], stepQuestions: [], artifacts: [], auditMarkdown: '# saved',
});
const rowFor = ({ pauseReason = null } = {}) => ({
  id: 'fcec04e8', projectKey: KEY, projectName: 'proj', projectDir: PROJECT,
  title: 'Paused feat', status: 'paused',
  startedAt: '2026-08-17T20:54:42Z', branch: 'worca-cc/feat',
  pauseReason, retainedWork: null,
});

const histFetch = (pauseReason = null) => (url) => {
  if (url.endsWith('/api/history')) return ok({ pipelines: [rowFor({ pauseReason })], live: [], ghAvailable: false });
  if (url.endsWith(`/api/history/${KEY}/fcec04e8`)) return ok(detailFor({ pauseReason }));
  if (url.endsWith('/api/budget')) return ok({ blocked: false });
  return null;
};

test('History detail offers the Resume split; "Resume at…" opens the sheet and posts', async () => {
  const ctx = await boot({ fetchHandler: histFetch() });
  ctx.go(`history/${KEY}/fcec04e8`);
  await ctx.settle(8);
  const split = ctx.doc.querySelector('.hd-resume-split');
  assert.ok(split, 'the split exists on the detail');
  assert.equal(split.hidden, false, 'shown for a plain pause');
  const more = ctx.doc.querySelector('.hd-resume-more');
  more.click();
  await ctx.settle();
  const item = ctx.doc.querySelector('.hd-resume-at-item');
  assert.equal(item.disabled, false, 'enabled for a plain pause');
  assert.equal(ctx.doc.querySelector('.hd-resume-menu').hidden, false, 'menu opened');
  item.click();
  await ctx.settle();
  await confirmSheet(ctx);
  const posts = ctx.fetchCalls.filter((c) => c.url.includes('/api/schedules/resume'));
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0].opts.body).pipelineId, 'fcec04e8');
});

test('History detail keeps the split for every cap pause but disables "Resume at…"', async () => {
  for (const reason of ['cost_pipeline', 'cost_total', 'cost_pipeline_policy', 'cost_total_policy']) {
    const ctx = await boot({ fetchHandler: histFetch(reason) });
    ctx.go(`history/${KEY}/fcec04e8`);
    await ctx.settle(8);
    const split = ctx.doc.querySelector('.hd-resume-split');
    assert.ok(split, 'the split exists on the detail');
    assert.equal(split.hidden, false, `split kept for ${reason}`);
    const item = ctx.doc.querySelector('.hd-resume-at-item');
    assert.equal(item.disabled, true, `item disabled for ${reason}`);
    assert.equal(ctx.doc.querySelector('.hd-resume').hidden, false, `Resume kept for ${reason}`);
    item.click();                                        // a disabled item must not schedule
    await ctx.settle();
    const posts = ctx.fetchCalls.filter((c) => c.url.includes('/api/schedules/resume'));
    assert.equal(posts.length, 0, `no schedule POST for ${reason}`);
  }
});

test('at data-level="simple" the resume carets carry data-min-level="advanced" (the CSS gate)', async () => {
  const ctx = await boot({ level: 'simple' });
  const card = await pausedCard(ctx);
  assert.equal(card.querySelector('.rd-resume-more').getAttribute('data-min-level'), 'advanced');
  assert.ok(card.querySelector('.rd-resume-split'), 'split wrapper still ships (Resume alone at simple)');
  // History detail too
  const ctx2 = await boot({ level: 'simple', fetchHandler: histFetch() });
  ctx2.go(`history/${KEY}/fcec04e8`);
  await ctx2.settle(8);
  assert.equal(ctx2.doc.querySelector('.hd-resume-more').getAttribute('data-min-level'), 'advanced');
});

// ── Run page header + History glance ─────────────────────────────────────────

test('run page: the Pause/Resume toggle grows a caret only while paused; "Resume at…" posts', async () => {
  const ctx = await boot({ level: 'advanced' });
  const { doc, recv, settle, go } = ctx;
  go('running');
  recv({ type: 'hello', runs: [{ runId: 'r1', title: 'Feat', projectDir: PROJECT, status: 'running', startedAt: '00:00:00', pipelineId: 'pl_1' }] });
  await settle();
  go('running/r1');
  await settle(8);
  const more = doc.querySelector('.rd-resume-more');
  assert.ok(more, 'the run page carries the caret');
  assert.equal(more.hidden, true, 'no caret while the run is running (the toggle says Pause)');
  recv({ type: 'done', runId: 'r1', status: 'paused' });
  await settle(8);
  assert.equal(doc.querySelector('.rd-pause').dataset.action, 'resume');
  assert.equal(more.hidden, false, 'a paused run shows the caret');
  more.click();
  await settle();
  assert.equal(doc.querySelector('.rd-resume-menu').hidden, false, 'caret opens the menu');
  doc.querySelector('.rd-resume-at').click();
  await settle();
  assert.equal(doc.getElementById('sched-title').textContent, 'Schedule the resume', 'a new resume is not a "Change time"');
  await confirmSheet(ctx);
  const posts = ctx.fetchCalls.filter((c) => c.url.includes('/api/schedules/resume'));
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0].opts.body).pipelineId, 'pl_1');
  assert.equal(ctx.window.location.hash, '#schedules/once', 'lands where the new ticket lives');
});

test('run page: a cap pause keeps the caret but disables "Resume at…"', async () => {
  const ctx = await boot({ level: 'advanced' });
  await pausedCard(ctx, { reason: 'cost_pipeline', detail: 'cap reached' });
  ctx.go('running/r1');
  await ctx.settle(8);
  assert.equal(ctx.doc.querySelector('.rd-resume-more').hidden, false);
  assert.equal(ctx.doc.querySelector('.rd-resume-at').disabled, true);
});

test('History glance: the bar carries the Resume split, whose "Resume at…" posts', async () => {
  const ctx = await boot({ level: 'advanced', fetchHandler: histFetch() });
  ctx.go(`history/${KEY}/fcec04e8`);
  await ctx.settle(8);
  assert.equal(ctx.doc.querySelector('#hist-detail .hd').dataset.mode, 'glance');
  const split = ctx.doc.querySelector('#hist-detail .hd-bar .rd-bar-end .hd-resume-split');
  assert.ok(split, 'the Resume split sits in the bar, shared by both modes');
  assert.equal(split.hidden, false);
  assert.equal(split.querySelector('.hd-resume').hidden, false, 'Resume is its left half');
  assert.equal(ctx.doc.querySelector('#hist-detail [class*="hd-g-resume"]'), null, 'the card carries no Resume of its own');
  split.querySelector('.hd-resume-more').click();
  await ctx.settle();
  assert.equal(split.querySelector('.hd-resume-menu').hidden, false, 'caret opens the menu');
  split.querySelector('.hd-resume-at-item').click();
  await ctx.settle();
  await confirmSheet(ctx);
  const posts = ctx.fetchCalls.filter((c) => c.url.includes('/api/schedules/resume'));
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0].opts.body).pipelineId, 'fcec04e8');
});

test('History glance: at simple level the bar\'s caret is the Advanced one; a cap pause disables the item', async () => {
  const ctx = await boot({ level: 'simple', fetchHandler: histFetch() });
  ctx.go(`history/${KEY}/fcec04e8`);
  await ctx.settle(8);
  const bar = ctx.doc.querySelector('#hist-detail .hd-bar');
  assert.equal(bar.querySelector('.hd-resume').hidden, false, 'Resume shown');
  assert.equal(bar.querySelector('.hd-resume-more').getAttribute('data-min-level'), 'advanced', 'the CSS gate hides the caret at simple');
  const ctx2 = await boot({ level: 'advanced', fetchHandler: histFetch('cost_total') });
  ctx2.go(`history/${KEY}/fcec04e8`);
  await ctx2.settle(8);
  assert.equal(ctx2.doc.querySelector('#hist-detail .hd-bar .hd-resume-at-item').disabled, true);
});

test('a refused schedule surfaces its reason in the confirm modal', async () => {
  const ctx = await boot({
    level: 'advanced',
    fetchHandler: (url) => (url.includes('/api/schedules/resume')
      ? ok({ error: 'a scheduled resume already exists for this run — change or cancel it in Schedules' }, 409) : null),
  });
  const card = await pausedCard(ctx);
  card.querySelector('.rd-resume-more').click();
  card.querySelector('.rd-resume-at').click();
  await ctx.settle();
  await confirmSheet(ctx);
  const modal = ctx.doc.getElementById('confirm-modal');
  assert.equal(modal.classList.contains('hidden'), false, 'the modal is up');
  assert.match(ctx.doc.getElementById('confirm-message').textContent, /already exists/);
  assert.equal(ctx.doc.getElementById('confirm-ok').textContent, 'Open Schedules');
  assert.equal(card.querySelector('.rd-resume-at').disabled, false, 'the item is usable again');
});
