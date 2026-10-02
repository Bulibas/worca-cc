// test/ui-mobile-nav.test.mjs — the three navigation tiers. Desktop (>1080px): the
// sidebar, or the 76px rail by preference. Tablet (761-1080px): the rail, always,
// preference untouched. Phone (<=760px): the #mbar top bar whose hamburger opens the
// FULL sidebar as a slide-in drawer (counts, live runs, spend, signed-in: parity).
// jsdom has no matchMedia, so boot() installs a width-driven stub BEFORE app.js loads.
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
const html = readFileSync(join(root, 'index.html'), 'utf8');
const css = readFileSync(join(root, 'style.css'), 'utf8');
const js = readFileSync(join(root, 'app.js'), 'utf8');
const appPath = join(root, 'app.js');
const PROJECT = '/tmp/proj';
const SIDEBAR_KEY = 'worca-cc.sidebar.collapsed';
const DAY = 24 * 60 * 60 * 1000;
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Only max-width / min-width queries can match; colour-scheme and reduced-motion stay false. */
function mediaStub(width) {
  let w = width;
  const lists = [];
  const evalQ = (q) => {
    const max = /max-width:\s*(\d+)px/.exec(q);
    const min = /min-width:\s*(\d+)px/.exec(q);
    if (!max && !min) return false;
    return (!max || w <= Number(max[1])) && (!min || w >= Number(min[1]));
  };
  const matchMedia = (q) => {
    const l = {
      media: q, matches: evalQ(q), fns: [],
      addEventListener(t, fn) { if (t === 'change') this.fns.push(fn); },
      removeEventListener() {}, addListener(fn) { this.fns.push(fn); }, removeListener() {},
    };
    lists.push(l);
    return l;
  };
  const resize = (next) => {
    w = next;
    for (const l of lists) {
      const m = evalQ(l.media);
      if (m !== l.matches) { l.matches = m; for (const fn of l.fns) fn({ matches: m, media: l.media }); }
    }
  };
  return { matchMedia, resize };
}

async function boot({ width = 1280, seed = {} } = {}) {
  const dom = trackDom(new JSDOM(html, { url: 'http://localhost:4317/' }));
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  window.__budgetTickMs = DAY;   // the budget ticker must not repaint a later test's DOM (ui-sidebar-collapse:142-151)
  const media = mediaStub(width);
  window.matchMedia = media.matchMedia;
  let lastWs = null;
  window.WebSocket = class { constructor() { this.readyState = 1; this._l = {}; lastWs = this; }
    send() {} close() {} addEventListener(t, fn) { (this._l[t] ||= []).push(fn); } };
  window.fetch = (u) => {
    const url = String(u);
    if (url.includes('/api/projects')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ projects: [{ name: 'proj', path: PROJECT, exists: true }] }) });
    }
    if (url.includes('/api/stats')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({
        range: 'month', bucket: 'day', windowStartMs: Date.now() - 30 * DAY, windowEndMs: Date.now(),
        totals: { spentUsd: 0, pipelineSpendUsd: 0, ask: { spendUsd: 0, sessions: 0, turns: 0 },
          workedMs: 0, runs: 0, finished: 0, stopped: 0, failed: 0, paused: 0, running: 0, prsOpened: 0, prsMerged: 0 },
        prev: null, budget: null, series: [],
      }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ config: { steps: {}, customModels: [] }, models: [], efforts: [], pipelines: 0, projects: 0, workspaces: 0 }) });
  };
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch {}
  }
  globalThis.window = window; globalThis.document = window.document;
  window.localStorage.clear();
  for (const [k, v] of Object.entries(seed)) window.localStorage.setItem(k, v);
  await import(pathToFileURL(appPath).href + `?b=${Date.now()}_${Math.random()}`);
  await tick();
  lastWs._l.open?.forEach((fn) => fn());
  const recv = (obj) => lastWs._l.message.forEach((fn) => fn({ data: JSON.stringify(obj) }));
  const $ = (s) => window.document.querySelector(s);
  const click = (s) => (typeof s === 'string' ? $(s) : s)
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const key = (k) => window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }));
  return { window, $, click, key, recv, resize: media.resize };
}

const live = (runId, extra = {}) => ({
  runId, title: runId, projectDir: PROJECT, status: 'running', kind: 'run',
  startedAt: '10:00:00', pendingQuestion: null, ...extra,
});

// ---- static: the pill bar is gone everywhere ----

test('the compact .topnav is removed from markup, CSS and JS', () => {
  assert.doesNotMatch(html, /topnav/);
  assert.doesNotMatch(css, /topnav/);
  assert.doesNotMatch(js, /topnav/);
});

