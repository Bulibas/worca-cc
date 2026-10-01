// test/ui-running-card.test.mjs — a live run's ROW in the Runs list: a link built by
// ui/public/runs-list.mjs holding a status icon, the title and a one-line subline
// ("<word> · <step or start time>"), and a click that opens the run in the pane
// (#running/<id>). The run card it replaced (header avatar, meta line, branch chip,
// Pause/Resume/Stop cluster, waiting strip) is gone (D14): Pause/Stop/Resume live in
// the pane's bar (test/ui-running-detail.test.mjs, test/ui-running-stop-modal.test.mjs,
// test/ui-running-resume.test.mjs) and a waiting run is listed under Needs you.
//
// boot()/dispatch()/helloRunning() are copied from test/ui-question.test.mjs (boot
// 19-82, RUN_ID 84, helloRunning 88-96) — the nearest suite that captures the
// WebSocket instance. showRunning() follows test/helpers/run-page-boot.mjs: the bare
// list with nothing selected (a bare #runs would otherwise reopen the remembered run, D6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));

async function boot({ fetchHandler } = {}) {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  // jsdom has no rAF; the run page defers its scroll-to-question by a frame
  // (paintRdQuestions). Same shim as test/ui-sidebar-counts.test.mjs.
  window.requestAnimationFrame = (fn) => setTimeout(fn, 0);

  const wsBox = { ws: null };
  window.WebSocket = class {
    constructor() {
      this.readyState = 1;
      this._listeners = {};
      wsBox.ws = this;
    }
    send() {}
    close() {}
    addEventListener(type, fn) {
      (this._listeners[type] ||= []).push(fn);
    }
    dispatch(type, evt) {
      (this._listeners[type] || []).forEach((fn) => fn(evt));
    }
  };

  const calls = [];
  window.fetch = (url, opts) => {
    calls.push({ url: String(url), opts: opts || {} });
    if (fetchHandler) {
      const r = fetchHandler(String(url), opts || {});
      if (r) return r;
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ projects: [], config: { steps: {}, customModels: [] }, models: [], efforts: [] }),
    });
  };

  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator', 'requestAnimationFrame']) {
    try {
      Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true });
    } catch {
      /* read-only global already present — leave it */
    }
  }
  globalThis.window = window;
  globalThis.document = window.document;

  await import(pathToFileURL(appPath).href + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0));

  function dispatch(msg) {
    wsBox.ws.dispatch('message', { data: JSON.stringify(msg) });
  }
  function go(hash) {
    window.location.hash = hash;
    window.dispatchEvent(new window.Event('hashchange'));
  }
  // The bare list with nothing selected: forget the remembered run first (rule 5).
  function showRunning() {
    window.localStorage.removeItem('worca-cc.runs.last');
    go('runs');
  }
  // Rows repaint on a microtask and a changed row is REPLACED: settle, then re-query.
  const settle = async (n = 3) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
  };
  return { window, dispatch, go, showRunning, settle, calls, wsBox };
}

const RUN_ID = 'run-aaa';

// A bare HH:MM:SS start is today's clock (makeRun), so the subline's time is stable.
function helloRunning(ctx, extra = {}, more = []) {
  ctx.wsBox.ws.dispatch('open', {});
  ctx.dispatch({
    type: 'hello',
    runs: [
      { runId: RUN_ID, title: 'Demo run', projectDir: '/tmp/p', status: 'running', kind: 'run', startedAt: '09:30:15', ...extra },
      ...more,
    ],
  });
}

// The run's row in its project group (a Needs-you run is repeated above it: rule 6).
const rowOf = (ctx, runId = RUN_ID) =>
  ctx.window.document.querySelector(`#runs-list .runs-row[data-slot="group"][data-run-id="${runId}"]`);
const needsRowOf = (ctx, runId = RUN_ID) =>
  ctx.window.document.querySelector(`#runs-list .runs-needs .runs-row[data-run-id="${runId}"]`);
