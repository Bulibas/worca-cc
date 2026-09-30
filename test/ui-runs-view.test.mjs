// test/ui-runs-view.test.mjs — the Runs page: one compact list beside a content pane.
// boot() / settle() / go() follow test/ui-running-routing.test.mjs (no shared harness, by convention).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(__dir, '..', 'ui', 'public', 'index.html');
const appPath = join(__dir, '..', 'ui', 'public', 'app.js');
const PROJECT = '/tmp/proj';
const KEY = 'proj-0000abcd';
const HIST = [
  { id: 'aaaa0001', projectKey: KEY, projectName: 'proj', projectDir: PROJECT, title: 'Merged thing', status: 'done',
    startedAt: '2026-09-29T09:18:00Z', mtime: 3, pr: { number: 7, state: 'MERGED', url: 'https://example.test/7' } },
  { id: 'aaaa0002', projectKey: KEY, projectName: 'proj', projectDir: PROJECT, title: 'Stopped thing', status: 'stopped',
    startedAt: '2026-09-29T08:00:00Z', mtime: 2 },
];
const windows = [];
afterEach(() => { while (windows.length) windows.pop().close(); });

async function settle(window, n = 4) { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); }
function go(window, hash) { window.location.hash = hash; window.dispatchEvent(new window.Event('hashchange')); }
const click = (window, node) => node.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
const esc = (window, target) => target.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
const live = (runId, extra = {}) => ({ runId, title: runId, projectDir: PROJECT, status: 'running', kind: 'run',
  startedAt: '10:00:00', pendingQuestion: null, ...extra });

// `setup(window)` runs before app.js loads: a stub its module-load wiring must see goes there.
async function boot({ url = 'http://localhost:4317/', storage = {}, projects = [{ name: 'proj', path: PROJECT, exists: true }], history = HIST, setup } = {}) {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url });
  const { window } = dom;
  windows.push(window);
  window.Element.prototype.scrollIntoView = function () {};
  if (setup) setup(window);
  let lastWs = null;
  window.WebSocket = class {
    constructor() { this.readyState = 1; this._l = {}; lastWs = this; }
    send() {} close() {}
    addEventListener(t, fn) { (this._l[t] ||= []).push(fn); }
  };
  const ok = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });
  window.fetch = (u) => {
    const s = String(u);
    if (s.includes('/api/projects')) return ok({ projects });
    // `history` may be a function: a test that reloads History can answer differently each time.
    if (s.endsWith('/api/history')) return ok({ pipelines: typeof history === 'function' ? history() : history, ghAvailable: true });
    // The detail itself only: a looser match would answer its /log, /diff and /comments with a state body.
    if (/\/api\/history\/[^/]+\/aaaa000[12]$/.test(s)) return ok({ state: { title: 'Merged thing', status: 'done', steps: [], stepper: null } });
    if (s.includes('/api/workspaces')) return ok({ workspaces: [] });
    if (s.endsWith('/api/schedules')) return ok({ schedules: [], tickets: [], counts: {} });
    return ok({ config: { steps: {}, customModels: [] }, models: [], efforts: [], pipelines: 0, projects: 0, workspaces: 0 });
  };
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch { /* read-only */ }
  }
  globalThis.window = window;
  globalThis.document = window.document;
  window.localStorage.clear();
  for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
  await import(pathToFileURL(appPath).href + `?b=${Date.now()}_${Math.random()}`);
  await settle(window);
  lastWs._l.open?.forEach((fn) => fn());
  const recv = (obj) => lastWs._l.message.forEach((fn) => fn({ data: JSON.stringify(obj) }));
  return { window, doc: window.document, recv };
}

test('one Runs nav item; a bare #running or #history lands on #runs with the empty state', async () => {
  const { window, doc } = await boot();
  assert.equal(doc.querySelectorAll('.nav button[data-nav="running"], .nav button[data-nav="history"]').length, 0);
  const btn = doc.querySelector('.nav button[data-nav="runs"]');
  click(window, btn);
  await settle(window);
  assert.equal(window.location.hash, '#runs');
  assert.equal(doc.querySelector('[data-view="runs"]').classList.contains('hidden'), false);
  assert.equal(btn.getAttribute('aria-current'), 'page');
  assert.equal(doc.getElementById('runs-empty').hidden, false, 'nothing remembered: the empty state');
  const depth = window.history.length;
  go(window, 'history'); await settle(window);
  assert.equal(window.location.hash, '#runs');
  assert.equal(window.history.length, depth + 1,
    '#history was REPLACED by #runs (a pushed #runs would make Back loop on #history)');
  go(window, 'new'); await settle(window);
  go(window, 'running'); await settle(window);
  assert.equal(window.location.hash, '#runs');
  assert.ok(btn.classList.contains('active'));
  assert.equal(doc.getElementById('mbar-title').textContent, 'Runs');
});

