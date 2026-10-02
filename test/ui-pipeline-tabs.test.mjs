// test/ui-pipeline-tabs.test.mjs — live runs in the Runs list and the sidebar badges. The
// sidebar no longer lists runs under Runs; a live run's state shows as its Runs-list row icon.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { useDomRelease } from './helpers/jsdom-release.mjs';

// Release each booted window after its test (see test/helpers/jsdom-release.mjs).
const trackDom = useDomRelease(afterEach);

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..', 'ui', 'public');
const htmlPath = join(root, 'index.html');
const appPath = join(root, 'app.js');
const PROJECT = '/tmp/proj';

async function boot() {
  const dom = trackDom(new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' }));
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
  await import(pathToFileURL(appPath).href + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0));
  const open = () => lastWs._l.open?.forEach((fn) => fn());
  const recv = (obj) => lastWs._l.message.forEach((fn) => fn({ data: JSON.stringify(obj) }));
  open();
  return { window, recv };
}
// Rows repaint on a microtask and a changed row is REPLACED: settle, then re-query.
const settle = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
// A run's row in its project group (a Needs-you run is repeated above it: rule 6).
const groupRow = (doc, runId) => doc.querySelector(`#runs-list .runs-row[data-slot="group"][data-run-id="${runId}"]`);
const showRuns = async (window) => {
  window.location.hash = 'runs';
  window.dispatchEvent(new window.Event('hashchange'));
  await settle();
};
const openRun = async (window, runId) => {
  window.location.hash = `running/${runId}`;
  window.dispatchEvent(new window.Event('hashchange'));
  await settle();
};

const live = (runId, extra = {}) => ({
  runId, title: runId, projectDir: PROJECT, status: 'running', kind: 'run',
  startedAt: '10:00:00', pendingQuestion: null, ...extra,
});

test('hello with two live pipelines lists both in Runs + live badge', async () => {
  const { window, recv } = await boot();
  recv({ type: 'hello', runs: [live('auth-fix'), live('seo-pSEO')] });
  await showRuns(window);
  assert.ok(groupRow(window.document, 'auth-fix') && groupRow(window.document, 'seo-pSEO'));
  assert.equal(window.document.querySelector('#nav-running-children'), null, 'no per-run rows in the sidebar');
  assert.equal(window.document.querySelector('#nav-running-count').textContent, '2');
});

test('a pending question lands in Needs you + the parent roll-up', async () => {
  const { window, recv } = await boot();
  recv({ type: 'hello', runs: [live('auth-fix', { pendingQuestion: { id: 'q1', kind: 'clarify', questions: [{ question: 'x?', options: ['a'] }] } })] });
  await showRuns(window);
  assert.ok(window.document.querySelector('#runs-list .runs-needs .runs-row[data-run-id="auth-fix"]'), 'listed under Needs you');
  // The parent roll-up is the Runs button's amber Needs-you count now (D11).
  const needs = window.document.querySelector('#nav-needs-count');
  assert.equal(needs.hidden, false, 'the Runs button shows the Needs-you count');
  assert.equal(needs.textContent, '1');
  assert.equal(window.document.querySelector('#mbar-rollup').hidden, false, 'the phone bar mirrors it on the menu button');
});

test('#running/<id> opens the run in the pane and leaves the list intact', async () => {
  const { window, recv } = await boot();
  recv({ type: 'hello', runs: [live('auth-fix'), live('seo-pSEO')] });
  window.location.hash = 'running/auth-fix';
  window.dispatchEvent(new window.Event('hashchange'));
  await settle();
  // The single-card focus view is gone (spec §7): #running/<id> opens the run in
  // the pane BESIDE the list, so the list still holds every run.
  const rows = window.document.querySelectorAll('#runs-list .runs-row[data-slot="group"]');
  assert.deepEqual([...rows].map((a) => a.dataset.runId).sort(), ['auth-fix', 'seo-pSEO']);
  assert.ok(window.document.querySelector('#run-shell').classList.contains('detail-open'));
  assert.equal(window.document.querySelector('#run-detail .rd-title').textContent, 'auth-fix');
});

test('a run finishing live lingers in the Runs list, then drops once opened', async () => {
  const { window, recv } = await boot();
  recv({ type: 'hello', runs: [live('auth-fix')] });
  recv({ type: 'done', runId: 'auth-fix', status: 'done' });        // finishes LIVE
  await showRuns(window);
  const row = groupRow(window.document, 'auth-fix');
  assert.ok(row, 'lingerer still present');
  assert.equal(row.dataset.icon, 'done');
  await openRun(window, 'auth-fix');                                // open → acknowledge
  await showRuns(window);
  assert.equal(groupRow(window.document, 'auth-fix'), null, 'acknowledged run drops from the live rows');
});

