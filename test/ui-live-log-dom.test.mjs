// test/ui-live-log-dom.test.mjs — the run page's live Logs pane (the Running list
// card carries no log), driven through window.__np rather than the log frames.
// Harness is a copy of bootLive from test/ui-running-resume.test.mjs (that helper
// is file-private) plus a WebSocket driver to register a run and open its page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));

async function bootLive({ resumeFails = false } = {}) {
  let lastWs = null;
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  window.WebSocket = class {
    constructor() { this.readyState = 1; this._listeners = {}; lastWs = this; }
    send() {} close() {}
    addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
  };
  const fetchCalls = [];
  window.fetch = (url, opts) => {
    fetchCalls.push({ url: String(url), opts });
    if (String(url).includes('/log')) {
      return Promise.resolve({ ok: true, status: 200, text: async () =>
        '{"source":"planner","level":"info","text":"pass one","ts":"2026-08-17T00:00:01Z","stepIndex":0,"cycle":1}\n' +
        '{"source":"implementer","level":"warn","text":"429, retrying","ts":"2026-08-17T00:00:02Z","stepIndex":1,"cycle":2,"stream":"err"}\n' });
    }
    if (String(url).includes('/api/resume')) {
      if (resumeFails) {
        return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: 'pipeline not found' }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, runId: 'r-new', pipelineId: 'p1' }) });
    }
    if (String(url).includes('/api/projects')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ projects: [] }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ config: { steps: {}, customModels: [] }, models: [], efforts: [] }) });
  };
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch {}
  }
  globalThis.window = window; globalThis.document = window.document;
  await import(pathToFileURL(appPath).href + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0));
  (lastWs._listeners.open || []).forEach((fn) => fn());
  const recv = (obj) => (lastWs._listeners.message || []).forEach((fn) => fn({ data: JSON.stringify(obj) }));
  return { window, fetchCalls, recv };
}
const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const go = (window, hash) => { window.location.hash = hash; window.dispatchEvent(new window.Event('hashchange')); };

// Registers a running run and opens its run page on Details › Live log. Lines
// logged AFTER this call take the live path (rdAppendLogFrame); lines logged
// before it are hydrated from r.logLines when the tab is built.
async function openLogs(ctx, runId) {
  const { window, recv } = ctx;
  const np = window.__np;
  recv({ type: 'hello', runs: [{ runId, title: 't', projectDir: '/tmp/proj', status: 'running', kind: 'run', startedAt: '10:00:00', pendingQuestion: null }] });
  await settle();
  const r = np.getRun(runId);
  np.onState(r, { status: 'running', id: 'p1', steps: [] });
  go(window, `running/${runId}/details/logs`);
  await settle();
  const sec = window.document.querySelector('#run-detail .rd-sec-logs');
  assert.ok(sec, 'the run page has its Live log tab');
  return { np, r, sec, pane: sec.querySelector('.log') };
}

test('the run page\'s live pane draws the Cycle rule even when an artifact line sits at the boundary', async () => {
  const ctx = await bootLive();
  const { np, r, pane } = await openLogs(ctx, 'r1');
  const { onLog } = np;
  onLog(r, { source: 'reviewer', level: 'info', text: 'blocking issue', ts: Date.now(), stepIndex: 1, cycle: 1 });
  onLog(r, { source: 'artifact', level: 'artifact', text: 'review: r.md', ts: Date.now() });   // cycle-less
  onLog(r, { source: 'implementer', level: 'info', text: 'fixing', ts: Date.now(), stepIndex: 1, cycle: 2 });
  const seps = pane.querySelectorAll('.log-sep');
  assert.equal(seps.length, 1, 'boundary survives the cycle-less neighbor');
  assert.equal(seps[0].textContent, 'Cycle 2');
  assert.equal(pane.querySelectorAll('.log-line').length, 3);
});

test('the DOM cap counts record lines — separators do not cause over-eviction', async () => {
  const ctx = await bootLive();
  const { np, r, pane } = await openLogs(ctx, 'r-cap');
  const { onLog } = np;
  for (let i = 0; i < 4000; i++) {
    onLog(r, { source: 'planner', level: 'info', text: `l${i}`, ts: 0, stepIndex: 0, cycle: 1 });
  }
  onLog(r, { source: 'implementer', level: 'info', text: 'first of cycle 2', ts: 0, stepIndex: 0, cycle: 2 });
  // 4001 records + 1 separator entered; the cap must evict exactly ONE record.
  assert.equal(pane.querySelectorAll('.log-line').length, 4000, 'record cap, not childElementCount');
  assert.equal(pane.querySelectorAll('.log-sep').length, 1, 'the mid-pane separator survives');
  assert.match(pane.querySelector('.log-line').textContent, /l1$/, 'only the oldest record evicted');
});

test('eviction never leaves a separator leading the pane', async () => {
  const ctx = await bootLive();
  const { np, r, pane } = await openLogs(ctx, 'r-lead');
  const { onLog } = np;
  onLog(r, { source: 'planner', level: 'info', text: 'only cycle-1 line', ts: 0, stepIndex: 0, cycle: 1 });
  for (let i = 0; i < 4000; i++) {
    onLog(r, { source: 'implementer', level: 'info', text: `c2-${i}`, ts: 0, stepIndex: 0, cycle: 2 });
  }
  assert.equal(pane.querySelectorAll('.log-line').length, 4000);
  assert.ok(pane.firstElementChild.classList.contains('log-line'),
    'the now-boundary-less "Cycle 2" rule was dropped with its predecessor');
  assert.equal(pane.querySelectorAll('.log-sep').length, 0);
});