test('a row opens its run in the pane beside the list; the row is marked; the list stays usable', async () => {
  const { window, doc, recv } = await boot();
  recv({ type: 'hello', runs: [live('r1', { title: 'Employee Onboarding Checklist' })] });
  go(window, 'runs'); await settle(window);
  const row = doc.querySelector('#runs-list .runs-row[data-run-id="r1"]');
  assert.ok(row, 'the live run is listed');
  assert.equal(row.querySelector('.runs-row-title').textContent, 'Employee Onboarding Checklist');
  assert.equal(row.closest('.runs-group').dataset.groupKey, KEY, 'grouped with its project’s finished runs');
  click(window, row); await settle(window);
  assert.equal(window.location.hash, '#running/r1');
  assert.ok(doc.getElementById('run-shell').classList.contains('detail-open'));
  assert.equal(doc.getElementById('runs-pane').dataset.kind, 'live');
  assert.equal(doc.getElementById('runs-empty').hidden, true);
  assert.equal(doc.getElementById('runs-list-pane').hasAttribute('inert'), false, 'side by side the list is never inert');
  assert.ok(doc.querySelector('#runs-list .runs-row[data-run-id="r1"]').classList.contains('selected'));
  assert.equal(doc.querySelector('#run-detail .rd').dataset.mode, 'glance');
});

test('a live run groups with its registered project even before History loads', async () => {
  const { window, doc, recv } = await boot({
    projects: [{ name: 'proj', path: PROJECT, exists: true, key: KEY }], history: [],
  });
  recv({ type: 'hello', runs: [live('r1')] });
  go(window, 'runs'); await settle(window);
  assert.equal(doc.querySelector('#runs-list .runs-row[data-run-id="r1"]').closest('.runs-group').dataset.groupKey, KEY);
});

test('Details has a back button to the glance; Escape does the same; Escape on the glance keeps the pane', async () => {
  const { window, doc, recv } = await boot();
  recv({ type: 'hello', runs: [live('r1')] });
  go(window, 'running/r1/details/workflow'); await settle(window);
  const screen = doc.querySelector('#run-detail .rd');
  assert.equal(screen.dataset.mode, 'details');
  click(window, screen.querySelector('.rd-to-run')); await settle(window);
  assert.equal(window.location.hash, '#running/r1');
  assert.equal(screen.dataset.mode, 'glance');
  assert.equal(doc.activeElement, screen.querySelector('.rd-glance .rd-page-title'),
    'side by side the way back lands on the glance title, not <body>');
  go(window, 'running/r1/details'); await settle(window);
  esc(window, doc.body); await settle(window);
  assert.equal(window.location.hash, '#running/r1', 'Escape: Details -> glance');
  esc(window, doc.body); await settle(window);
  assert.equal(window.location.hash, '#running/r1', 'side by side, Escape on the glance does not close the pane');
});

test('narrow (slide) layout: the back button slides the run away and hands focus to its row', async () => {
  const { window, doc, recv } = await boot();
  recv({ type: 'hello', runs: [live('r1')] });
  go(window, 'runs'); await settle(window);
  doc.getElementById('runs-shell').dataset.layout = 'slide';   // jsdom has no ResizeObserver
  click(window, doc.querySelector('#runs-list .runs-row[data-run-id="r1"]')); await settle(window);
  assert.equal(doc.getElementById('runs-list-pane').hasAttribute('inert'), true, 'the list slid away');
  click(window, doc.querySelector('#run-detail .rd-back')); await settle(window);
  assert.equal(window.location.hash, '#runs', 'no restore inside the page in the slide layout');
  assert.equal(doc.getElementById('run-shell').classList.contains('detail-open'), false);
  assert.ok(doc.querySelector('#run-detail .rd'), 'animated close: the screen stays mounted while it slides');
  assert.equal(doc.getElementById('runs-list-pane').hasAttribute('inert'), false);
  assert.equal(doc.activeElement && doc.activeElement.dataset.runId, 'r1', 'focus returns to the row');
  await new Promise((r) => setTimeout(r, 650));
  assert.equal(doc.getElementById('run-detail').innerHTML, '', 'emptied after the slide');
});