// Regression: watching a run LIVE (focus view open) must not pre-acknowledge it.
// Opening a still-running run used to call acknowledgeRun, which made the later
// markLingering a no-op so the finished run skipped Running straight into History.
test('opening a run while LIVE does not suppress its later linger', async () => {
  const { window, recv } = await boot();
  recv({ type: 'hello', runs: [live('auth-fix')] });
  await openRun(window, 'auth-fix');                                // open while still running
  await showRuns(window);                                           // leave before it finishes
  recv({ type: 'done', runId: 'auth-fix', status: 'done' });        // finishes LIVE
  await settle();
  const row = groupRow(window.document, 'auth-fix');
  assert.ok(row, 'finished run still lingers (not acknowledged by live-open)');
  assert.equal(row.dataset.icon, 'done');
});

test('a run finishing live shows the done icon', async () => {
  const { window, recv } = await boot();
  recv({ type: 'hello', runs: [live('auth-fix')] });
  recv({ type: 'done', runId: 'auth-fix', status: 'done' });
  await showRuns(window);
  assert.equal(groupRow(window.document, 'auth-fix').dataset.icon, 'done');
});

// A PAUSED run is parked in Running (resumable), not a finished result: it stays
// in the list with a static amber dot + no green/red end marker, and opening it
// (to Resume) must NOT drop it into History.
test('a paused run stays a live row with the paused icon, even once opened', async () => {
  const { window, recv } = await boot();
  recv({ type: 'hello', runs: [live('auth-fix')] });
  recv({ type: 'done', runId: 'auth-fix', status: 'paused' });      // pause routes through finishRun
  await showRuns(window);
  assert.equal(groupRow(window.document, 'auth-fix').dataset.icon, 'paused');
  await openRun(window, 'auth-fix');                                // open to Resume
  await showRuns(window);
  assert.ok(groupRow(window.document, 'auth-fix'), 'opening a paused run does NOT drop it');
});

// Resuming a paused run mints a NEW runId; the pre-pause log must be carried into
// the resumed run so its page shows ALL logs, not just the ones before pause.
// Nothing on the list resumes any more (D14): Resume is the run page's .rd-pause.
test('resuming a paused run carries the pre-pause log into the resumed run', async () => {
  const { window, recv } = await boot();
  const origFetch = window.fetch;
  window.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('/api/resume')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, runId: 'auth-fix-2', pipelineId: 'auth-fix' }) });
    }
    if (u.includes('/log')) return Promise.resolve({ ok: true, status: 200, text: async () => '' });
    return origFetch(url, opts);
  };
  globalThis.fetch = window.fetch;

  recv({ type: 'hello', runs: [live('auth-fix', { pipelineId: 'auth-fix' })] });
  recv({ type: 'log', runId: 'auth-fix', text: 'PRE_PAUSE_LINE', ts: 1 });
  recv({ type: 'done', runId: 'auth-fix', status: 'paused' });

  window.location.hash = 'running/auth-fix';                         // the paused run's page
  window.dispatchEvent(new window.Event('hashchange'));
  await settle();
  const btn = window.document.querySelector('#run-detail .rd-pause');
  assert.ok(btn && !btn.hidden, 'the run page offers the control');
  assert.equal(btn.dataset.action, 'resume', 'as Resume on the paused run');
  btn.click();
  await settle();

  assert.equal(window.location.hash, '#running/auth-fix-2', 'resume lands on the resumed run');
  assert.ok(groupRow(window.document, 'auth-fix-2'), 'resumed run (new runId) row present');
  window.location.hash = 'running/auth-fix-2/details/logs';          // the run page's Live log tab
  window.dispatchEvent(new window.Event('hashchange'));
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  const box = window.document.querySelector('#run-detail .rd-sec[data-sec="logs"] .log');
  assert.ok(box, 'the run page renders the Live log');
  assert.match(box.textContent, /PRE_PAUSE_LINE/, 'pre-pause log carried into the resumed run');
  assert.equal(
    groupRow(window.document, 'auth-fix'), null,
    'old paused run row dropped (no split/dup)'
  );
});

test('a run failing live shows the failed icon', async () => {
  const { window, recv } = await boot();
  recv({ type: 'hello', runs: [live('auth-fix')] });
  recv({ type: 'done', runId: 'auth-fix', status: 'error' });
  await showRuns(window);
  assert.equal(groupRow(window.document, 'auth-fix').dataset.icon, 'fail');
});

test('seed-on-first-hello: a pre-existing terminal run is NOT a lingerer', async () => {
  const { window, recv } = await boot();
  recv({ type: 'hello', runs: [live('old-done', { status: 'done' })] });
  const rows = window.document.querySelectorAll('#nav-running-children .nav-child');
  assert.equal(rows.length, 0);
});