const subOf = (row) => row.querySelector('.runs-row-sub').textContent;
const wordOf = (row) => subOf(row).split(' · ')[0];

// Two agent nodes (the manifest shape test/ui-run-hosts.test.mjs:15-26 uses).
const MANIFEST = {
  version: 2, template: { id: 'wf_t', name: 'T' },
  graph: {
    nodes: [
      { id: 'n_a', kind: 'agent', key: 'planner', x: 0, y: 0, label: 'Planner', color: 'violet',
        ports: { inputs: [{ id: 'task', type: 'md', loop: false }], outputs: [{ id: 'plan', type: 'md', when: 'always' }], await: true } },
      { id: 'n_b', kind: 'agent', key: 'implementer', x: 200, y: 0, label: 'Implement', color: 'blue',
        ports: { inputs: [{ id: 'plan', type: 'md', loop: false }], outputs: [{ id: 'code', type: 'md', when: 'always' }], await: true } },
      { id: 'n_end', kind: 'end', key: null, x: 400, y: 0, label: 'End', color: '',
        ports: { inputs: [{ id: 'result', type: 'any' }], outputs: [], await: false } },
    ],
    wires: [
      { id: 'w1', from: { node: 'n_a', port: 'plan' }, to: { node: 'n_b', port: 'plan' } },
      { id: 'w2', from: { node: 'n_b', port: 'code' }, to: { node: 'n_end', port: 'result' } },
    ],
  },
};
const step = (nodeId) => ({ key: `x:${nodeId}:1`, executionId: `x:${nodeId}:1`, nodeId, ordinal: 1, status: 'start',
  activeMs: 10, startedAt: '2026-08-26T10:00:00Z' });

test('row anatomy: a link with a status icon, the title and one subline — no card chrome', async () => {
  const ctx = await boot();
  helloRunning(ctx);
  ctx.showRunning();
  await ctx.settle();

  const row = rowOf(ctx);
  assert.ok(row, 'the live run is listed in its project group');
  assert.equal(row.tagName, 'A', 'a row is a plain link');
  assert.equal(row.getAttribute('href'), `#running/${RUN_ID}`);
  assert.equal(row.dataset.kind, 'live');

  const [ic, body, ...rest] = row.children;
  assert.equal(rest.length, 0, 'icon + body, nothing else');
  assert.ok(ic.classList.contains('runs-ic') && ic.classList.contains('runs-ic-run'), 'a running run wears the run icon');
  assert.equal(ic.getAttribute('aria-hidden'), 'true', 'the icon is decoration: the subline says the state');
  assert.ok(ic.querySelector('svg.runs-glyph-run'), 'one glyph for the state');
  assert.ok(body.classList.contains('runs-row-body'));
  assert.equal(body.querySelector('.runs-row-title').textContent, 'Demo run');
  assert.equal(subOf(row), 'Running · 09:30', 'no step yet: the word and the start time');

  assert.equal(row.querySelector('button'), null, 'no per-row actions (D14)');
  for (const sel of ['.rc-head', '.rc-sic', '.rc-meta', '.rc-acts', '.btn-pause', '.btn-resume', '.btn-stop', '.rc-open',
    '.rc-branch', '.run-time', '.run-cost', '.rc-wait', '.qpanel', '.log', '.run-foot'])
    assert.equal(row.querySelector(sel), null, `no ${sel} on the row`);
});

