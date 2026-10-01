// test/ui-night-mode.test.mjs — night mode in the UI (Step 14): the run-view switch, the
// night decisions list, the start-form opt-in and the Settings card.
// Boot preamble copied from test/ui-newpipeline-auto.test.mjs:19-91 (house convention:
// duplicated per suite), with arms for the night routes and a POST recorder.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { renderNightForm, readNightForm, paintAwaySummary, updateAwaySummary } from '../ui/public/night-mode-form.mjs';
import { NIGHT_DEFAULTS, resolveNightConfig } from '../src/core/night/config.mjs';
import { RUN_SWITCH_OPTIONS, RUN_SWITCH_TIP } from '../src/shared/away-mode/labels.mjs';
import { describeNewRun } from '../src/shared/away-mode/describe.mjs';

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));

const wins = [];
const realNow = Date.now;
afterEach(() => {
  Date.now = realNow;                        // app.js runs in Node's realm: its Date.now is this one
  for (const w of wins.splice(0)) { try { w.close(); } catch { /* already closed */ } }
});

async function boot({ settings = {}, decisions = [], away } = {}) {
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
  const awayCalls = [];
  // GET /api/away-mode: by default the stored user layer; `away` = a body, null (a 500) or (url) => body|null.
  const defaultAway = () => ({ config: resolveNightConfig({ user: settings.nightMode }).config, sources: {}, inherited: resolveNightConfig({}),
    toggle: settings.nightModeToggle || 'auto', user: settings.nightMode || {}, project: null });
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
    if (path.endsWith('/api/away-mode')) {
      awayCalls.push(url2);
      const b = typeof away === 'function' ? away(url2) : away === undefined ? defaultAway() : away;
      return b == null ? Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }) : ok(b);
    }
    if (path.endsWith('/api/night-decisions')) return ok({ decisions });
    if (path.endsWith('/api/settings')) return ok({ nightMode: {}, nightModeToggle: 'auto', nightModeEffective: { strategy: 'mixed', criteria: {} }, ...settings });
    if (path.endsWith('/api/config')) return ok({ config: { steps: {}, customModels: [], activeWorkflowId: 'wf_default' }, models: [], efforts: [] });
    if (path.endsWith('/api/workflows')) return ok({ workflows: [{ id: 'wf_default', name: 'Default' }] });
    if (path.endsWith('/api/guardrails')) return ok({ guardrails: [{ id: 'permissive', name: 'Permissive' }] });
    if (path.endsWith('/api/branches')) return ok({ branches: ['main'], current: 'main' });
    if (url2.includes('/api/projects')) return ok({ projects: [{ name: 'proj', path: '/repos/proj', exists: true, key: 'proj-1' }] });
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
  return { window, posts, dispatch, awayCalls };
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
  assert.equal(rows[1].querySelector('.rd-nd-head').textContent, 'Fix again or continue, in a review loop');
  assert.equal(rows[1].querySelector('.rd-nd-why').textContent, 'Answered for you, please check: "continue" — critical remain.');
  assert.equal(rows[0].querySelector('.rd-nd-why').textContent, 'Answered for you: "Redis" — r1.');
  assert.equal(screen.querySelector('.rd-night-count').textContent, '(2 answers, 1 to check)');
  assert.equal(screen.querySelector('.rd-night-sec h3').firstChild.textContent.trim(), 'Answers while you were away');
  ctx.dispatch({ type: 'night-decision', runId: RUN.runId, seq: 10, id: 'clarify-g-3', kind: 'clarify',
    record: { questionId: 'clarify-g-3', kind: 'clarify', choice: null, strategy: 'guardrail', guardrail: 'maxDecisions', confidence: null, flagged: true, rationale: 'Paused: worca answered 1 times on this run, the limit you set.' } });
  await settle();
  const g = [...screen.querySelectorAll('.rd-night-decisions li')][2];
  assert.equal(g.querySelector('.rd-nd-why').textContent, 'Paused: worca answered 1 times on this run, the limit you set.');
  assert.equal(screen.querySelector('.rd-night-count').textContent, '(2 answers, 1 to check)');
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

