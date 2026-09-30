// test/ui-night-mode.test.mjs — night mode in the UI (Step 14): the run-view switch, the
// night decisions list, the start-form opt-in and the Settings card.
// Boot preamble copied from test/ui-newpipeline-auto.test.mjs:19-91 (house convention:
// duplicated per suite), with arms for the night routes and a POST recorder.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { renderNightForm, readNightForm } from '../ui/public/night-mode-form.mjs';

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));

const wins = [];
afterEach(() => { for (const w of wins.splice(0)) { try { w.close(); } catch { /* already closed */ } } });

async function boot({ settings = {}, decisions = [] } = {}) {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' });
  const { window } = dom;
  wins.push(window);
  window.Element.prototype.scrollIntoView = function () {};

  let lastWs = null;
  window.WebSocket = class {
    constructor() { this.readyState = 1; this._l = {}; lastWs = this; }
    send() {}
    close() {}
    addEventListener(t, fn) { (this._l[t] ||= []).push(fn); }
  };

  const posts = [];
  window.fetch = (u, opts) => {
    const url2 = String(u);
    const method = ((opts && opts.method) || 'GET').toUpperCase();
    const path = url2.split('?')[0];
    const ok = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });
    if (method === 'POST' || method === 'PATCH') {
      posts.push({ path, body: JSON.parse(opts.body) });
      if (path.endsWith('/api/run')) return ok({ runId: 'run-new' });
      if (path.endsWith('/api/settings')) return ok({});
      return ok({ ok: true });
    }
    if (path.endsWith('/api/night-decisions')) return ok({ decisions });
    if (path.endsWith('/api/settings')) return ok({ nightMode: {}, nightModeToggle: 'auto', nightModeEffective: { strategy: 'mixed', criteria: {} }, ...settings });
    if (path.endsWith('/api/config')) return ok({ config: { steps: {}, customModels: [], activeWorkflowId: 'wf_default' }, models: [], efforts: [] });
    if (path.endsWith('/api/workflows')) return ok({ workflows: [{ id: 'wf_default', name: 'Default' }] });
    if (path.endsWith('/api/guardrails')) return ok({ guardrails: [{ id: 'permissive', name: 'Permissive' }] });
    if (path.endsWith('/api/branches')) return ok({ branches: ['main'], current: 'main' });
    if (url2.includes('/api/projects')) return ok({ projects: [{ name: 'proj', path: '/repos/proj', exists: true }] });
    return ok({ pipelines: 0, projects: 0, workspaces: 0 });
  };

  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch { /* read-only */ }
  }
  globalThis.window = window;
  globalThis.document = window.document;
  window.localStorage.clear();
  window.localStorage.setItem('worca-cc.lastProject', 'proj');

  await import(pathToFileURL(appPath).href + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0));
  lastWs._l.open?.forEach((fn) => fn());
  await settle();
  const dispatch = (msg) => lastWs._l.message?.forEach((fn) => fn({ data: JSON.stringify(msg) }));
  return { window, posts, dispatch };
}
async function settle(n = 4) { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); }

const RUN = { runId: 'run-n1', title: 'Night run', projectDir: '/repos/proj', status: 'running', startedAt: '2026-01-01T00:00:00Z', kind: 'run', pipelineId: 'p-1', night: { optIn: true, override: 'auto', decisions: 0, flagged: 0 } };

async function openDetail(ctx) {
  ctx.dispatch({ type: 'hello', runs: [RUN] });
  ctx.window.location.hash = `running/${RUN.runId}`;
  ctx.window.dispatchEvent(new ctx.window.Event('hashchange'));
  await settle();
  return ctx.window.document.querySelector('#run-detail');
}

test('run view: the switch paints r.night.override and posts /api/run/night on change', async () => {
  const ctx = await boot();
  const screen = await openDetail(ctx);
  const sel = screen.querySelector('.rd-night');
  assert.equal(sel.closest('.rd-night-wrap').hidden, false, 'shown on a live run');
  assert.equal(sel.value, 'auto');
  sel.value = 'on';
  sel.dispatchEvent(new ctx.window.Event('change', { bubbles: true }));
  await settle();
  assert.deepEqual(ctx.posts.find((p) => p.path.endsWith('/api/run/night')).body, { runId: RUN.runId, mode: 'on' });
  ctx.dispatch({ type: 'state', runId: RUN.runId, seq: 5, status: 'paused', night: { optIn: true, override: 'off', decisions: 1, flagged: 1 } });
  await settle();
  assert.equal(screen.querySelector('.rd-night-wrap').hidden, false, 'a paused run keeps the switch (it lands in the resume point)');
  assert.equal(sel.value, 'off');
  ctx.dispatch({ type: 'state', runId: RUN.runId, seq: 6, status: 'done', night: { optIn: true, override: 'off', decisions: 1, flagged: 1 } });
  await settle();
  assert.equal(screen.querySelector('.rd-night-wrap').hidden, true, 'hidden on a finished run');
});

