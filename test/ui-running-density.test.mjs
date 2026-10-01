// test/ui-running-density.test.mjs — the Runs list row is compact: there is NO
// Compact/Detailed density toggle and NO row body (graph / live log), plus the removal of
// the old run card's Agents disclosure.
//
// boot() is copied VERBATIM from test/ui-pipeline-tabs.test.mjs — the nearest suite that
// captures the WebSocket and clears localStorage. showRunning() is the bare list with
// nothing selected (test/helpers/run-page-boot.mjs): a bare route reopens the remembered run (D6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..', 'ui', 'public');
const htmlPath = join(root, 'index.html');
const appPath = join(root, 'app.js');
const cssPath = join(root, 'style.css');
const PROJECT = '/tmp/proj';
const KEY = 'worca-cc.running.density';

async function boot({ local } = {}) {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  let lastWs = null;
  window.WebSocket = class { constructor() { this.readyState = 1; this._l = {}; lastWs = this; }
    send() {} close() {} addEventListener(t, fn) { (this._l[t] ||= []).push(fn); } };
  window.fetch = (url) => String(url).includes('/api/projects')
    ? Promise.resolve({ ok: true, status: 200, json: async () => ({ projects: [{ name: 'proj', path: PROJECT, exists: true }] }) })
    : Promise.resolve({ ok: true, status: 200, json: async () => ({ config: { steps: {}, customModels: [] }, models: [], efforts: [], pipelines: 0, projects: 0, workspaces: 0 }) });
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch {}
  }
  globalThis.window = window; globalThis.document = window.document;
  window.localStorage.clear();
  // Pre-seed localStorage BEFORE app.js boots so restore-on-load is exercised.
  if (local) for (const [k, v] of Object.entries(local)) window.localStorage.setItem(k, v);
  await import(pathToFileURL(appPath).href + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0));
  const open = () => lastWs._l.open?.forEach((fn) => fn());
  const recv = (obj) => lastWs._l.message.forEach((fn) => fn({ data: JSON.stringify(obj) }));
  open();
  const showRunning = () => {
    window.localStorage.removeItem('worca-cc.runs.last');
    window.location.hash = 'runs';
    window.dispatchEvent(new window.Event('hashchange'));
  };
  const settle = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
  return { window, recv, showRunning, settle };
}

const RUN_ID = 'run-den';
const live = (runId, extra = {}) => ({
  runId, title: runId, projectDir: PROJECT, status: 'running', kind: 'run',
  startedAt: '10:00:00', pendingQuestion: null, ...extra,
});
// The run's row in its project group (rule 6: a Needs-you run is repeated above it).
const card = (doc) => doc.querySelector(`#runs-list .runs-row[data-slot="group"][data-run-id="${RUN_ID}"]`);

test('the Runs list carries no density toggle, and nothing reads or writes the density key', async () => {
  const { window, showRunning } = await boot({ local: { [KEY]: 'compact' } });
  showRunning();
  const doc = window.document;
  assert.equal(doc.querySelector('.run-density'), null, 'no .run-density group');
  assert.equal(doc.querySelector('.rc-dseg'), null, 'no density segments');
  assert.equal(window.__np.readRunDensity, undefined, 'readRunDensity is gone from the test hook');
  assert.equal(window.__np.setRunDensity, undefined, 'setRunDensity is gone from the test hook');
  const src = readFileSync(appPath, 'utf8');
  assert.equal(src.includes(KEY), false, 'the localStorage key is not referenced by app.js');
  assert.equal(/data-density|dataset\.density/.test(src), false, 'app.js stamps no density attribute');
  const css = readFileSync(cssPath, 'utf8');
  assert.equal(/\.rc-dseg|\.run-density|\.rc-compact|\.rc-detailed|\.rc-step-chip|\.rc-qpill/.test(css), false, 'no density / compact / detailed CSS left');
});

test('the list row is icon + title + subline only: no graph, log, banner, question panel or Agents bar', async () => {
  const ctx = await boot();
  ctx.recv({ type: 'hello', runs: [live(RUN_ID)] });
  ctx.showRunning();
  await ctx.settle();
  const c = card(ctx.window.document);
  assert.ok(c, 'row rendered');
  assert.ok(c.querySelector('.runs-row-title') && c.querySelector('.runs-row-sub'), 'title and subline present');
  for (const sel of ['.rc-compact', '.rc-detailed', '.rc-step-chip', '.run-flow-wrap', '.run-flow', '.run-log', '.log', '.log-filters',
    '.switch.autoscroll', '.cost-banner', '.qpanel', '.rc-qpill', '.subs-bar'])
    assert.equal(c.querySelector(sel), null, `no ${sel} on the list row`);
});

test('the card no longer carries the Agents disclosure, and its painters are gone', async () => {
  const ctx = await boot();
  ctx.recv({ type: 'hello', runs: [live(RUN_ID)] });
  ctx.showRunning();

  // Against the SOURCE, not the hook: `__np.anythingMisspelled` is undefined too,
  // so the hook form proves nothing about removal. Idiom from
  // ui-running-routing.test.mjs:128.
  const appSrc = readFileSync(appPath, 'utf8');
  for (const dead of ['paintSubsBar', 'renderSubsTree', 'subsPillText']) {
    assert.doesNotMatch(appSrc, new RegExp(`function ${dead}\\b`), `${dead} removed from app.js`);
    assert.equal(ctx.window.__np[dead], undefined, `${dead} removed from the test hook`);
  }
  // The pure projections History and the future Agents tab need are KEPT.
  assert.equal(typeof ctx.window.__np.subsGroupsForRender, 'function');
  assert.equal(typeof ctx.window.__np.cycleAwareLabel, 'function');
  assert.equal(typeof ctx.window.__np.stepSkillsFromSteps, 'function');
  assert.equal(typeof ctx.window.__np.stepGraphifyFromSteps, 'function');
  assert.equal(typeof ctx.window.__np.subGroupStatus, 'function', 'buildHdAgents still calls it');

  // Comment-blind: the History Agents block KEEPS two comments that name
  // `.subs-step:first-of-type` and `.subs-tree li .st` while explaining rules that
  // survive (style.css:1841, :1846-1848). `.subs-tree ` matches the raw regex, so
  // without this strip the sweep can never pass — Step 7 additionally rewords them.
  const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const dead of ['.subs-bar', '.btn-subs', '.subs-panel', '.subs-legend', '.subs-step', '.subs-tree']) {
    assert.doesNotMatch(css, new RegExp(dead.replace('.', '\\.') + '[\\s,{]'), `${dead} CSS removed`);
  }
  // The shared lists keep their History halves.
  assert.match(css, /\.hd-ag-head \.subs-stat\{/);
  assert.match(css, /\.hd-ag-row \.st\{/);
  assert.match(css, /\.subs-skills\{/, 'the unscoped .subs-skills base rule History renders through is kept');
});