async function openSettings(ctx) {
  ctx.window.location.hash = 'settings';
  ctx.window.dispatchEvent(new ctx.window.Event('hashchange'));
  await settle(8);
  return ctx.window.document;
}
const click = (ctx, node) => node.dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
const statusButton = (doc, label) => [...doc.querySelectorAll('#awayStatus button')].find((b) => b.textContent === label);

test('settings card: paints the stored layer, Save posts {nightMode}, the status buttons post the toggle', async () => {
  const ctx = await boot({ settings: { nightMode: { enabled: true, window: '22:00-07:00', strategy: 'weights' }, nightModeToggle: 'on' } });
  const doc = await openSettings(ctx);
  const host = doc.getElementById('night-mode-host');
  const all = [...host.querySelectorAll('.away-which input')].find((i) => i.closest('label').textContent.trim() === 'All runs');
  assert.equal(all.checked, true);
  assert.equal(host.querySelector('.night-window-start').value, '22:00');
  assert.deepEqual([...doc.querySelectorAll('#awayStatus button')].map((b) => b.textContent), ["I'm back"]);
  assert.equal(host.querySelector('.away-summary').nextElementSibling, doc.getElementById('awayStatus'), 'the status buttons sit right below the summary');
  host.querySelector('.night-strategy').value = 'analysis';
  click(ctx, doc.getElementById('nightModeSave'));
  await settle();
  const post = ctx.posts.filter((p) => p.path.endsWith('/api/settings')).at(-1);
  assert.equal('nightModeToggle' in post.body, false, 'Save never changes the status');
  assert.equal(post.body.nightMode.strategy, 'analysis');
  assert.equal(post.body.nightMode.enabled, true);
  assert.equal(post.body.nightMode.window, '22:00-07:00');
  click(ctx, statusButton(doc, "I'm back"));
  await settle();
  assert.deepEqual(ctx.posts.filter((p) => p.path.endsWith('/api/settings')).at(-1).body, { nightModeToggle: 'auto' });
});

test('settings card: "I\'m away now" and "Pause away mode" post the toggle alone', async () => {
  // A second boot: the stub answers POST /api/settings with {}, so the strip is not repainted after a click.
  const ctx = await boot({ settings: { nightMode: { window: '22:00-07:00' }, nightModeToggle: 'auto' } });
  const doc = await openSettings(ctx);
  assert.deepEqual([...doc.querySelectorAll('#awayStatus button')].map((b) => b.textContent), ["I'm away now", 'Pause away mode']);
  click(ctx, statusButton(doc, "I'm away now"));
  await settle();
  assert.deepEqual(ctx.posts.filter((p) => p.path.endsWith('/api/settings')).at(-1).body, { nightModeToggle: 'on' });
  click(ctx, statusButton(doc, 'Pause away mode'));
  await settle();
  assert.deepEqual(ctx.posts.filter((p) => p.path.endsWith('/api/settings')).at(-1).body, { nightModeToggle: 'off' });
});

// The sidebar's "I'm away" switch (wording §3.8): on = "I'm away now", off = follow my away hours.
const sideAway = (doc) => doc.querySelector('.side-foot #side-away [role="switch"]');
const settingsPosts = (ctx) => ctx.posts.filter((p) => p.path.endsWith('/api/settings'));

