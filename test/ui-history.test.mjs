import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { useDomRelease } from './helpers/jsdom-release.mjs';

// Release each booted window after its test (see test/helpers/jsdom-release.mjs).
const trackDom = useDomRelease(afterEach);

// Behavior tests for the finished runs in the Runs list (`#runs-list .runs-row[data-kind="hist"]`,
// the History rows from GET /api/history). We boot the REAL app.js against the REAL
// index.html under jsdom, stub fetch + WebSocket, navigate to #runs (which loads
// History), and assert the rows render, link to the saved page, and show the load
// states. Card-only features (the meta segments, the diff pill) left with the card (D14).
//
// Each test gets a fresh DOM + a fresh module import (cache-busted) so module
// top-level state can't leak between cases.

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));

const PROJECT = '/tmp/proj';

// Boot app.js into a fresh jsdom window. `fetchHandler(url, opts)` may return a
// Promise to override a request; returning null falls through to the defaults.
async function boot({ fetchHandler } = {}) {
  const dom = trackDom(new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' }));
  const { window } = dom;

  // jsdom doesn't implement scrollIntoView; the viewer modal calls it on open.
  window.Element.prototype.scrollIntoView = function () {};

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
    // Default boot fetches: /api/projects returns our one project so the select
    // can be populated; /api/config benign.
    if (String(url).includes('/api/projects')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ projects: [{ name: 'proj', path: PROJECT, exists: true }] }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ config: { steps: {}, customModels: [] }, models: [], efforts: [] }),
    });
  };

  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator']) {
    try {
      Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true });
    } catch {
      /* read-only global already present — leave it */
    }
  }
  globalThis.window = window;
  globalThis.document = window.document;

  await import(pathToFileURL(appPath).href + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0)); // let loadProjects/loadConfig settle

  // Select our project the way a user would: set the <select> value + dispatch
  // change. This triggers onProjectChanged -> loadHistory(PROJECT).
  function selectProject() {
    const sel = window.document.querySelector('#projectSelect');
    sel.value = PROJECT;
    sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  }
  // The Runs page (History's rows live in its list now).
  function showRuns() {
    window.location.hash = 'runs';
    window.dispatchEvent(new window.Event('hashchange'));
  }
  // Open the run's DETAIL screen (#history/<key>/<id>) in the Runs pane.
  function showDetail(key, id) {
    window.location.hash = `history/${key}/${id}`;
    window.dispatchEvent(new window.Event('hashchange'));
  }
  // Three macrotasks covers fetch -> safeJson -> paint for the detail load.
  const settle = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

  return { window, calls, wsBox, selectProject, showRuns, showDetail, settle };
}

function runsListResponse(pipelines, live = []) {
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ pipelines, live }) });
}
const runsList = (pipelines, live = []) => Promise.resolve({ ok: true, status: 200, json: async () => ({ pipelines, live }) });