test('status icon + word per run state', async () => {
  const ctx = await boot();
  const run = (runId, extra) => ({ runId, title: runId, projectDir: '/tmp/p', kind: 'run', startedAt: '09:30:15', ...extra });
  helloRunning(ctx, {}, [
    run('s-starting', { status: 'starting' }),
    run('s-ask', { status: 'running', pendingQuestion: { id: 'q', questions: [{ question: 'x?' }] } }),
    run('s-paused', { status: 'paused' }),
    run('s-pausing', { status: 'pausing' }),
    run('s-interrupted', { status: 'running' }),
    run('s-done', { status: 'running' }),
    run('s-stopped', { status: 'running' }),
    run('s-error', { status: 'running' }),
  ]);
  // A run that ends LIVE lingers in the list until it is opened; hello-seeded
  // terminal runs never list (ui-pipeline-tabs: seed-on-first-hello).
  ctx.dispatch({ type: 'done', runId: 's-interrupted', status: 'interrupted' });
  ctx.dispatch({ type: 'done', runId: 's-done', status: 'done' });
  ctx.dispatch({ type: 'done', runId: 's-stopped', status: 'stopped' });
  ctx.dispatch({ type: 'done', runId: 's-error', status: 'error' });
  ctx.showRunning();
  await ctx.settle();

  const cases = [
    [RUN_ID,          'run',    'Running'],
    ['s-starting',    'start',  'Starting'],
    ['s-ask',         'ask',    'Question'],
    ['s-paused',      'paused', 'Paused'],
    ['s-pausing',     'paused', 'Pausing'],
    ['s-interrupted', 'paused', 'Interrupted'],
    ['s-done',        'done',   'Finished'],
    ['s-stopped',     'stop',   'Stopped'],
    ['s-error',       'fail',   'Failed'],
  ];
  for (const [id, icon, word] of cases) {
    const row = rowOf(ctx, id);
    assert.ok(row, `${id}: listed`);
    const ics = [...row.querySelectorAll('.runs-ic')];
    assert.equal(ics.length, 1, `${id}: exactly one icon`);
    assert.ok(ics[0].classList.contains(`runs-ic-${icon}`), `${id}: icon is ${icon}`);
    assert.equal(row.dataset.icon, icon);
    assert.equal(wordOf(row), word, `${id}: word`);
  }
  // Needs you (D5): the question, the pause and the unread failure; not pausing/interrupted.
  const needs = [...ctx.window.document.querySelectorAll('#runs-list .runs-needs .runs-row')].map((a) => a.dataset.runId);
  assert.deepEqual(needs, ['s-ask', 's-paused', 's-error']);
});

test('the subline names the running step: the active agent, or how many run', async () => {
  const ctx = await boot();
  helloRunning(ctx);
  ctx.showRunning();
  await ctx.settle();
  assert.equal(subOf(rowOf(ctx)), 'Running · 09:30', 'no manifest yet: the start time');

  ctx.dispatch({ type: 'state', runId: RUN_ID, status: 'running', stepper: MANIFEST,
    active: [{ nodeId: 'n_a', executionId: 'x:n_a:1' }], steps: [step('n_a')] });
  await ctx.settle();
  assert.equal(subOf(rowOf(ctx)), 'Running · Planner', 'the active agent’s label');

  ctx.dispatch({ type: 'state', runId: RUN_ID, status: 'running', stepper: MANIFEST,
    active: [{ nodeId: 'n_a', executionId: 'x:n_a:1' }, { nodeId: 'n_b', executionId: 'x:n_b:1' }],
    steps: [step('n_a'), step('n_b')] });
  await ctx.settle();
  assert.equal(subOf(rowOf(ctx)), 'Running · 2 agents', 'several agents: the count');
});

test('clicking a row opens #running/<runId> in the pane beside the list', async () => {
  const ctx = await boot();
  helloRunning(ctx);
  ctx.showRunning();
  await ctx.settle();
  const doc = ctx.window.document;
  assert.equal(doc.getElementById('run-shell').classList.contains('detail-open'), false, 'nothing open yet');
  assert.equal(doc.getElementById('runs-empty').hidden, false, 'the pane shows its empty state');

  rowOf(ctx).dispatchEvent(new ctx.window.Event('click', { bubbles: true, cancelable: true }));
  assert.equal(ctx.window.location.hash, `#running/${RUN_ID}`);
  await ctx.settle();
  assert.ok(doc.getElementById('run-shell').classList.contains('detail-open'), 'the pane opened the run');
  assert.equal(doc.querySelector('#run-detail .rd-title').textContent, 'Demo run');
  assert.ok(rowOf(ctx), 'the list stays beside it');
  assert.ok(rowOf(ctx).classList.contains('selected'), 'the open run’s row is marked');
  assert.equal(rowOf(ctx).getAttribute('aria-current'), 'true');
});

