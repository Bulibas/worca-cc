// test/ui-resume-at.test.mjs — "Resume at…" (scheduled resume of a paused run):
// the paused run-card affordance + its cap-pause refusal, the History-detail
// variant, and the schedule sheet opening with the missed-slot policy pre-selected
// to Skip (changeable). Harness: jsdom boot of the REAL index.html + app.js with
// the dispatchable WebSocket stub from test/ui-cost-paused.test.mjs:37-42, the
// URL-armed fetch mock (most-specific arm FIRST), and the afterEach window-close
// OOM guard from test/ui-history-detail.test.mjs:37-38.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));
const PROJECT = '/tmp/proj-resume-at';
const KEY = 'proj-resume-at-abcd1234';

const live = [];   // OOM guard: close every window we boot (ui-history-detail.test.mjs:37-38 idiom)
afterEach(() => { while (live.length) { try { live.pop().close(); } catch {} } });

const ok = (body, status = 200) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });

async function boot({ fetchHandler } = {}) {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' });
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

/** A paused run card is up on the Running view. */
async function pausedCard(ctx, { reason = null, detail = null } = {}) {
  const { doc, recv, settle } = ctx;
  location.hash = 'running';
  recv({ type: 'hello', runs: [{ runId: 'r1', title: 'Feat', projectDir: PROJECT, status: 'running', startedAt: '00:00:00', pipelineId: 'pl_1' }] });
  await settle();
  recv({ type: 'done', runId: 'r1', status: 'paused', ...(reason ? { reason } : {}), ...(detail ? { detail } : {}) });
  await settle();
  const card = doc.querySelector('#run-list .run-card');
  assert.ok(card, 'the paused run has a card');
  return card;
}

/** Drive the sheet: pick tomorrow 02:00, then OK. The sheet's inputs update state on `input`. */
async function confirmSheet(ctx) {
  const { window, doc, settle } = ctx;
  const modal = doc.getElementById('schedule-modal');
  assert.ok(modal, 'the schedule sheet opened');
  const missed = modal.querySelector('#sched-missed');
  assert.equal(missed.value, 'skip', 'missed policy is pre-selected to Skip');
  assert.equal(missed.disabled, false, 'the user may still pick "Start it late"');
  const d = new Date(Date.now() + 86400000);
  const dateIn = modal.querySelector('#sched-date');
  dateIn.value = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
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

test('paused card offers "Resume at…", the sheet pre-selects skip, and the POST carries the pipeline', async () => {
  const ctx = await boot({});
  const card = await pausedCard(ctx);
  const btn = card.querySelector('.btn-resume-at');
  assert.ok(btn, 'the affordance exists on the card');
  assert.equal(btn.hidden, false, 'shown for a plain pause');
  btn.click();
  await ctx.settle();
  await confirmSheet(ctx);
  const posts = ctx.fetchCalls.filter((c) => c.url.includes('/api/schedules/resume'));
  assert.equal(posts.length, 1);
  const body = JSON.parse(posts[0].opts.body);
  assert.equal(body.pipelineId, 'pl_1');
  assert.equal(body.ifMissed, 'skip');
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(body.scheduledFor), 'an ISO instant is posted');
});

test('cap-paused cards never offer "Resume at…" (all four cap reasons)', async () => {
  for (const reason of ['cost_pipeline', 'cost_total', 'cost_pipeline_policy', 'cost_total_policy']) {
    const ctx = await boot({});
    const card = await pausedCard(ctx, { reason, detail: 'cap reached' });
    const btn = card.querySelector('.btn-resume-at');
    assert.ok(btn, 'button exists in the template');
    assert.equal(btn.hidden, true, `hidden for ${reason}`);
    // The normal Resume stays offered (its own gating applies).
    assert.equal(card.querySelector('.btn-resume').hidden, false, `Resume still offered for ${reason}`);
  }
});

test('usage_limit pause offers "Resume at…" (the quota-reset case the feature exists for)', async () => {
  const ctx = await boot({});
  const card = await pausedCard(ctx, { reason: 'usage_limit', detail: 'quota resets at 02:00' });
  assert.equal(card.querySelector('.btn-resume-at').hidden, false);
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

test('History detail offers "Resume at…" for a plain pause, and the sheet opens', async () => {
  const ctx = await boot({
    fetchHandler: (url) => {
      if (url.endsWith('/api/history')) return ok({ pipelines: [rowFor({})], live: [], ghAvailable: false });
      if (url.endsWith(`/api/history/${KEY}/fcec04e8`)) return ok(detailFor({}));
      if (url.endsWith('/api/budget')) return ok({ blocked: false });
      return null;
    },
  });
  ctx.go(`history/${KEY}/fcec04e8`);
  await ctx.settle(8);
  const btn = ctx.doc.querySelector('#hd-resume-at');
  assert.ok(btn, 'the detail affordance exists');
  assert.equal(btn.hidden, false, 'shown for a plain pause');
  btn.click();
  await ctx.settle();
  await confirmSheet(ctx);
  const posts = ctx.fetchCalls.filter((c) => c.url.includes('/api/schedules/resume'));
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0].opts.body).pipelineId, 'fcec04e8');
});

test('History detail hides "Resume at…" for every cap pause', async () => {
  for (const reason of ['cost_pipeline', 'cost_total', 'cost_pipeline_policy', 'cost_total_policy']) {
    const ctx = await boot({
      fetchHandler: (url) => {
        if (url.endsWith('/api/history')) return ok({ pipelines: [rowFor({ pauseReason: reason })], live: [], ghAvailable: false });
        if (url.endsWith(`/api/history/${KEY}/fcec04e8`)) return ok(detailFor({ pauseReason: reason }));
        if (url.endsWith('/api/budget')) return ok({ blocked: false });
        return null;
      },
    });
    ctx.go(`history/${KEY}/fcec04e8`);
    await ctx.settle(8);
    const btn = ctx.doc.querySelector('#hd-resume-at');
    assert.ok(btn, 'button exists in the markup');
    assert.equal(btn.hidden, true, `hidden for ${reason}`);
  }
});
