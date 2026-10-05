// test/ui-settings-about.test.mjs
// Settings ▸ About card: version (linked to its release tag) + repo link, painted
// from the `app` block of GET /api/settings, and the two feedback links ("Report a bug" /
// "Suggest an improvement") that about-links.mjs repaints from `app.bugsUrl`.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { useDomRelease } from './helpers/jsdom-release.mjs';
import { paintAboutInto } from '../ui/public/about-links.mjs';
import { checkRows } from './helpers/rows.mjs';

// Release each booted window after its test (see test/helpers/jsdom-release.mjs).
const trackDom = useDomRelease(afterEach);

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

// package.json repository.url in browsable form (same normalisation as ui/server.mjs).
const REPO_URL = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
// U+2014: what index.html's `&mdash;` placeholder parses to.
const EM_DASH = '\u2014';

// Fixture `app` values; deliberately not package.json's so painted and static states differ.
const PAINTED_VERSION = '9.9.9-test';
const PAINTED_REPO_URL = 'https://example.com/acme/widget';
const PAINTED_REPO_TEXT = 'example.com/acme/widget';
const PAINTED_RELEASE_URL = 'https://example.com/acme/widget/releases/tag/worca-app-v9.9.9-test';

const DAY = 86400000;
const okBudget = () => ({
  pipelineLimitUsd: null, totalLimitUsd: null, resetPeriod: 'monthly',
  windowStartMs: Date.now() - 3 * DAY, windowEndMs: Date.now() + 4 * DAY,
  msUntilReset: 4 * DAY, windowSpendUsd: 0, allTimeSpendUsd: 0,
  remainingUsd: null, blocked: false,
});

// GET /api/settings as the real route answers it, `app` included. Keep `chat: {}`:
// loadSettings hands it to paintChatSettings un-awaited, so a throw there fails the file.
const okSettings = () => ({
  root: '', projectsRoot: '', projectsRootDefault: '/home/me', default: '/home/me',
  pipelineCostLimitUsd: null, totalCostLimitUsd: null, costLimitResetPeriod: 'monthly',
  askMaxTurns: 40, askMaxBudgetUsd: 2, chat: {},
  app: { version: PAINTED_VERSION, repoUrl: PAINTED_REPO_URL, releaseUrl: PAINTED_RELEASE_URL },
});

const settingsView = () => {
  const dom = trackDom(new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' }));
  return dom.window.document.querySelector('.view[data-view="settings"]');
};

async function boot({ settings = okSettings } = {}) {
  const dom = trackDom(new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' }));
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  window.WebSocket = class { constructor() { this.readyState = 1; } send() {} close() {} addEventListener() {} };
  window.fetch = (url) => {
    const u = String(url);
    if (u.includes('/api/settings'))
      return Promise.resolve({ ok: true, status: 200, json: async () => settings() });
    if (u.includes('/api/budget'))
      return Promise.resolve({ ok: true, status: 200, json: async () => okBudget() });
    if (u.includes('/api/projects'))
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ projects: [] }) });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ config: { steps: {}, customModels: [] }, models: [], efforts: [] }) });
  };
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch { /* keep */ }
  }
  globalThis.window = window; globalThis.document = window.document;
  await import(pathToFileURL(appPath).href + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const $ = (sel) => window.document.querySelector(sel);
  const openSettings = async () => {
    window.location.hash = 'settings';
    window.dispatchEvent(new window.Event('hashchange'));
    await tick();
  };
  return { window, tick, $, openSettings };
}

test('opening Settings paints the version and repo link from the server payload', async () => {
  const { $, openSettings } = await boot();
  await openSettings();
  // None of these values is in index.html, so each line fails if paintAbout stops running.
  assert.equal($('#aboutVersion').textContent.trim(), PAINTED_VERSION, 'version painted from the payload');
  assert.equal($('#aboutVersion').getAttribute('href'), PAINTED_RELEASE_URL, 'version links to its release tag');
  assert.equal($('#aboutRepoLink').getAttribute('href'), PAINTED_REPO_URL, 'href painted from the payload');
  assert.equal($('#aboutRepoLink').textContent.trim(), PAINTED_REPO_TEXT, 'link text is the URL without its scheme');
  assert.equal($('#aboutRepoLink').getAttribute('target'), '_blank', 'paint never drops target');
  assert.equal($('#aboutRepoLink').getAttribute('rel'), 'noopener noreferrer', 'paint never drops rel');
});