const KEY = 'proj-0000abcd';
// MOST-SPECIFIC FIRST: the keyed detail URL /api/history/<key>/<id> has both
// /api/history and /api/history/pr as prefixes, so every arm matches with endsWith.
const armsFor = (rows, detailById) => (url) => {
  if (url.endsWith('/api/history/pr')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
  for (const [id, payload] of Object.entries(detailById || {})) {
    if (url.endsWith(`/api/history/${KEY}/${id}`)) {
      return Promise.resolve({ ok: true, status: 200, json: async () => payload });
    }
  }
  if (url.endsWith('/api/history')) return runsList(rows);
  return null;
};
const row = (over) => ({ projectKey: KEY, projectName: 'Proj', projectDir: '/x/proj', ...over });

// ---------------------------------------------------------------------------
// Row anatomy (a compact Runs row: status icon + title + "<word> · <time>" subline)
// ---------------------------------------------------------------------------

const histRows = (doc) => doc.querySelectorAll('#runs-list .runs-row[data-kind="hist"]');
const word = (r) => r.querySelector('.runs-row-sub').textContent.split(' · ')[0];

test('the Runs list renders one row per finished run (no <li>): status icon + word + title', async () => {
  const ctx = await boot({
    fetchHandler: armsFor([
      row({ id: 'p-done', title: 'Done run', status: 'done', startedAt: '2026-01-01T00:00:00Z' }),
      row({ id: 'p-stop', title: 'Stopped run', status: 'stopped', startedAt: '2026-01-02T00:00:00Z' }),
    ]),
  });
  ctx.showRuns();
  await new Promise((r) => setTimeout(r, 0));

  const doc = ctx.window.document;
  const rows = histRows(doc);
  assert.equal(rows.length, 2, 'two finished rows rendered');
  assert.equal(doc.querySelectorAll('#runs-list li').length, 0, 'no <li> emitted');

  // No status .badge pill: the icon carries the family, the subline's word the label.
  assert.equal(doc.querySelectorAll('#runs-list .badge').length, 0, 'no status badge pill on a row');
  assert.ok(rows[0].querySelector('.runs-ic').classList.contains('runs-ic-done'), 'done -> green check family');
  // The word is the glance headline (D12): a done run with no PR and no review counts is "Finished".
  assert.equal(word(rows[0]), 'Finished');
  assert.ok(rows[1].querySelector('.runs-ic').classList.contains('runs-ic-stop'), 'stopped -> red square family');
  assert.equal(word(rows[1]), 'Stopped');
  // Exactly one glyph per row, the family's own.
  const glyphs = [...rows[0].querySelectorAll('.runs-ic svg')];
  assert.equal(glyphs.length, 1);
  assert.ok(glyphs[0].classList.contains('runs-glyph-done'));

  // Titles surface in .runs-row-title.
  assert.equal(rows[0].querySelector('.runs-row-title').textContent, 'Done run');
  assert.equal(rows[1].querySelector('.runs-row-title').textContent, 'Stopped run');
});

test('interrupted lands in the amber paused family with the word "Interrupted"', async () => {
  const ctx = await boot({
    fetchHandler: armsFor([row({ id: 'pi', title: 'Stuck', status: 'interrupted', startedAt: '2026-06-02T00:00:00Z' })]),
  });
  ctx.showRuns();
  await new Promise((r) => setTimeout(r, 0));
  const doc = ctx.window.document;
  const r = doc.querySelector('#runs-list .runs-row[data-kind="hist"]');
  // The icon column answers "can this be resumed?", so interrupted is amber, not red.
  assert.ok(r.querySelector('.runs-ic').classList.contains('runs-ic-paused'));
  assert.equal(word(r), 'Interrupted');
  // The glyph is decorative: the word is in the row link's own text, which names it.
  assert.equal(r.querySelector('.runs-ic').getAttribute('aria-hidden'), 'true');
  assert.match(r.textContent, /Interrupted/);
  assert.equal(doc.querySelector('#runs-list .runs-needs'), null, 'an interrupted run is not Needs you (D5)');
});

// ---------------------------------------------------------------------------
// Navigation (the row is a link to #history/<projectKey>/<id>)
// ---------------------------------------------------------------------------


test('clicking the title opens the run page like the rest of the row (no viewer modal)', async () => {
  const ctx = await boot({
    fetchHandler: (url) => {
      if (url.endsWith('/api/history/pr')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
      if (url.endsWith(`/api/history/${KEY}/p-done`)) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ state: { phase: 'done', status: 'done' }, auditMarkdown: '# saved audit' }) });
      }
      if (url.endsWith('/api/history')) return runsList([row({ id: 'p-done', title: 'Done run', status: 'done', startedAt: '2026-01-01T00:00:00Z' })]);
      return null;
    },
  });
  ctx.showRuns();
  await new Promise((r) => setTimeout(r, 0));

  const doc = ctx.window.document;
  const r = doc.querySelector('#runs-list .runs-row[data-kind="hist"]');
  assert.equal(r.getAttribute('href'), `#history/${KEY}/p-done`, 'the row is a link to the saved run');
  assert.equal(doc.getElementById('hist-shell').classList.contains('detail-open'), false, 'nothing open before the click');
  r.querySelector('.runs-row-title').dispatchEvent(new ctx.window.Event('click', { bubbles: true, cancelable: true }));
  await ctx.settle();

  assert.equal(ctx.window.location.hash.replace(/^#/, ''), `history/${KEY}/p-done`, 'the title is part of the row link');
  assert.ok(doc.getElementById('hist-shell').classList.contains('detail-open'), 'the saved run opened in the pane');
  assert.equal(doc.querySelector('#viewer-card').classList.contains('hidden'), true, 'no viewer modal');
});


test('empty history renders a .runs-note (no <li>)', async () => {
  const ctx = await boot({
    fetchHandler: (url) => {
      if (url.includes('/api/history')) return runsListResponse([], []);
      return null;
    },
  });
  ctx.showRuns();
  await new Promise((r) => setTimeout(r, 0));

  const doc = ctx.window.document;
  const empty = doc.querySelector('#runs-list .runs-note');
  assert.ok(empty, '.runs-note present');
  assert.match(empty.textContent, /No runs yet/);
  assert.equal(empty.classList.contains('runs-note-err'), false, 'an empty list is not an error');
  assert.equal(histRows(doc).length, 0);
  assert.equal(doc.querySelectorAll('#runs-list li').length, 0, 'no <li> in empty state');
});