test('a pause repaints the row in place and lists the run under Needs you', async () => {
  const ctx = await boot();
  helloRunning(ctx);
  ctx.showRunning();
  await ctx.settle();
  assert.equal(wordOf(rowOf(ctx)), 'Running');
  assert.equal(needsRowOf(ctx), null);

  ctx.dispatch({ type: 'state', runId: RUN_ID, status: 'paused' });
  await ctx.settle();
  const row = rowOf(ctx);
  assert.ok(row.classList.contains('runs-row-live'), 'still the live row (resumable, not a finished result)');
  assert.equal(row.dataset.icon, 'paused');
  assert.equal(wordOf(row), 'Paused');
  assert.ok(needsRowOf(ctx), 'a paused run needs you');
  assert.equal(wordOf(needsRowOf(ctx)), 'Paused');
});

test('a pending question lists the run under Needs you; its row opens the run page, where the panel lives', async () => {
  const ctx = await boot();
  helloRunning(ctx);
  ctx.showRunning();
  await ctx.settle();
  const doc = ctx.window.document;
  assert.equal(doc.querySelector('#runs-list .runs-needs'), null, 'nothing needs you without a question');

  ctx.dispatch({
    type: 'question', runId: RUN_ID, id: 'q1', kind: 'clarify',
    questions: [{ id: 'a', question: 'x?', options: ['1'] }, { id: 'b', question: 'y?', options: ['2'] }],
  });
  await ctx.settle();
  const needs = needsRowOf(ctx);
  assert.ok(needs, 'the asking run is listed under Needs you');
  assert.equal(wordOf(needs), 'Question');
  assert.equal(wordOf(rowOf(ctx)), 'Question', 'its group row says the same');
  assert.ok(rowOf(ctx).querySelector('.runs-ic-ask'), 'and wears the question icon');
  assert.equal(doc.querySelector('#runs-list .qpanel'), null, 'the question panel is NOT mounted on the list');

  let scrolled = 0;
  ctx.window.Element.prototype.scrollIntoView = function () { scrolled += 1; };
  needs.dispatchEvent(new ctx.window.Event('click', { bubbles: true, cancelable: true }));
  assert.equal(ctx.window.location.hash, `#running/${RUN_ID}`, 'the row opens the run page');
  await ctx.settle();
  assert.ok(doc.querySelector('#run-detail .rd-questions .qpanel'), 'the panel is on the run page');
  assert.ok(scrolled > 0, 'and the page lands on it (the removed strip’s job)');

  ctx.dispatch({ type: 'question-resolved', runId: RUN_ID, id: 'q1' });
  await ctx.settle();
  assert.equal(needsRowOf(ctx), null, 'the run leaves Needs you when the question resolves');
  assert.equal(wordOf(rowOf(ctx)), 'Running');
});

test('a workflow proposal reads "Workflow review" on the row', async () => {
  const ctx = await boot();
  helloRunning(ctx);
  ctx.showRunning();
  ctx.dispatch({
    type: 'question', runId: RUN_ID, id: 'w1', kind: 'workflow',
    questions: [{ id: 'a', question: 'Pick', options: ['x'] }],
  });
  await ctx.settle();
  assert.equal(wordOf(rowOf(ctx)), 'Workflow review');
  assert.equal(wordOf(needsRowOf(ctx)), 'Workflow review');
});