// The page's width decides the layout (D7): below 880px the panes slide instead.
// jsdom has no layout, so the shell's width is stubbed, and ResizeObserver is captured.
function sized(width) {
  const box = { width, resize: null };
  const setup = (window) => {
    Object.defineProperty(window.document.getElementById('runs-shell'), 'clientWidth', { configurable: true, get: () => box.width });
    window.ResizeObserver = class {
      constructor(fn) { this.fn = fn; }
      observe(node) { if (node.id === 'runs-shell') box.resize = (w) => this.fn([{ contentRect: { width: w } }]); }
      unobserve() {} disconnect() {}
    };
  };
  return { box, setup };
}

test('entering Runs measures the page: narrow slides, wide splits, an unmeasured (0px) page keeps the last', async () => {
  const { box, setup } = sized(700);
  const { window, doc } = await boot({ setup });
  const layout = () => doc.getElementById('runs-shell').dataset.layout;
  go(window, 'runs'); await settle(window);
  assert.equal(layout(), 'slide', '700px < 880px');
  go(window, 'new'); await settle(window);
  box.width = 880;
  go(window, 'runs'); await settle(window);
  assert.equal(layout(), 'split', '880px is wide enough');
  go(window, 'new'); await settle(window);
  box.width = 0;
  go(window, 'runs'); await settle(window);
  assert.equal(layout(), 'split', '0px (a hidden section) keeps the last layout');
  go(window, 'new'); await settle(window);
  box.width = 879;
  go(window, 'runs'); await settle(window);
  assert.equal(layout(), 'slide');
});

test('a narrow first open slides the list away at once', async () => {
  const { setup } = sized(700);
  const { window, doc, recv } = await boot({ setup });
  recv({ type: 'hello', runs: [live('r1')] });
  go(window, 'running/r1'); await settle(window);
  assert.equal(doc.getElementById('runs-shell').dataset.layout, 'slide');
  const list = doc.getElementById('runs-list-pane');
  assert.equal(list.hasAttribute('inert'), true, 'measured before the run opened');
  assert.equal(list.getAttribute('aria-hidden'), 'true');
  assert.equal(doc.activeElement, doc.querySelector('#run-detail .rd-back'), 'the slide lands on the way back');
});

test('resizing with a run open flips the layout without animating; focus in the list moves to the way back', async () => {
  const { box, setup } = sized(1200);
  const { window, doc, recv } = await boot({ setup });
  assert.equal(typeof box.resize, 'function', 'Runs observes its shell (through window.ResizeObserver)');
  recv({ type: 'hello', runs: [live('r1')] });
  go(window, 'runs'); await settle(window);
  const shell = doc.getElementById('runs-shell');
  const list = doc.getElementById('runs-list-pane');
  const row = doc.querySelector('#runs-list .runs-row[data-run-id="r1"][data-slot="group"]');
  row.focus();
  click(window, row); await settle(window);
  assert.equal(shell.dataset.layout, 'split');
  assert.equal(doc.activeElement.dataset.runId, 'r1', 'side by side, focus stays on the row');
  await settle(window);
  shell.classList.remove('no-anim');
  box.resize(700);
  assert.equal(shell.dataset.layout, 'slide');
  assert.ok(shell.classList.contains('no-anim'), 'a resize never slides');
  assert.equal(list.hasAttribute('inert'), true, 'the open run covers the list');
  assert.equal(list.getAttribute('aria-hidden'), 'true');
  assert.equal(doc.getElementById('runs-pane').hasAttribute('inert'), false);
  assert.equal(doc.activeElement, doc.querySelector('#run-detail .rd-back'), 'focus left the now-inert list');
  await settle(window);
  assert.equal(shell.classList.contains('no-anim'), false, 'held for one frame only');
  box.resize(1200);
  assert.equal(shell.dataset.layout, 'split');
  assert.equal(list.hasAttribute('inert'), false);
  assert.equal(list.hasAttribute('aria-hidden'), false);
  box.resize(0);
  assert.equal(shell.dataset.layout, 'split', 'a 0px entry (the section hidden) keeps the layout');
});

