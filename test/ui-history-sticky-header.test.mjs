// test/ui-history-sticky-header.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));
const css = readFileSync(fileURLToPath(new URL('../ui/public/style.css', import.meta.url)), 'utf8');

// Same anchored helper idiom as test/ui-pinned-sidebar.test.mjs: extract a flat
// rule body, anchored on a non-word char (or start) so we don't match a longer
// selector that merely ends with the same suffix.
function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp('(?:^|[\\s,}])' + escaped + '\\s*\\{([^}]*)\\}'));
  return m ? m[1] : null;
}

// ---------- CSS-string assertions ----------

test('the Started-by pills are one static row above the list scroller; they no longer stick over it', () => {
  const body = ruleBody('.hist-filter.runs-people');
  assert.ok(body, '.hist-filter.runs-people rule must exist');
  assert.match(body, /position:\s*static/, 'the pill row sits above the scroller instead of pinning inside it');
  assert.match(body, /flex-wrap:\s*nowrap/, 'one row of pills');
  assert.match(body, /overflow-x:\s*auto/, 'that scrolls sideways instead of wrapping (D4)');
  // Static is right only because the row is outside the scrolling list.
  const doc = new JSDOM(readFileSync(htmlPath, 'utf8')).window.document;
  const pills = doc.getElementById('historyFilter');
  assert.ok(pills.classList.contains('runs-people'));
  assert.equal(pills.closest('#runs-list'), null, 'the pill row is not inside #runs-list');
  assert.ok(pills.closest('#runs-list-pane'), 'it heads the list pane');
});

test('each project group head sticks to the top of the list scroller, not behind anything', () => {
  const body = ruleBody('.runs-group-head');
  assert.ok(body, '.runs-group-head rule must exist');
  assert.match(body, /position:\s*sticky/, 'header stays sticky');
  assert.match(body, /top:\s*0/, 'nothing else pins inside the scroller, so no toolbar offset');
  assert.match(body, /background:\s*var\(--panel\)/, 'the list pane\'s own opaque background, so scrolled rows do not show through');
});

test('the Runs page drops .main\'s padding so the panes (and their sticky heads) pin flush', () => {
  const head = 'body.view-runs .main{';
  const at = css.indexOf(head);
  const body = at === -1 ? null : css.slice(at + head.length, css.indexOf('}', at));
  assert.ok(body, 'body.view-runs .main rule must exist');
  assert.match(body, /padding(-top)?:\s*0/, 'no top padding for sticky to fight while Runs is active');
  assert.match(body, /display:\s*flex/, '.main is the bounded column that gives the two panes their height');
});

// ---------- DOM behavior (boot the real app under jsdom) ----------
// boot()/HISTORY/histResp copied from test/ui-history-pills.test.mjs.
// boot() takes { fetchHandler, local }, returns { window, showRuns }, and
// showRuns() navigates to the Runs view (hash -> hashchange -> showView).

const HISTORY = [
  { id: 'a2', title: 'Alpha two', status: 'done',    startedAt: '2026-06-04T00:00:00Z', projectName: 'Alpha', projectKey: 'alpha-00000001', projectDir: '/x/alpha' },
  { id: 'b1', title: 'Beta one',  status: 'done',    startedAt: '2026-06-03T00:00:00Z', projectName: 'Beta',  projectKey: 'beta-00000002',  projectDir: '/x/beta' },
  { id: 'a1', title: 'Alpha one', status: 'stopped', startedAt: '2026-06-01T00:00:00Z', projectName: 'Alpha', projectKey: 'alpha-00000001', projectDir: '/x/alpha' },
];
const histResp = (pipelines, ghAvailable = false) =>
  Promise.resolve({ ok: true, status: 200, json: async () => ({ pipelines, ghAvailable }) });

async function boot({ fetchHandler, local } = {}) {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  window.WebSocket = class { constructor() { this.readyState = 1; } send() {} close() {} addEventListener() {} };
  // Pre-seed localStorage BEFORE app.js boots so restore-on-load is exercised.
  if (local) for (const [k, v] of Object.entries(local)) window.localStorage.setItem(k, v);
  window.fetch = (url, opts) => {
    if (fetchHandler) { const r = fetchHandler(String(url), opts || {}); if (r) return r; }
    if (String(url).includes('/api/projects'))
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ projects: [] }) });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ config: { steps: {}, customModels: [] }, models: [], efforts: [] }) });
  };
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch {}
  }
  globalThis.window = window; globalThis.document = window.document;
  await import(pathToFileURL(appPath).href + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0));
  function showRuns() { window.location.hash = 'runs'; window.dispatchEvent(new window.Event('hashchange')); }
  return { window, showRuns };
}

test('entering the Runs view flags <body> so CSS can pin the panes flush', async () => {
  const { window, showRuns } = await boot({
    fetchHandler: (url) => (url.includes('/api/history') ? histResp(HISTORY) : null),
  });
  showRuns();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(window.document.body.classList.contains('view-runs'),
    'showView("runs") must add the view-runs body class');
});