test('sidebar switch: off follows the hours, says what applies now, and a click posts "I\'m away now"', async () => {
  Date.now = () => Date.parse('2026-09-28T15:00:00Z');
  const ctx = await boot({ settings: { nightMode: { window: '22:00-07:00', timeZone: 'UTC' } } });
  const sw = sideAway(ctx.window.document);
  assert.ok(sw, 'the switch sits in the sidebar foot');
  assert.equal(sw.getAttribute('aria-checked'), 'false');
  assert.match(sw.textContent, /I'm away/);
  assert.equal(sw.querySelector('.side-away-word').textContent, 'Here');
  assert.match(sw.title, /^Right now it is 15:00( UTC)?\. You count as here\. Next away hours start at 22:00\. Turn on to have worca answer on every run now\.$/);
  click(ctx, sw);
  await settle();
  assert.deepEqual(settingsPosts(ctx).at(-1).body, { nightModeToggle: 'on' });
});

test('sidebar switch: inside away hours the switch stays off; the word says away', async () => {
  Date.now = () => Date.parse('2026-09-28T23:00:00Z');
  const ctx = await boot({ settings: { nightMode: { window: '22:00-07:00', timeZone: 'UTC' } } });
  const sw = sideAway(ctx.window.document);
  assert.equal(sw.getAttribute('aria-checked'), 'false');
  assert.equal(sw.querySelector('.switch').classList.contains('on'), false);
  assert.equal(sw.querySelector('.side-away-word').textContent, 'Away (your hours)');
  assert.equal(sw.dataset.status, 'away-hours');
});

test('sidebar switch: on reads "Away" and a click goes back to the away hours', async () => {
  const ctx = await boot({ settings: { nightMode: { window: '22:00-07:00' }, nightModeToggle: 'on' } });
  const sw = sideAway(ctx.window.document);
  assert.equal(sw.getAttribute('aria-checked'), 'true');
  assert.equal(sw.querySelector('.switch').classList.contains('on'), true);
  assert.equal(sw.querySelector('.side-away-word').textContent, 'Away');
  click(ctx, sw);
  await settle();
  assert.deepEqual(settingsPosts(ctx).at(-1).body, { nightModeToggle: 'auto' });
});

test('sidebar switch: paused (or unread) is disabled and opens Settings › Runs instead of posting', async () => {
  for (const o of [{ settings: { nightModeToggle: 'off' } }, { away: null }]) {
    const ctx = await boot(o);
    const sw = sideAway(ctx.window.document);
    assert.equal(sw.getAttribute('aria-disabled'), 'true');
    assert.equal(sw.getAttribute('aria-checked'), 'false');
    click(ctx, sw);
    await settle();
    assert.equal(settingsPosts(ctx).length, 0, 'nothing is posted');
    assert.equal(ctx.window.location.hash, '#settings/runs');
  }
});

test('sidebar switch: settings-changed (a Settings button, another tab, Ask Worca) repaints it', async () => {
  let toggle = 'auto';
  const body = () => ({ config: resolveNightConfig({ user: { window: '22:00-07:00' } }).config, sources: {}, inherited: resolveNightConfig({}), toggle, user: {}, project: null });
  const ctx = await boot({ away: body });
  assert.equal(sideAway(ctx.window.document).getAttribute('aria-checked'), 'false');
  toggle = 'on';
  ctx.dispatch({ type: 'settings-changed' });
  await settle(8);
  assert.equal(sideAway(ctx.window.document).getAttribute('aria-checked'), 'true');
});

test('sidebar switch: an open project tab repaints its summary when the status changes', async () => {
  let toggle = 'auto';
  const body = () => ({ config: resolveNightConfig({ user: { window: '22:00-07:00' } }).config, sources: {}, inherited: resolveNightConfig({ user: { window: '22:00-07:00' } }), toggle, user: {}, project: {} });
  const ctx = await boot({ away: body });
  ctx.window.location.hash = 'projects/proj-1/away';
  await settle(12);
  const summary = () => ctx.window.document.querySelector('.pd-night-card .away-summary').textContent;
  assert.doesNotMatch(summary(), /I'm away now/);
  toggle = 'on';
  ctx.dispatch({ type: 'settings-changed' });
  await settle(8);
  assert.match(summary(), /^For proj: Right now you count as away because you said "I'm away now"/);
  assert.equal(sideAway(ctx.window.document).getAttribute('aria-label'), "I'm away");
});

test('settings card: when GET /api/away-mode fails, the stored fields still render (spec §7)', async () => {
  // No `enabled` key: the default state of a real user.
  const ctx = await boot({ away: null, settings: { nightMode: { window: '22:00-07:00' } } });
  const doc = await openSettings(ctx);
  const host = doc.getElementById('night-mode-host');
  assert.ok(host.querySelector('.away-which input'), 'the fields render');
  const marked = [...host.querySelectorAll('.away-which input')].find((i) => i.closest('label').textContent.trim() === 'Only runs I marked');
  assert.equal(marked.checked, true);
  assert.equal(host.querySelector('.night-window-start').value, '22:00');
  assert.equal(host.querySelector('.away-summary').textContent.trim(), 'Away mode settings could not be read.');
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

const formRoot = () => new JSDOM('<div id="r"></div>').window.document.getElementById('r');
const fire = (node, type) => node.dispatchEvent(new node.ownerDocument.defaultView.Event(type, { bubbles: true }));

test('the card reads top to bottom: summary, which runs, marked runs by day, collapsed advanced', () => {
  const root = formRoot();
  renderNightForm(root, { level: 'user', values: { window: '22:00-07:00' }, effective: { ...NIGHT_DEFAULTS, window: '22:00-07:00', timeZone: 'UTC' }, sources: {}, toggle: 'auto', now: Date.parse('2026-09-28T15:00:00Z') });
  assert.match(root.querySelector('.away-summary').textContent, /You count as here/);
  assert.deepEqual([...root.querySelectorAll('.away-which input')].map((i) => i.closest('label').textContent.trim()), ['Only runs I marked', 'All runs']);
  assert.match(root.querySelector('.away-byday').textContent, /Marked runs by day/);
  for (const t of ['How worca picks an answer', 'Limits', 'Always wait for me on…']) {
    const d = [...root.querySelectorAll('details')].find((x) => x.querySelector('summary').textContent.includes(t));
    assert.ok(d && !d.open, t);
  }
});

test('the summary updates on input; switching to All runs changes line 2', () => {
  const root = formRoot();
  renderNightForm(root, { level: 'user', values: { window: '22:00-07:00', timeZone: 'UTC' }, effective: { ...NIGHT_DEFAULTS, window: '22:00-07:00', timeZone: 'UTC' }, sources: {}, toggle: 'auto', now: Date.parse('2026-09-28T15:00:00Z') });
  const all = [...root.querySelectorAll('.away-which input')][1];
  all.checked = true; fire(all, 'change');
  assert.match(root.querySelector('.away-summary').textContent, /on all runs/);
  assert.equal(readNightForm(root, { level: 'user' }).enabled, true);
});

test('user level: an unset "Which runs" shows the inherited choice and saves as unset', () => {
  const root = formRoot();
  renderNightForm(root, { level: 'user', values: {}, effective: { ...NIGHT_DEFAULTS }, sources: {}, toggle: 'auto', now: 0 });
  const [marked] = root.querySelectorAll('.away-which input');
  assert.equal(marked.checked, true, 'the inherited value is shown');
  assert.match(root.querySelector('.away-which').textContent, /\(default\)/);
  assert.ok(readNightForm(root, { level: 'user' }).__unset.includes('enabled'), 'untouched = inherit, as before');
});

test('half-typed hours: summary says inherited, save unsets the window', () => {
  const root = formRoot();
  renderNightForm(root, { level: 'user', values: {}, effective: { ...NIGHT_DEFAULTS }, sources: {}, toggle: 'auto', now: Date.parse('2026-09-28T15:00:00Z') });
  root.querySelector('.night-window-start').value = '22:00';
  fire(root.querySelector('.night-window-start'), 'input');
  assert.match(root.querySelector('.away-summary').textContent, /No away hours are set/);
  assert.ok(readNightForm(root, { level: 'user' }).__unset.includes('window'));
});

test('a cleared field falls back to the INHERITED value in the summary, not the stored one', () => {
  const root = formRoot();
  renderNightForm(root, { level: 'project', values: { window: '20:00-06:00' }, effective: { ...NIGHT_DEFAULTS, window: '20:00-06:00', timeZone: 'UTC' },
    inherited: { config: { ...NIGHT_DEFAULTS, window: '22:00-07:00', timeZone: 'UTC' }, sources: { window: 'user' } }, toggle: 'auto', now: Date.parse('2026-09-28T15:00:00Z'), projectName: 'P' });
  root.querySelector('.night-window-start').value = ''; fire(root.querySelector('.night-window-start'), 'input');
  assert.match(root.querySelector('.away-summary').textContent, /^For P: .*Next away hours start at 22:00/);
});

test('round-trip: empty vs set vs explicit off gives the same patch as before', () => {
  const root = formRoot();
  renderNightForm(root, { level: 'user', values: { enabled: true, window: null, graceMinutes: null, spendCapUsd: 5, neverDecide: ['gate'] }, effective: { ...NIGHT_DEFAULTS }, sources: {}, toggle: 'auto', now: 0 });
  const p = readNightForm(root, { level: 'user' });
  assert.deepEqual([p.enabled, p.window, p.graceMinutes, p.spendCapUsd, p.neverDecide], [true, null, null, 5, ['gate']]);
  assert.ok(p.__unset.includes('strategy'));
});

test('updateAwaySummary repaints the summary only (unsaved edits survive)', () => {
  const root = formRoot();
  renderNightForm(root, { level: 'user', values: {}, effective: { ...NIGHT_DEFAULTS }, sources: {}, toggle: 'auto', now: 0 });
  root.querySelector('.night-num[data-field="maxDecisions"]').value = '7';
  updateAwaySummary(root, { toggle: 'on', now: 0 });
  assert.match(root.querySelector('.away-summary').textContent, /I'm away now/);
  assert.equal(root.querySelector('.night-num[data-field="maxDecisions"]').value, '7');
});

test('paintAwaySummary renders one span per line', () => {
  const host = formRoot();
  paintAwaySummary(host, { config: { ...NIGHT_DEFAULTS, window: '22:00-07:00', timeZone: 'UTC' }, toggle: 'auto', now: Date.parse('2026-09-28T15:00:00Z') });
  assert.equal(host.querySelectorAll('.away-line').length, 3);
});

test('no inherited config (the fetch failed): every field renders, nothing throws, the summary says so', () => {
  const root = formRoot();
  for (const level of ['user', 'project']) {
    assert.doesNotThrow(() => renderNightForm(root, { level, values: {}, effective: {}, sources: {}, inherited: { config: null, sources: {} }, toggle: 'auto', now: 0 }));
    assert.ok(root.querySelector('.away-which input:checked'), level);
    assert.equal(root.querySelector('.away-summary').textContent.trim(), 'Away mode settings could not be read.');
    assert.doesNotMatch(root.textContent, /undefined|\[object Object\]/, level);
    if (level === 'user') assert.equal(root.querySelector('.away-inherited'), null, 'no source is claimed when nothing is inherited');
  }
  assert.equal(root.querySelector('.night-strategy option').textContent, 'Same as my settings', 'project level, nothing inherited: the plain label');
  assert.equal(root.querySelector('.away-which input').closest('label').textContent.trim(), 'Same as my settings', 'the radio too: never a guessed "(Only runs I marked)"');
});

test('project level: "Same as my settings (…)" names the inherited choice; no spend cap; summary names the project', () => {
  const root = formRoot();
  renderNightForm(root, { level: 'project', values: {}, effective: { ...NIGHT_DEFAULTS, enabled: true }, sources: { enabled: 'user' },
    inherited: { config: { ...NIGHT_DEFAULTS, enabled: true }, sources: { enabled: 'user' } }, toggle: 'auto', now: Date.parse('2026-09-28T15:00:00Z'), projectName: 'Shop' });
  const first = root.querySelector('.away-which input');
  assert.equal(first.value, ''); assert.equal(first.checked, true);
  assert.equal(first.closest('label').textContent.trim(), 'Same as my settings (All runs)');
  assert.equal(root.querySelector('.night-spend-cap'), null);
  assert.match(root.textContent, /The spend cap is set once for you, not per project/);
  // Wording §3.2: "Same as my settings" on every empty choice, not only the radio.
  assert.equal(root.querySelector('.night-strategy option').textContent, 'Same as my settings (Trust the agent when it is sure, otherwise weigh the options)');
  assert.equal(root.querySelector('.night-num[data-field="graceMinutes"]').placeholder, 'Same as my settings (30)');
  assert.match(root.querySelector('.away-summary').textContent, /^For Shop: /);
  assert.doesNotMatch(root.querySelector('.away-summary').textContent, /this project/, 'nothing overridden yet');
});

test('project level: a value set here marks its summary line "(this project)"', () => {
  const root = formRoot();
  renderNightForm(root, { level: 'project', values: { graceMinutes: 45 }, effective: { ...NIGHT_DEFAULTS, window: '22:00-07:00', timeZone: 'UTC', graceMinutes: 45 }, sources: { graceMinutes: 'project' },
    inherited: { config: { ...NIGHT_DEFAULTS, window: '22:00-07:00', timeZone: 'UTC', graceMinutes: 30 }, sources: {} }, toggle: 'auto', now: Date.parse('2026-09-28T15:00:00Z'), projectName: 'Shop' });
  const lines = [...root.querySelectorAll('.away-summary .away-line')].map((s) => s.textContent.trim());
  assert.match(lines[2], /waited 45 minutes\. Unmarked runs always wait\. \(this project\)$/);
  assert.doesNotMatch(lines[1], /this project/);
});

// A bare "click "I'm away now"" points at a button the project tab does not have.
const bareButton = (text) => /click "I'm (away now|back)"(?! in Settings › Away mode)|turn it back on(?! in Settings › Away mode)/.test(text);

test('project level: no summary line or hint sends the user to a status button that is not on the page', () => {
  const root = formRoot();
  const inherited = { config: { ...NIGHT_DEFAULTS, window: null, timeZone: 'UTC', graceMinutes: 30 }, sources: {} };
  for (const toggle of ['auto', 'on', 'off']) {
    renderNightForm(root, { level: 'project', values: {}, effective: inherited.config, sources: {}, inherited, toggle, now: Date.parse('2026-09-28T15:00:00Z'), projectName: 'worca-cc' });
    const summary = root.querySelector('.away-summary').textContent;
    assert.ok(!bareButton(summary), `${toggle}: ${summary}`);
    assert.match(summary, /in Settings › Away mode/, toggle);
    assert.ok(!bareButton(root.textContent), `${toggle}: a hint on the tab`);
    updateAwaySummary(root, { toggle, now: Date.parse('2026-09-28T15:00:00Z') });
    assert.ok(!bareButton(root.querySelector('.away-summary').textContent), `${toggle}: after a repaint`);
  }
  assert.match(root.textContent, /You only count as away when you click "I'm away now" in Settings › Away mode\./);
});

test('user level: the Settings card keeps the bare button wording (the buttons sit right below)', () => {
  const root = formRoot();
  const inherited = { config: { ...NIGHT_DEFAULTS, window: null, timeZone: 'UTC', graceMinutes: 30 }, sources: {} };
  renderNightForm(root, { level: 'user', values: {}, effective: inherited.config, sources: {}, inherited, toggle: 'auto', now: Date.parse('2026-09-28T15:00:00Z') });
  assert.match(root.querySelector('.away-summary').textContent, /click "I'm away now", or on a marked run/);
  assert.match(root.textContent, /You only count as away when you click "I'm away now"\./);
  assert.doesNotMatch(root.textContent, /Settings › Away mode/);
});

test('project card: Away mode for this project, its summary, and Save re-reads GET /api/away-mode?projectDir=', async () => {
  const body = { config: { ...NIGHT_DEFAULTS, window: '22:00-07:00', timeZone: 'UTC' }, sources: {}, inherited: resolveNightConfig({ user: { window: '22:00-07:00', timeZone: 'UTC' } }), toggle: 'auto', user: {}, project: {} };
  const ctx = await boot({ away: (u) => (u.includes('projectDir=') ? body : { ...body, inherited: resolveNightConfig({}) }) });
  ctx.window.location.hash = 'projects/proj-1/away';
  await settle(12);
  const card = ctx.window.document.querySelector('.pd-sec[data-sec="away"] .pd-night-card');
  assert.ok(card, 'the card is on the project\'s Away mode tab');
  assert.equal(card.querySelector('.card-head b').textContent, 'Away mode for this project');
  assert.match(card.querySelector('.card-head').textContent, /Anything left as "Same as my settings" uses your Settings page/);
  assert.match(card.querySelector('.away-summary').textContent, /^For proj: /);
  assert.ok([...card.querySelectorAll('small.hint')].some((h) => h.textContent === '"I\'m away now" and "Pause" are global. Change them in Settings › Away mode.'));
  assert.equal(card.querySelector('.pd-night-reset').textContent, 'Use my settings');
  assert.ok(!bareButton(card.textContent), 'nothing on the tab points at a status button it does not have');
  const before = ctx.awayCalls.length;
  card.querySelector('.pd-night-save').dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
  await settle(8);
  const patch = ctx.posts.filter((p) => p.path.endsWith('/api/config')).at(-1);
  assert.equal(patch.body.projectDir, '/repos/proj');
  assert.ok(patch.body.nightMode && Array.isArray(patch.body.nightMode.__unset));
  assert.ok(ctx.awayCalls.slice(before).some((u) => u.includes(`projectDir=${encodeURIComponent('/repos/proj')}`)), 'a fresh GET after the save');
});

// Task 7: the run page pill ticks on the 1 s timer even while the run waits on a question.
const T = Date.parse('2026-09-28T15:00:00Z');
const AWAY_C = { ...NIGHT_DEFAULTS, window: '22:00-07:00', timeZone: 'UTC', graceMinutes: 30, enabled: false };
const awayBody = (o = {}) => ({ config: AWAY_C, sources: {}, inherited: resolveNightConfig({}), toggle: 'auto', user: {}, project: {}, ...o });
const PENDING = { type: 'question', id: 'clarify-p-1', kind: 'clarify', questions: [{ id: 'a', question: 'A?', options: ['x', 'y'] }] };
const realTick = () => new Promise((r) => setTimeout(r, 1100));
async function openRun(ctx, run) {
  ctx.dispatch({ type: 'hello', runs: [run] });
  ctx.window.location.hash = `running/${run.runId}`;
  ctx.window.dispatchEvent(new ctx.window.Event('hashchange'));
  await settle(8);
  return ctx.window.document.querySelector('#run-detail');
}

test('run page: the switch reads As set up / Answer for me now / Never on this run, with tips; the pill counts down', async () => {
  let now = T; Date.now = () => now;
  const ctx = await boot({ away: () => awayBody() });
  const screen = await openRun(ctx, { ...RUN, pendingQuestion: PENDING, night: { optIn: true, override: 'auto', decisions: 0, flagged: 0, openedAt: new Date(T).toISOString() } });
  const sel = screen.querySelector('.rd-night');
  assert.deepEqual([...sel.options].map((o) => [o.value, o.textContent, o.title]), RUN_SWITCH_OPTIONS.map((o) => [o.value, o.label, o.tip]));
  assert.equal(sel.closest('.rd-night-wrap').title, RUN_SWITCH_TIP);
  assert.equal(sel.closest('.rd-night-wrap').querySelector('.txt').textContent, 'Away mode on this run');
  const pill = screen.querySelector('.rd-night-pill');
  assert.equal(pill.textContent, 'answers after 30 min');
  assert.equal(pill.dataset.state, 'after');
  now = T + 12 * 60_000;
  await realTick();
  assert.equal(pill.textContent, 'answers after 18 min');
});

test('run page: an open always-wait question (no openedAt) reads "waiting for you"', async () => {
  Date.now = () => T;
  const ctx = await boot({ away: () => awayBody() });
  const screen = await openRun(ctx, { ...RUN, pendingQuestion: PENDING, night: { optIn: true, override: 'auto', decisions: 0, flagged: 0, openedAt: null } });
  assert.equal(screen.querySelector('.rd-night-pill').textContent, 'waiting for you');
});

test('run page: a run with no projectDir uses the user-level body and never loops a fetch', async () => {
  Date.now = () => T;
  const ctx = await boot({ away: () => awayBody() });
  const screen = await openRun(ctx, { ...RUN, projectDir: '', pendingQuestion: PENDING, night: { optIn: true, override: 'auto', decisions: 0, flagged: 0, openedAt: new Date(T).toISOString() } });
  const n = ctx.awayCalls.length;
  assert.equal(screen.querySelector('.rd-night-pill').textContent, 'answers after 30 min');
  await realTick(); await realTick();
  assert.equal(ctx.awayCalls.length, n, 'no new fetch on the ticks');
});

test('run page: a project whose GET fails leaves the pill empty and is fetched once, not every second', async () => {
  Date.now = () => T;
  const ctx = await boot({ away: (u) => (u.includes('projectDir=') ? null : awayBody()) });
  const screen = await openRun(ctx, { ...RUN, pendingQuestion: PENDING, night: { optIn: true, override: 'auto', decisions: 0, flagged: 0, openedAt: new Date(T).toISOString() } });
  await realTick(); await realTick();
  assert.equal(screen.querySelector('.rd-night-pill').textContent, '');
  assert.equal(ctx.awayCalls.filter((u) => u.includes('projectDir=')).length, 1);
});

test('New run: "Mark this run" and the hint from describeNewRun', async () => {
  const body = awayBody();
  const ctx = await boot({ away: () => body });
  const doc = ctx.window.document;
  assert.equal(doc.querySelector('#night-row .txt').textContent, 'Mark this run: worca may answer for me');
  assert.equal(doc.getElementById('nightModeHint').textContent, describeNewRun({ config: body.config, toggle: body.toggle }));
  const off = await boot({ away: () => awayBody({ toggle: 'off' }) });
  assert.match(off.window.document.getElementById('nightModeHint').textContent, /^Away mode is paused/);
});

test('run view: a finished run Away mode answered gets a note at the top of its result', async () => {
  const ctx = await boot();
  const screen = await openDetail(ctx);
  ctx.dispatch({ type: 'state', runId: RUN.runId, seq: 7, status: 'done', night: { optIn: true, override: 'auto', decisions: 5, flagged: 2 } });
  await settle();
  const note = screen.querySelector('.rd-result .rd-away-note');
  assert.ok(note, 'the note shows on the finished run');
  assert.equal(note.querySelector('.rd-away-note-text').textContent, 'Away mode: 5 answers while you were away — 2 to check.');
  assert.ok(note.classList.contains('has-checks'));
});

test('run view: no note while the run is live, none when Away mode never answered', async () => {
  const ctx = await boot();
  const screen = await openDetail(ctx);
  ctx.dispatch({ type: 'state', runId: RUN.runId, seq: 7, status: 'running', night: { optIn: true, override: 'auto', decisions: 3, flagged: 1 } });
  await settle();
  assert.equal(screen.querySelector('.rd-away-note'), null, 'live run: the answers list carries it');
  ctx.dispatch({ type: 'state', runId: RUN.runId, seq: 8, status: 'done', night: { optIn: true, override: 'auto', decisions: 0, flagged: 0 } });
  await settle();
  assert.equal(screen.querySelector('.rd-away-note'), null);
});

test('project page: Away mode is its own tab after Memory, and the Overview no longer carries it', async () => {
  const body = { config: { ...NIGHT_DEFAULTS }, sources: {}, inherited: resolveNightConfig({}), toggle: 'auto', user: {}, project: {} };
  const ctx = await boot({ away: () => body });
  ctx.window.location.hash = 'projects/proj-1';
  await settle(12);
  const doc = ctx.window.document;
  const pills = [...doc.querySelectorAll('#proj-detail .pd-tab')].map((b) => b.dataset.sec);
  assert.ok(pills.indexOf('away') === pills.indexOf('memory') + 1, `away right after memory: ${pills.join(',')}`);
  assert.equal(doc.querySelector('#proj-detail .pd-tab[data-sec="away"]').textContent.trim(), 'Away mode');
  assert.equal(doc.querySelector('.pd-sec[data-sec="overview"] .pd-night-card'), null, 'not on the Overview');
  doc.querySelector('#proj-detail .pd-tab[data-sec="away"]').dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
  await settle(8);
  assert.equal(ctx.window.location.hash, '#projects/proj-1/away', 'the pill writes its own route');
  assert.ok(doc.querySelector('.pd-sec[data-sec="away"] .pd-night-card'));
});