// v2 + D7: a live NON-pipeline run (e.g. a scan) gets no child tab AND no
// Runs row — the live rows are pipelines only, and a scan's progress belongs to its
// wizard. This deliberately reverses the Q&A #3 carve-out the original of this
// test locked in.
test('a live non-pipeline run renders nowhere in Runs', async () => {
  const { window, recv } = await boot();
  recv({ type: 'hello', runs: [live('scan-1', { kind: 'scan' })] });
  const tabs = window.document.querySelectorAll('#nav-running-children .nav-child');
  assert.equal(tabs.length, 0, 'scan gets no pipeline tab');
  window.location.hash = 'runs';   // the list paints #runs-list only while on the Runs view
  window.dispatchEvent(new window.Event('hashchange'));
  await settle();
  const rows = window.document.querySelectorAll('#runs-list .runs-row');
  assert.equal(rows.length, 0, 'and no row either');
  assert.ok(window.document.querySelector('#runs-list .runs-note'), 'the list shows its empty note');
});

// One badge on Runs (D11): green = running count; a paused run needs you, so it
// lands in the amber Needs-you count, hidden at zero. liveRuns() excludes 'paused'
// so the counts are disjoint.
test('a paused pipeline counts in the amber Needs-you badge; the running count excludes it', async () => {
  const { window, recv } = await boot();
  recv({ type: 'hello', runs: [live('auth-fix'), live('seo-pSEO')] });
  assert.equal(window.document.querySelector('#nav-needs-count').hidden, true, 'Needs-you badge hidden at zero');
  recv({ type: 'done', runId: 'auth-fix', status: 'paused' });
  assert.equal(window.document.querySelector('#nav-running-count').textContent, '1');
  assert.equal(window.document.querySelector('#nav-needs-count').textContent, '1');
  assert.equal(window.document.querySelector('#nav-needs-count').hidden, false);
});

// Green is spent only on work in flight. At zero the running badge takes the
// sidebar's inert-inventory grey (the treatment the Schedules count gets), so a
// permanently green pill cannot dilute the green that should catch the eye. It
// is greyed, not hidden: Schedules shows a grey 0 too.
test('the running badge is green only while something is running, grey at zero', async () => {
  const { window, recv } = await boot();
  const badge = window.document.querySelector('#nav-running-count');
  assert.equal(badge.textContent, '0');
  assert.ok(badge.classList.contains('n-grey'), 'zero is inert — grey, like Schedules');
  assert.ok(!badge.classList.contains('n-run'), 'no green when nothing runs');
  assert.equal(badge.hidden, false, 'greyed, not hidden');

  recv({ type: 'hello', runs: [live('auth-fix')] });
  assert.equal(badge.textContent, '1');
  assert.ok(badge.classList.contains('n-run'), 'green once work is in flight');
  assert.ok(!badge.classList.contains('n-grey'));

  // ...and back to grey when the last run finishes.
  recv({ type: 'done', runId: 'auth-fix', status: 'done' });
  assert.equal(badge.textContent, '0');
  assert.ok(badge.classList.contains('n-grey'), 'green must not linger past the work');
  assert.ok(!badge.classList.contains('n-run'));
});

test('index.html ships the running badge grey — zero is its resting state', () => {
  const html = readFileSync(htmlPath, 'utf8');
  assert.match(html, /<span class="nav-count n-grey" id="nav-running-count">0<\/span>/,
    'the static badge must not be green before any run exists');
});

// Workspace runs list every member project in the child hint (clamped by CSS).
// A run started by ANOTHER tab / the CLI arrives via the run-created broadcast
// (hello is once-per-socket) and must carry its project metadata immediately.
test('run-created broadcast lists the run under its project without a reload', async () => {
  const { window, recv } = await boot();
  recv({ type: 'hello', runs: [] });
  recv({ type: 'run-created', runId: 'fresh', title: 'fresh run', projectDir: PROJECT, kind: 'run', status: 'starting', startedAt: '10:00:00' });
  await showRuns(window);
  const row = groupRow(window.document, 'fresh');
  assert.ok(row, 'row present without a reload');
  assert.equal(row.closest('.runs-group').querySelector('.runs-group-name').textContent, 'proj');
  assert.equal(window.document.querySelector('#nav-running-count').textContent, '1');
});

// D8 (was Q&A #5): finishing the run whose DETAIL page is open no longer bounces
// to the list — the page stays and goes terminal. The old single-card focus view
// had to bounce because it rendered nothing once the run finished.
test('finishing the open run keeps its detail page', async () => {
  const { window, recv } = await boot();
  recv({ type: 'hello', runs: [live('auth-fix'), live('seo-pSEO')] });
  window.location.hash = 'running/auth-fix';
  window.dispatchEvent(new window.Event('hashchange'));
  recv({ type: 'done', runId: 'auth-fix', status: 'done' });        // open run finishes
  assert.equal(window.location.hash.replace(/^#/, ''), 'running/auth-fix', 'no redirect');
  assert.ok(window.document.querySelector('#run-shell').classList.contains('detail-open'));
});