test('history load error renders a .runs-note-err (no <li>)', async () => {
  const ctx = await boot({
    fetchHandler: (url) => {
      if (url.includes('/api/history')) {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
      }
      return null;
    },
  });
  ctx.showRuns();
  await new Promise((r) => setTimeout(r, 0));

  const doc = ctx.window.document;
  const err = doc.querySelector('#runs-list .runs-note-err');
  assert.ok(err, '.runs-note-err present on error');
  assert.match(err.textContent, /Could not load finished runs: boom/);
  assert.equal(doc.querySelectorAll('#runs-list li').length, 0, 'no <li> in error state');
});

// ---------------------------------------------------------------------------
// The stepper the detail screen paints from the saved manifest
// ---------------------------------------------------------------------------



test('a pipelines-changed reload marks the list aria-busy, cleared by the final history-pr batch', async () => {
  // The Refresh button is gone (D14): the app force-reloads History on a
  // {type:'pipelines-changed'} frame while the Runs page is shown (app.js:1076).
  const ctx = await boot({
    fetchHandler: (url) => (url.includes('/api/history') && !url.endsWith('/api/history/pr')
      ? runsListResponse([{ id: 'p1', title: 'Feat', status: 'done', startedAt: '2026-01-01T00:00:00Z', projectKey: 'k1', projectName: 'K1' }])
      : null),
  });
  ctx.showRuns();
  await new Promise((r) => setTimeout(r, 0));

  const doc = ctx.window.document;
  const list = doc.querySelector('#runs-list');
  const gets = () => ctx.calls.filter((c) => c.url.endsWith('/api/history') && !c.opts.method).length;
  const lastToken = () => JSON.parse(ctx.calls.filter((c) => c.url.endsWith('/api/history/pr') && c.opts.body).at(-1).opts.body).token;
  // Settle the entry load first, so the busy state below is the reload's own.
  ctx.wsBox.ws.dispatch('message', { data: JSON.stringify({ type: 'history-pr', token: lastToken(), done: true, items: [] }) });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(list.getAttribute('aria-busy'), 'false', 'the entry load settled');
  const before = gets();
  const firstToken = lastToken();

  ctx.wsBox.ws.dispatch('message', { data: JSON.stringify({ type: 'pipelines-changed' }) }); // force reload
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(gets(), before + 1, 'the frame re-fetched /api/history');
  assert.notEqual(lastToken(), firstToken, 'the reload asked for Phase 2 under a new token');
  assert.equal(list.getAttribute('aria-busy'), 'true', 'list marked aria-busy while loading');

  // The final Phase-2 batch (done:true) for the current token clears the affordance.
  ctx.wsBox.ws.dispatch('message', { data: JSON.stringify({ type: 'history-pr', token: lastToken(), done: true, items: [] }) });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(list.getAttribute('aria-busy'), 'false', 'aria-busy cleared');
});



test('History never renders review sections, even when the payload carries them', async () => {
  // The server still sends `reviews`; History is a record of the run, not a
  // review surface, so nothing paints them anywhere on the detail screen.
  const detailPayload = {
    state: { phase: 'done', status: 'done', cycle: 2, steps: [] },
    auditMarkdown: '',
    clarify: {
      questions: [{ id: 'q1', question: 'Postgres or SQLite?', options: ['pg', 'sqlite', ''], allowFreeText: true }],
      answers: [{ id: 'q1', question: 'Postgres or SQLite?', choice: 'sqlite' }],
    },
    reviews: [
      { kind: 'impl', cycle: 1, issues: [{ severity: 'major', title: 'Missing null-check', detail: 'guard input', location: 'src/x.mjs:10' }], summary: 'one issue' },
      { kind: 'impl', cycle: 2, issues: [], summary: 'resolved' },
    ],
    results: null, overview: null, stepQuestions: [], artifacts: [],
  };
  const ctx = await boot({
    fetchHandler: armsFor([row({ id: 'p-ex', title: 'Run', status: 'done', startedAt: '2026-01-01T00:00:00Z' })],
      { 'p-ex': detailPayload }),
  });
  ctx.showRuns();
  await new Promise((r) => setTimeout(r, 0));
  ctx.showDetail(KEY, 'p-ex');
  await ctx.settle();

  const hd = ctx.window.document.querySelector('#hist-detail .hd');
  assert.equal(hd.querySelector('.hist-reviews'), null, 'reviews section is not rendered');
  assert.equal(hd.querySelector('.hist-cycle-tag'), null, 'no review cycle tags rendered');
  assert.doesNotMatch(hd.textContent, /Missing null-check/, 'no review issue leaks onto the screen');
  // The clarify answer, by contrast, IS reachable — through its own tab.
  const clarifyTab = [...hd.querySelectorAll('.hd-tab')].find((t) => t.dataset.sec === 'clarify');
  assert.ok(clarifyTab, 'a Clarify tab is offered when the run has Q&A');
});