test('phone bar markup: hamburger (controls the sidebar), rollup dot, title; scrim; drawer close', () => {
  const doc = trackDom(new JSDOM(html)).window.document;
  const bar = doc.querySelector('.app > #mbar.mbar');
  assert.ok(bar, '#mbar is a direct child of .app');
  const menu = bar.querySelector('#mbar-menu');
  assert.equal(menu.tagName, 'BUTTON');
  assert.equal(menu.getAttribute('aria-controls'), 'side-rail');
  assert.equal(menu.getAttribute('aria-expanded'), 'false');
  assert.equal(menu.getAttribute('aria-label'), 'Menu');
  assert.ok(menu.querySelector('#mbar-rollup.nav-rollup[hidden]'), 'the needs-input dot rides the menu button');
  assert.ok(bar.querySelector('#mbar-title'));
  assert.equal(bar.querySelectorAll('[data-nav]').length, 0, 'the bar does not duplicate the route list');
  assert.ok(doc.querySelector('.app > #nav-scrim.nav-scrim[hidden]'));
  const close = doc.querySelector('#side-rail .brand #side-close');
  assert.ok(close, 'the drawer has its own close button');
  assert.equal(close.getAttribute('aria-label'), 'Close menu');
});

// ---- CSS structure ----

const tiers = () => {
  const start = css.indexOf('/* ---------- Responsive nav tiers');
  assert.ok(start > 0, 'the Responsive nav tiers block exists');
  const end = css.indexOf('/* ---------- Ask Worca', start);
  assert.ok(end > start, 'and it sits before the Ask Worca block');
  return css.slice(start, end);
};

