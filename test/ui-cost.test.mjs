// test/ui-cost.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));
const PROJECT = '/tmp/proj';

async function boot({ fetchHandler } = {}) {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  window.WebSocket = class {
    constructor() { this.readyState = 1; this._listeners = {}; }
    send() {} close() {}
    addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
  };
  window.fetch = (url, opts) => {
    if (fetchHandler) { const r = fetchHandler(String(url), opts || {}); if (r) return r; }
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
  const selectProject = () => { const s = window.document.querySelector('#projectSelect'); s.value = PROJECT; s.dispatchEvent(new window.Event('change', { bubbles: true })); };
  // The card no longer expands — open the run's DETAIL screen (#history/<key>/<id>).
  const showDetail = (key, id) => { window.location.hash = `history/${key}/${id}`; window.dispatchEvent(new window.Event('hashchange')); };
  const settle = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
  return { window, selectProject, showDetail, settle };
}
const runsList = (pipelines, live = []) => Promise.resolve({ ok: true, status: 200, json: async () => ({ pipelines, live }) });
const ok = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });

// The glance's labelled fact tiles (Time · Cost · Changes): { label: value }.
const factTiles = (window) => Object.fromEntries(
  [...window.document.querySelectorAll('#hist-detail .rd-facts .rd-stats > div')]
    .map((t) => [t.querySelector('span').textContent, t.querySelector('b').textContent]));

test('the saved run shows the pipeline total in its glance facts', async () => {
  const KEY = 'proj-a1b2c3d4';
  const row = { id: 'p1', projectKey: KEY, title: 'Run', status: 'done', startedAt: '2026-01-01T00:00:00Z', totalCostUsd: 0.42 };
  const detail = { state: { id: 'p1', title: 'Run', status: 'done', startedAt: row.startedAt, steps: [], totalCostUsd: 0.42 } };
  const ctx = await boot({
    // The detail URL shares the /api/history prefix: match it first.
    fetchHandler: (url) => (url.endsWith(`/api/history/${KEY}/p1`) ? ok(detail)
      : url.endsWith('/api/history') ? runsList([row]) : null),
  });
  ctx.showDetail(KEY, 'p1');
  await ctx.settle(5);
  assert.equal(factTiles(ctx.window).cost, '$0.42');
});

test('costByNode buckets per nodeId; a row with no nodeId has nothing to bucket onto', async () => {
  const { window } = await boot();
  const fn = window.__np.costByNode;
  assert.equal(fn([{ nodeId: 's0_0', phase: 'planner', costUsd: 0.12 }])['s0_0'], 0.12);
  // The v1 phase->node fallback died with the v1 manifest: stepBucketKey is the
  // nodeId or nothing.
  assert.deepEqual(fn([{ phase: 'plan', costUsd: 0.05 }]), {});
});

test('costByNode folds a nodeId-tagged clarify step onto the plan node', async () => {
  const { window } = await boot();
  const fn = window.__np.costByNode;
  const out = fn([
    { key: 'clarify#1', phase: 'clarify', nodeId: 's0_0', costUsd: 0.01 },
    { key: '0:s0_0', phase: 'planner', nodeId: 's0_0', costUsd: 0.02 },
  ]);
  assert.equal(out['s0_0'], 0.03);
});