test('a finished run opens its saved page in the same pane and closes the live one', async () => {
  const { window, doc, recv } = await boot();
  recv({ type: 'hello', runs: [live('r1')] });
  go(window, 'running/r1'); await settle(window);
  const hrow = doc.querySelector(`#runs-list .runs-row[data-pipeline-id="aaaa0001"][data-project-key="${KEY}"]`);
  assert.ok(hrow);
  assert.equal(hrow.querySelector('.runs-row-sub').textContent.split(' · ')[0], 'Merged');
  click(window, hrow); await settle(window);
  assert.equal(window.location.hash, `#history/${KEY}/aaaa0001`);
  assert.ok(doc.getElementById('hist-shell').classList.contains('detail-open'));
  assert.equal(doc.getElementById('run-shell').classList.contains('detail-open'), false);
  assert.equal(doc.getElementById('run-detail').innerHTML, '', 'a detail -> detail hop swaps the pane at once');
  assert.equal(doc.getElementById('runs-pane').dataset.kind, 'hist');
  assert.ok(doc.querySelector(`#runs-list .runs-row[data-pipeline-id="aaaa0001"]`).classList.contains('selected'));
});

test('opening a lingering run side by side keeps focus on its (now History) row', async () => {
  // Opening a finished run acknowledges it: the same paint re-keys its row live:<runId> ->
  // hist:<projectKey>/<pipelineId>, and a restore by row key alone dropped focus to <body>.
  const { window, doc, recv } = await boot();
  recv({ type: 'hello', runs: [live('r1', { pipelineId: 'aaaa0001' })] });
  recv({ type: 'done', runId: 'r1', status: 'error' });
  go(window, 'runs'); await settle(window);
  const row = doc.querySelector('#runs-list .runs-row[data-run-id="r1"][data-slot="group"]');
  assert.ok(row, 'the failed run lingers as a live row');
  row.focus();
  click(window, row); await settle(window);
  assert.equal(window.location.hash, '#running/r1');
  assert.equal(doc.getElementById('runs-shell').dataset.layout || 'split', 'split');
  const a = doc.activeElement;
  assert.notEqual(a, doc.body, 'focus did not drop to <body>');
  assert.equal(a.dataset.pipelineId, 'aaaa0001');
  assert.equal(a.dataset.slot, 'group', 'the row the user activated, not its Needs-you copy');
  assert.equal(a.dataset.kind, 'hist', 'its History row now stands for it');
});

test('opening a failed run from Needs you keeps focus on its row once it leaves Needs you', async () => {
  const { window, doc, recv } = await boot();
  recv({ type: 'hello', runs: [live('r1', { pipelineId: 'aaaa0001' })] });
  recv({ type: 'done', runId: 'r1', status: 'error' });
  go(window, 'runs'); await settle(window);
  const row = doc.querySelector('#runs-list .runs-needs .runs-row[data-run-id="r1"]');
  assert.ok(row, 'a failed run needs you');
  row.focus();
  click(window, row); await settle(window);
  const a = doc.activeElement;
  assert.notEqual(a, doc.body, 'focus did not drop to <body>');
  assert.equal(a.dataset.pipelineId, 'aaaa0001', 'the acknowledged run left Needs you: its group row');
});

test('a live row listed before its pipeline id arrives picks the id up', async () => {
  const { window, doc, recv } = await boot();
  recv({ type: 'hello', runs: [live('r1')] });
  go(window, 'runs'); await settle(window);
  const row = () => doc.querySelector('#runs-list .runs-row[data-run-id="r1"][data-slot="group"]');
  assert.equal(row().dataset.pipelineId, undefined);
  recv({ type: 'state', runId: 'r1', id: 'p9a8b7c6' });   // the first snapshot after createPipeline
  await settle(window);
  assert.equal(row().dataset.pipelineId, 'p9a8b7c6', 'selection and focus fallbacks match on it');
});

test('the pane remembers the last run: leave and come back and it reopens', async () => {
  const { window, doc, recv } = await boot();
  recv({ type: 'hello', runs: [live('r1')] });
  go(window, 'running/r1'); await settle(window);
  go(window, 'new'); await settle(window);
  click(window, doc.querySelector('.nav button[data-nav="runs"]')); await settle(window);
  assert.equal(window.location.hash, '#running/r1');
  assert.ok(doc.getElementById('run-shell').classList.contains('detail-open'));
});