test('<=1080px no longer hides the sidebar; the tablet tier hides only the collapse toggle', () => {
  assert.doesNotMatch(css, /@media \(max-width:1080px\)\{\s*\.grid\{[^}]*\}\s*\.sidebar\{display:none;\}/);
  assert.match(tiers(), /@media \(max-width:1080px\)\{[^@]*\.sidebar \.side-toggle\{display:none;\}/);
});

test('phone tier: the sidebar is an off-canvas fixed drawer above the Ask dock and below modals', () => {
  const t = tiers();
  const phone = t.slice(t.indexOf('@media (max-width:760px){'));
  assert.match(phone, /\.app\{flex-direction:column;\}/);
  assert.match(phone, /\.mbar\{display:flex;/);
  assert.match(phone, /\.sidebar\{position:fixed;[^}]*z-index:42;[^}]*transform:translateX\(-100%\);[^}]*visibility:hidden;/);
  assert.match(phone, /body\.nav-open \.sidebar\{transform:none;visibility:visible;/);
  assert.match(phone, /\.nav-scrim\{display:block;position:fixed;inset:0;z-index:41;background:var\(--scrim\);\}/);
  assert.match(phone, /\.nav-scrim\[hidden\]\{display:none;\}/);
  assert.match(phone, /\.side-close\{display:flex;/);
  // outside the media blocks every new control is hidden (desktop + tablet)
  assert.match(t, /\.mbar,\.nav-scrim,\.side-close\{display:none;\}/);
});

test('the Ask dock spans the viewport only on phones; the tablet rail keeps its 76px arm', () => {
  assert.doesNotMatch(css, /@media \(max-width:1080px\)\{\s*\.ask-dock,body\.rail-collapsed \.ask-dock\{left:0;\}/);
  assert.match(css, /@media \(max-width:760px\)\{\s*\.ask-dock,body\.rail-collapsed \.ask-dock\{left:0;\}\s*\}/);
});

// ---- desktop (unchanged) ----

test('desktop: the preference still drives the rail and the hamburger never opens a drawer', async () => {
  const { $, click, window } = await boot({ width: 1280, seed: { [SIDEBAR_KEY]: '1' } });
  assert.ok($('.sidebar').classList.contains('collapsed'));
  click('#side-toggle');
  assert.equal($('.sidebar').classList.contains('collapsed'), false);
  assert.equal(window.localStorage.getItem(SIDEBAR_KEY), '0');
  click('#mbar-menu');
  assert.equal(window.document.body.classList.contains('nav-open'), false);
});

// ---- tablet ----

test('tablet: the icon rail is forced without touching the stored preference', async () => {
  const { $, window, recv } = await boot({ width: 900 });
  assert.ok($('.sidebar').classList.contains('collapsed'), 'rail on tablets');
  assert.ok(window.document.body.classList.contains('rail-collapsed'), 'the Ask dock follows (left:76px)');
  assert.equal(window.localStorage.getItem(SIDEBAR_KEY), null, 'nothing persisted');
  assert.equal($('.nav button[data-nav="composer"]').title, 'Workflow Composer', 'rail tooltips');
  recv({ type: 'hello', runs: [live('auth-fix')] });
  assert.equal($('#nav-running-count').textContent, '1', 'the Runs badge counts the live run (no per-run rows)');
});

// ---- phone ----

test('phone: the drawer is the FULL sidebar even when the rail preference is on', async () => {
  const { $, window, recv } = await boot({ width: 390, seed: { [SIDEBAR_KEY]: '1' } });
  assert.equal($('.sidebar').classList.contains('collapsed'), false);
  assert.equal(window.document.body.classList.contains('rail-collapsed'), false);
  assert.equal(window.localStorage.getItem(SIDEBAR_KEY), '1', 'the desktop preference survives');
  recv({ type: 'hello', runs: [live('auth-fix'), live('seo', { pendingQuestion: { id: 'q1', kind: 'clarify', questions: [{ question: 'x?', options: ['a'] }] } })] });
  assert.equal($('#nav-running-count').textContent, '2', 'counts');
  assert.equal($('#mbar-rollup').hidden, false, 'the menu button carries the needs-input dot');
  assert.equal($('#mbar-menu').getAttribute('aria-label'), 'Menu — a pipeline needs your input');
});

test('phone: open, close by scrim / close button / Escape; focus and inert are managed', async () => {
  const { $, click, key, window } = await boot({ width: 390 });
  const body = window.document.body;
  click('#mbar-menu');
  assert.ok(body.classList.contains('nav-open'));
  assert.equal($('#mbar-menu').getAttribute('aria-expanded'), 'true');
  assert.equal($('#nav-scrim').hidden, false);
  assert.ok($('.main').hasAttribute('inert'), 'the page behind is inert');
  assert.ok($('#mbar').hasAttribute('inert'));
  assert.equal(window.document.activeElement, $('#side-close'), 'focus moves into the drawer');

  click('#nav-scrim');
  assert.equal(body.classList.contains('nav-open'), false);
  assert.equal($('#nav-scrim').hidden, true);
  assert.equal($('.main').hasAttribute('inert'), false);
  assert.equal(window.document.activeElement, $('#mbar-menu'), 'focus returns to the hamburger');

  click('#mbar-menu'); click('#side-close');
  assert.equal(body.classList.contains('nav-open'), false);
  click('#mbar-menu'); key('Escape');
  assert.equal(body.classList.contains('nav-open'), false);
});

test('phone: a route closes the drawer and names the page in the bar; disclosure and mode switch do not', async () => {
  const { $, click, window } = await boot({ width: 390 });
  const body = window.document.body;
  assert.equal($('#mbar-title').textContent, 'New pipeline');
  click('#mbar-menu');
  click('.nav .nav-group[data-nav-group="nodes"]');
  assert.ok(body.classList.contains('nav-open'), 'folding Nodes keeps the drawer open');
  click('#nav-mode');
  assert.ok(body.classList.contains('nav-open'), 'the mode dialog opens over the drawer');
  assert.equal($('#mode-modal').classList.contains('hidden'), false);
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal($('#mode-modal').classList.contains('hidden'), true, 'Esc closes the dialog…');
  assert.ok(body.classList.contains('nav-open'), '…and only the dialog');
  click('.nav button[data-nav="stats"]');
  await tick();
  assert.equal(window.location.hash, '#stats');
  assert.equal(body.classList.contains('nav-open'), false);
  assert.equal($('#mbar-title').textContent, 'Statistics');
});

test('phone: a hash change (back button) closes an open drawer', async () => {
  const { $, click, window } = await boot({ width: 390 });
  click('#mbar-menu');
  window.location.hash = 'history';   // a legacy bare route: it lands on the one Runs page
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await tick();
  assert.equal(window.document.body.classList.contains('nav-open'), false);
  assert.equal($('#mbar-title').textContent, 'Runs');
});

test('resizing across tiers closes the drawer and re-derives the rail', async () => {
  const { $, click, resize, window } = await boot({ width: 390 });
  click('#mbar-menu');
  resize(900);
  assert.equal(window.document.body.classList.contains('nav-open'), false);
  assert.equal($('.main').hasAttribute('inert'), false);
  assert.ok($('.sidebar').classList.contains('collapsed'), 'tablet → rail');
  resize(1280);
  assert.equal($('.sidebar').classList.contains('collapsed'), false, 'desktop → the (unset) preference');
  click('#mbar-menu');
  assert.equal(window.document.body.classList.contains('nav-open'), false, 'no drawer off-phone');
});