test('a hidden night switch really is hidden (its display rule must not beat [hidden])', () => {
  const css = readFileSync(new URL('../ui/public/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.rd-night-wrap\[hidden\]\s*\{\s*display:\s*none/);
});

test('run view: stored decisions load on open; a night-decision frame appends; flagged rows are marked', async () => {
  const ctx = await boot({ decisions: [{ questionId: 'clarify-a-1', kind: 'clarify', choice: 'Redis', strategy: 'weights', confidence: 80, flagged: false, rationale: 'r1' }] });
  const screen = await openDetail(ctx);
  await settle();
  const sec = screen.querySelector('.rd-night-sec');
  assert.equal(sec.hidden, false);
  ctx.dispatch({ type: 'night-decision', runId: RUN.runId, seq: 9, id: 'gate-w-2', kind: 'gate',
    record: { questionId: 'gate-w-2', kind: 'gate', choice: 'continue', strategy: 'rule', confidence: null, flagged: true, rationale: 'critical remain' } });
  await settle();
  const rows = [...screen.querySelectorAll('.rd-night-decisions li')];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].classList.contains('flagged'), false);
  assert.ok(rows[1].classList.contains('flagged'));
  assert.match(rows[1].querySelector('.rd-nd-head').textContent, /gate · continue · rule · flagged/);
  assert.equal(screen.querySelector('.rd-night-count').textContent, '(2, 1 flagged)');
});

test('start form: nightMode is sent only when the checkbox is ticked', async () => {
  const ctx = await boot();
  const doc = ctx.window.document;
  doc.getElementById('prompt').value = 'demo task';
  doc.getElementById('run-form').dispatchEvent(new ctx.window.Event('submit', { cancelable: true }));
  await settle();
  const first = ctx.posts.filter((p) => p.path.endsWith('/api/run')).at(-1);
  assert.ok(first, 'the run was posted');
  assert.equal('nightMode' in first.body, false);
  doc.getElementById('nightMode').checked = true;
  doc.getElementById('run-form').dispatchEvent(new ctx.window.Event('submit', { cancelable: true }));
  await settle();
  assert.equal(ctx.posts.filter((p) => p.path.endsWith('/api/run')).at(-1).body.nightMode, true);
});

test('settings card: paints the stored layer and posts {nightMode, nightModeToggle}', async () => {
  const ctx = await boot({ settings: { nightMode: { enabled: true, window: '22:00-07:00', strategy: 'weights' }, nightModeToggle: 'on' } });
  ctx.window.location.hash = 'settings';
  ctx.window.dispatchEvent(new ctx.window.Event('hashchange'));
  await settle(8);
  const doc = ctx.window.document;
  const host = doc.getElementById('night-mode-host');
  assert.equal(host.querySelector('.night-enabled').value, 'on');
  assert.equal(host.querySelector('.night-window-start').value, '22:00');
  assert.equal(doc.getElementById('nightModeToggle').value, 'on');
  host.querySelector('.night-strategy').value = 'analysis';
  doc.getElementById('nightModeSave').dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
  await settle();
  const post = ctx.posts.filter((p) => p.path.endsWith('/api/settings')).at(-1);
  assert.equal(post.body.nightModeToggle, 'on');
  assert.equal(post.body.nightMode.strategy, 'analysis');
  assert.equal(post.body.nightMode.enabled, true);
  assert.equal(post.body.nightMode.window, '22:00-07:00');
});

test('night form: project level unsets empty fields; grace off is an explicit null; no spend cap per project', () => {
  const dom = new JSDOM('<!doctype html><body><div id="f"></div></body>');
  const root = dom.window.document.getElementById('f');
  renderNightForm(root, { level: 'project', values: { strategy: 'weights', criteria: { cost: 4 } }, effective: { graceMinutes: 30, criteria: { cost: 4 } }, sources: { graceMinutes: 'default' } });
  assert.equal(root.querySelector('.night-spend-cap'), null);
  let patch = readNightForm(root, { level: 'project' });
  assert.equal(patch.strategy, 'weights');
  assert.deepEqual(patch.criteria, { cost: 4 });
  for (const f of ['enabled', 'window', 'timeZone', 'graceMinutes', 'neverDecide']) assert.ok(patch.__unset.includes(f), f);
  root.querySelector('.night-grace-off').checked = true;
  root.querySelector('.night-never[value="gate"]').checked = true;
  patch = readNightForm(root, { level: 'project' });
  assert.equal(patch.graceMinutes, null);
  assert.deepEqual(patch.neverDecide, ['gate']);
});

test('night form: a user-level save of empty cap/window inherits the team cap and window; "No cap"/"No window" is an explicit null', async () => {
  const { resolveNightConfig } = await import('../src/core/night/config.mjs');
  const dom = new JSDOM('<!doctype html><body><div id="f"></div></body>');
  const root = dom.window.document.getElementById('f');
  renderNightForm(root, { level: 'user', values: { enabled: true, strategy: 'analysis' } });
  let patch = readNightForm(root, { level: 'user' });
  assert.ok(patch.__unset.includes('spendCapUsd') && patch.__unset.includes('window'), 'empty = inherit');
  assert.equal('spendCapUsd' in patch, false);
  assert.equal('window' in patch, false);
  const { __unset, ...user } = patch;
  const team = { spendCapUsd: 5, window: '22:00-06:00' };
  const { config } = resolveNightConfig({ user, team });
  assert.equal(config.spendCapUsd, 5, 'the team spend cap stays in force');
  assert.equal(config.window, '22:00-06:00');
  root.querySelector('.night-spend-cap-off').checked = true;
  root.querySelector('.night-window-off').checked = true;
  patch = readNightForm(root, { level: 'user' });
  assert.equal(patch.spendCapUsd, null);
  assert.equal(patch.window, null);
  renderNightForm(root, { level: 'user', values: { spendCapUsd: null, window: null } });
  assert.equal(root.querySelector('.night-spend-cap-off').checked, true, 'a stored null paints as the checkbox');
  assert.equal(root.querySelector('.night-window-off').checked, true);
  assert.equal(root.querySelector('.night-spend-cap').disabled, true);
});