test('a remembered run the server no longer knows opens its saved page', async () => {
  const storage = { 'worca-cc.runs.last': JSON.stringify({ runId: 'gone', pipelineId: 'aaaa0001', projectKey: KEY }) };
  const { window, doc, recv } = await boot({ storage });
  recv({ type: 'hello', runs: [] });
  await settle(window);
  go(window, 'runs'); await settle(window);
  assert.equal(window.location.hash, `#history/${KEY}/aaaa0001`);
  assert.ok(doc.getElementById('hist-shell').classList.contains('detail-open'));
});

test('a reload onto #runs whose remembered run ended meanwhile lands on its saved page', async () => {
  // Boot ON #runs: before `hello` the memory is trusted and the live stub opens. That open
  // must not overwrite the stored pipeline/project, or the bounce after `hello` has nowhere to go.
  const storage = { 'worca-cc.runs.last': JSON.stringify({ runId: 'gone', pipelineId: 'aaaa0001', projectKey: KEY }) };
  const { window, doc, recv } = await boot({ url: 'http://localhost:4317/#runs', storage });
  assert.equal(window.location.hash, '#running/gone', 'restored before hello');
  const kept = JSON.parse(window.localStorage.getItem('worca-cc.runs.last'));
  assert.equal(kept.pipelineId, 'aaaa0001');
  assert.equal(kept.projectKey, KEY);
  const depth = window.history.length;
  recv({ type: 'hello', runs: [] });
  await settle(window);
  assert.equal(window.location.hash, `#history/${KEY}/aaaa0001`);
  assert.equal(window.history.length, depth,
    'the dead #running/gone entry was REPLACED: a pushed bounce would leave it for Back to bounce off again');
  await settle(window);
  assert.ok(doc.getElementById('hist-shell').classList.contains('detail-open'));
});

test('a dead #running link shows the list, not the other run the pane remembers', async () => {
  const { window, doc, recv } = await boot();
  recv({ type: 'hello', runs: [live('r1')] });
  go(window, 'running/r1'); await settle(window);            // the pane now remembers r1
  go(window, 'new'); await settle(window);
  go(window, 'running/dead'); await settle(window);          // e.g. an old Ask card's link
  assert.equal(window.location.hash, '#runs');
  assert.equal(doc.getElementById('run-shell').classList.contains('detail-open'), false, 'not r1');
  assert.equal(doc.getElementById('runs-empty').hidden, false, 'the list and the empty pane (D6: "else the list")');
});

test('a live run offers "Schedule a run after this" in its bar once it has a pipeline id', async () => {
  const { window, doc, recv } = await boot();
  recv({ type: 'hello', runs: [live('r1', { pipelineId: 'p1a2b3c4' })] });
  go(window, 'running/r1'); await settle(window);
  const btn = doc.querySelector('#run-detail .rd-bar .rd-after');
  assert.ok(btn, 'the run card’s .rc-after moved to the rd bar (D14)');
  assert.equal(btn.getAttribute('data-min-level'), 'advanced');
  assert.equal(btn.hidden, false);
  click(window, btn);
  // Read the hash synchronously, as ui-schedules-after-card does: routing on into New's
  // predecessor picker (openAfterForNew fetches /api/schedules/after/…) is not this test's business.
  assert.equal(window.location.hash, '#new/after/p1a2b3c4');
});

test('a Needs-you question row for the run already open lands the pane on its question', async () => {
  const { window, doc, recv } = await boot();
  // The clarify shape test/ui-question.test.mjs uses (clarifyEvent): it paints #run-detail .rd-questions.
  const pq = { id: 'clarify-1', kind: 'clarify',
    questions: [{ id: 'q1', question: 'Where to store sessions?', options: ['Redis', 'Postgres', ''], allowFreeText: true }] };
  recv({ type: 'hello', runs: [live('q1', { pendingQuestion: pq })] });
  go(window, 'running/q1/details'); await settle(window);
  const screen = doc.querySelector('#run-detail .rd');
  let scrolled = 0;
  window.Element.prototype.scrollIntoView = function () { scrolled += 1; };
  click(window, doc.querySelector('#runs-list .runs-needs .runs-row[data-run-id="q1"]')); await settle(window);
  assert.equal(window.location.hash, '#running/q1');
  assert.equal(screen.dataset.mode, 'glance');
  assert.ok(scrolled > 0, 'scrolled to the question without waiting for a panel rebuild');
});