test('re-opening the run page keeps the search term when a dropdown selection vanishes', async () => {
  const ctx = await bootLive();
  const { window } = ctx;
  const { np, r } = await openLogs(ctx, 'r-search');
  np.onLog(r, { source: 'planner', level: 'info', text: 'an error appeared', ts: 0, stepIndex: 0, cycle: 1 });
  np.onLog(r, { source: 'planner', level: 'info', text: 'all good', ts: 0, stepIndex: 0, cycle: 1 });
  // User had cycle '7' + search 'error'; the cycle rotated out of the facets.
  r.logFilter = { source: '', level: '', step: '', cycle: '7', search: 'error' };
  // Leaving and re-opening the page rebuilds the tab: the stale cycle falls back to "all"…
  go(window, 'running');
  await settle();
  go(window, 'running/r-search/details/logs');
  await settle();
  const sec = window.document.querySelector('#run-detail .rd-sec-logs');
  assert.equal(r.logFilter.cycle, '', 'vanished cycle falls back to all');
  assert.equal(r.logFilter.search, 'error', 'free text has no facet to vanish — must survive');
  assert.equal(sec.querySelector('.log-search').value, 'error', 'rebuilt box shows the active term');
  const lines = sec.querySelectorAll('.log .log-line');
  assert.equal(lines.length, 1, 'pane still narrowed by the term');
  assert.match(lines[0].textContent, /an error appeared/);
});

// -------------------------------------------------------------------- MIN-37
// v2 `cycle` is the PER-NODE ordinal (orchestrator.mjs stamps `cycle: ordinal`
// alongside `nodeId`), so alternating between two concurrently-streaming nodes
// used to draw a rule on almost every line. The live pane and the clipboard
// must agree, and both must count per node.
test('MIN-37: interleaved nodes at different ordinals draw no separator in the live pane', async () => {
  const ctx = await bootLive();
  const { np, r, pane } = await openLogs(ctx, 'r-min37');
  const { onLog } = np;
  const lines = [
    { source: 'implementer', text: 'patching a.js', nodeId: 'n_impl', executionId: 'x:n_impl:2', cycle: 2 },
    { source: 'tester', text: 'running suite', nodeId: 'n_test', executionId: 'x:n_test:1', cycle: 1 },
    { source: 'implementer', text: 'patching b.js', nodeId: 'n_impl', executionId: 'x:n_impl:2', cycle: 2 },
    { source: 'tester', text: '12 passed', nodeId: 'n_test', executionId: 'x:n_test:1', cycle: 1 },
    { source: 'implementer', text: 'done', nodeId: 'n_impl', executionId: 'x:n_impl:2', cycle: 2 },
  ];
  for (const l of lines) onLog(r, { level: 'info', ts: Date.now(), ...l });
  assert.equal(pane.querySelectorAll('.log-line').length, 5);
  assert.equal(pane.querySelectorAll('.log-sep').length, 0, 'no rewind happened — no rule');
});

test('MIN-37: a node re-running draws exactly one rule, before ITS higher-ordinal line', async () => {
  const ctx = await bootLive();
  const { np, r, pane } = await openLogs(ctx, 'r-min37b');
  const { onLog } = np;
  onLog(r, { source: 'refiner', level: 'info', text: 'refining', ts: Date.now(), nodeId: 'n_refine', cycle: 1 });
  onLog(r, { source: 'refiner', level: 'info', text: 'refining again', ts: Date.now(), nodeId: 'n_refine', cycle: 2 });
  onLog(r, { source: 'implementer', level: 'info', text: 'implementing', ts: Date.now(), nodeId: 'n_impl', cycle: 1 });
  const seps = pane.querySelectorAll('.log-sep');
  assert.equal(seps.length, 1);
  assert.equal(seps[0].textContent, 'Cycle 2');
  assert.equal(seps[0].nextElementSibling.textContent.includes('refining again'), true,
    'the rule sits directly above the refiner\'s ordinal-2 line');
});

test('MIN-37: a filter repaint and the live stream agree on the per-node cursor', async () => {
  const ctx = await bootLive();
  const { np, r, sec, pane } = await openLogs(ctx, 'r-min37c');
  const { onLog, paintLogFilters } = np;
  onLog(r, { source: 'refiner', level: 'info', text: 'a', ts: Date.now(), nodeId: 'n_refine', cycle: 1 });
  onLog(r, { source: 'tester', level: 'info', text: 'b', ts: Date.now(), nodeId: 'n_test', cycle: 1 });
  paintLogFilters(r, sec);                             // full wipe + rebuild from the model
  onLog(r, { source: 'tester', level: 'info', text: 'c', ts: Date.now(), nodeId: 'n_test', cycle: 1 });
  onLog(r, { source: 'refiner', level: 'info', text: 'd', ts: Date.now(), nodeId: 'n_refine', cycle: 2 });
  const seps = pane.querySelectorAll('.log-sep');
  assert.equal(seps.length, 1, 'exactly one rule survives the repaint boundary');
  assert.equal(seps[0].textContent, 'Cycle 2');
});