// A table over two payloads: each row boots the page with its own GET /api/settings answer.
test('a payload with no app block or malformed repoUrl/releaseUrl never blanks the card nor aborts the rest of the settings paint', async () => {
  await checkRows([
    { name: 'a payload with no `app` block leaves the static fallback alone (never blanks the card)', run: async () => {
      const noApp = () => { const s = okSettings(); delete s.app; return s; };
      const { $, openSettings } = await boot({ settings: noApp });
      await openSettings();
      assert.equal($('#aboutVersion').textContent.trim(), EM_DASH, 'placeholder kept, not emptied');
      assert.equal($('#aboutVersion').hasAttribute('href'), false, 'placeholder still unlinked');
      assert.equal($('#aboutRepoLink').getAttribute('href'), REPO_URL, 'static href kept');
      // Without paintAbout's `if (!info) return` the throw would abort every later paint.
      assert.equal($('#settingsLoadMsg').hidden, true, 'the rest of the settings paint still ran');
      assert.equal($('#settingsLoadMsg').textContent, '');
    } },
    { name: 'malformed `repoUrl`/`releaseUrl` cannot abort the rest of the settings paint', run: async () => {
      const badUrl = () => ({ ...okSettings(), app: { version: PAINTED_VERSION, repoUrl: 42, releaseUrl: null } });
      const { $, openSettings } = await boot({ settings: badUrl });
      await openSettings();
      assert.equal($('#settingsLoadMsg').hidden, true, 'no throw reached the loadSettings catch');
      assert.equal($('#settingsLoadMsg').textContent, '');
      assert.equal($('#aboutRepoLink').getAttribute('href'), REPO_URL, 'static href kept');
      assert.equal($('#aboutVersion').textContent.trim(), PAINTED_VERSION, 'the usable part still painted');
      assert.equal($('#aboutVersion').hasAttribute('href'), false, 'no release link without a usable URL');
    } },
  ]);
});

// The feedback links: a table over three payloads through the pure about-links.mjs (no app.js),
// each row on a fresh copy of the Settings markup.
test('paintAboutInto points both feedback links at bugs.url (no doubled slash) and a missing bugsUrl leaves the static href alone', async () => {
  await checkRows([
    { name: 'paintAboutInto points both links at bugs.url from the settings payload', run: async () => {
      const view = settingsView();
      paintAboutInto(view, { version: '1.2.0', repoUrl: 'https://github.com/x/y',
                             bugsUrl: 'https://github.com/x/y/issues' });
      assert.equal(view.querySelector('#aboutBugLink').getAttribute('href'),
        'https://github.com/x/y/issues/new?labels=bug', 'the bug link targets the bug label');
      assert.equal(view.querySelector('#aboutIdeaLink').getAttribute('href'),
        'https://github.com/x/y/issues/new?labels=enhancement', 'the idea link targets the enhancement label');
    } },
    { name: 'a trailing slash does not produce a doubled slash', run: async () => {
      const view = settingsView();
      paintAboutInto(view, { bugsUrl: 'https://github.com/x/y/issues/' });
      assert.equal(view.querySelector('#aboutBugLink').getAttribute('href'),
        'https://github.com/x/y/issues/new?labels=bug', 'no doubled slash');
    } },
    { name: 'a missing bugsUrl leaves the static markup href alone', run: async () => {
      // A FRESH view per case: reusing the one the previous test repainted would assert
      // against a value paintAboutInto had already written, which proves nothing about
      // the static fallback.
      const view = settingsView();
      const before = view.querySelector('#aboutBugLink').getAttribute('href');
      assert.match(before, /\/issues\/new\?labels=bug$/,
        'the markup ships a usable href before /api/settings lands');
      for (const info of [{}, { bugsUrl: '' }, { bugsUrl: 42 }, undefined]) {
        paintAboutInto(view, info);
        assert.equal(view.querySelector('#aboutBugLink').getAttribute('href'), before,
          `${JSON.stringify(info)} must not blank the link`);
      }
    } },
  ]);
});