test('a History reload keeps each row’s last known PR until Phase 2 answers', async () => {
  let calls = 0;
  const history = () => (calls++ === 0 ? HIST : HIST.map(({ pr, ...rest }) => rest));   // reloads carry no pr, like the server
  const { window, doc, recv } = await boot({ history });
  go(window, 'runs'); await settle(window);
  const word = () => doc.querySelector(`#runs-list .runs-row[data-pipeline-id="aaaa0001"] .runs-row-sub`).textContent.split(' · ')[0];
  assert.equal(word(), 'Merged');
  recv({ type: 'pipelines-changed' });                  // app.js:1074 → loadHistoryView({ force: true })
  await settle(window, 8);
  assert.ok(calls >= 2, 'History was fetched again');
  assert.equal(word(), 'Merged', 'not "Finished" while the PR lookup runs');
});

test('Needs you holds the question and the pause, each repeated in its project group; the badge counts them', async () => {
  const { window, doc, recv } = await boot();
  recv({ type: 'hello', runs: [
    live('q1', { pendingQuestion: { id: 'q', kind: 'workflow' } }),
    live('p1', { status: 'paused', pauseReason: 'cost_pipeline' }),
    live('r1'),
  ] });
  go(window, 'runs'); await settle(window);
  const needs = [...doc.querySelectorAll('#runs-list .runs-needs .runs-row')].map((a) => a.dataset.runId);
  assert.deepEqual(needs, ['q1', 'p1']);
  const inGroup = [...doc.querySelectorAll(`#runs-list .runs-group[data-group-key="${KEY}"] .runs-row`)].map((a) => a.dataset.runId || '');
  for (const id of ['q1', 'p1', 'r1']) assert.ok(inGroup.includes(id), `${id} in its project group`);
  const badge = doc.getElementById('nav-needs-count');
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, '2');
  assert.match(doc.querySelector('.nav button[data-nav="runs"]').getAttribute('aria-label'), /^Runs — 2 need you/);
});

test('the magnifier opens a search by status, project or name; Escape clears and closes it', async () => {
  const { window, doc } = await boot();
  go(window, 'runs'); await settle(window);
  const btn = doc.getElementById('runs-search-btn');
  click(window, btn); await settle(window);
  assert.equal(doc.getElementById('runs-search-row').hidden, false);
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  const input = doc.getElementById('runs-search');
  input.value = 'stopped';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await settle(window);
  const titles = () => [...doc.querySelectorAll('#runs-list .runs-group .runs-row-title')].map((n) => n.textContent);
  assert.deepEqual(titles(), ['Stopped thing']);
  esc(window, input); await settle(window);
  assert.equal(doc.getElementById('runs-search-row').hidden, true);
  assert.deepEqual(titles(), ['Merged thing', 'Stopped thing']);
});

test('a folded project group stays folded across reloads', async () => {
  const first = await boot();
  go(first.window, 'runs'); await settle(first.window);
  const head = first.doc.querySelector(`#runs-list .runs-group-head[data-group-key="${KEY}"]`);
  click(first.window, head); await settle(first.window);
  const saved = first.window.localStorage.getItem('worca-cc.runs.collapsed');
  assert.deepEqual(JSON.parse(saved), [KEY]);
  const second = await boot({ storage: { 'worca-cc.runs.collapsed': saved } });
  go(second.window, 'runs'); await settle(second.window);
  const head2 = second.doc.querySelector(`#runs-list .runs-group-head[data-group-key="${KEY}"]`);
  assert.equal(head2.getAttribute('aria-expanded'), 'false');
  assert.equal(second.doc.querySelector(`#runs-list .runs-group[data-group-key="${KEY}"] .runs-row`), null);
});

test('a log line does not rebuild the list', async () => {
  const { window, doc, recv } = await boot();
  recv({ type: 'hello', runs: [live('r1')] });
  go(window, 'runs'); await settle(window);
  const list = doc.getElementById('runs-list');
  let mutations = 0;
  new window.MutationObserver((m) => { mutations += m.length; }).observe(list, { childList: true, subtree: true });
  recv({ type: 'log', runId: 'r1', source: 'planner', level: 'info', text: 'hello', ts: 9 });
  await settle(window);
  assert.equal(mutations, 0);
});
