// test/ui-question-recommended.test.mjs — the clarify panel shows the agent's confidence per
// option and preselects its recommendation (night mode, Step 14). boot() is a verbatim copy of
// test/ui-question-panel.test.mjs:34-91 (house convention: suites do not import each other).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));

async function boot({ fetchHandler } = {}) {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' });
  const { window } = dom;

  const wsBox = { ws: null };
  window.WebSocket = class {
    constructor() {
      this.readyState = 1; // OPEN — app.js gates backfill subscribes on wsReady
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
  await new Promise((r) => setTimeout(r, 0));

  function dispatch(msg) {
    wsBox.ws.dispatch('message', { data: JSON.stringify(msg) });
  }
  function showRunning() {
    window.location.hash = 'running';
    window.dispatchEvent(new window.Event('hashchange'));
  }

  return { window, dispatch, showRunning, calls, wsBox };
}

const RUN_ID = 'run-rec-1';

test('confidence bars per option, a Recommended badge, and the recommendation is preselected', async () => {
  const ctx = await boot({ fetchHandler: (url) => (url.includes('/api/answer') ? Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) }) : null) });
  ctx.wsBox.ws.dispatch('open', {});
  ctx.dispatch({ type: 'hello', runs: [{ runId: RUN_ID, title: 'Demo', projectDir: '/tmp/p', status: 'running', startedAt: '2026-01-01T00:00:00Z', kind: 'run' }] });
  ctx.showRunning();
  ctx.dispatch({ type: 'question', runId: RUN_ID, id: 'clarify-1', kind: 'clarify',
    questions: [{ id: 'q1', question: 'Pick?', options: ['A', 'B'], confidence: [70, 30], recommended: 'B', allowFreeText: true }] });
  const card = ctx.window.document.querySelector(`.run-card[data-run-id="${RUN_ID}"]`);
  const opts = [...card.querySelectorAll('.qpanel .qopt')];
  assert.equal(opts.length, 2);
  assert.deepEqual(opts.map((b) => b.querySelector('.qconf-fill').style.width), ['70%', '30%'], 'bars keyed by option order');
  assert.equal(opts[0].querySelector('.qrec'), null);
  assert.equal(opts[1].querySelector('.qrec').textContent, 'Recommended');
  assert.ok(opts[1].classList.contains('sel'));
  assert.equal(opts[1].getAttribute('aria-pressed'), 'true');
  assert.equal(opts[0].getAttribute('aria-pressed'), 'false');
  assert.match(card.querySelector('.qanswered').textContent, /^1 of 1 answered/);
  card.querySelector('.qpanel .btn-go').dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  const post = ctx.calls.find((c) => c.url.includes('/api/answer'));
  assert.ok(post, 'the answer was posted without a click on an option');
  assert.equal(JSON.parse(post.opts.body).payload.answers[0].choice, 'B');
});

test('a question without confidence renders plain options, nothing preselected', async () => {
  const ctx = await boot();
  ctx.wsBox.ws.dispatch('open', {});
  ctx.dispatch({ type: 'hello', runs: [{ runId: RUN_ID, title: 'Demo', projectDir: '/tmp/p', status: 'running', startedAt: '2026-01-01T00:00:00Z', kind: 'run' }] });
  ctx.showRunning();
  ctx.dispatch({ type: 'question', runId: RUN_ID, id: 'clarify-2', kind: 'clarify',
    questions: [{ id: 'q1', question: 'Pick?', options: ['A', 'B'], allowFreeText: true }] });
  const card = ctx.window.document.querySelector(`.run-card[data-run-id="${RUN_ID}"]`);
  assert.equal(card.querySelectorAll('.qconf, .qrec, .qopt.sel').length, 0);
  assert.equal([...card.querySelectorAll('.qopt .qopt-txt')].map((s) => s.textContent).join(','), 'A. A,B. B');
});

test('stylesheet carries the confidence bar and badge rules', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../ui/public/style.css'), 'utf8');
  assert.ok(/\.qopt \.qrec\s*\{/.test(css), '.qopt .qrec rule');
  assert.ok(/\.qopt \.qconf-fill\s*\{/.test(css), '.qopt .qconf-fill rule');
});
