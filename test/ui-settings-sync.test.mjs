// test/ui-settings-sync.test.mjs — Settings › Runs › Sync before run (#527): the instance sync defaults.
// Boot preamble copied from test/ui-settings-workspace-scan.test.mjs (house convention).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));

const BUILT_IN = { beforeRun: true, remote: 'origin', refreshMinutes: 10, onDiverged: 'ask' };
const SETTINGS = { sync: BUILT_IN, schedule: { ifMissed: 'run', graceMin: 60, maxFailures: 3 }, app: {}, theme: {}, chat: {} };

async function boot({ settings = SETTINGS, postStatus = 200 } = {}) {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  window.WebSocket = class { constructor() { this.readyState = 1; } send() {} close() {} addEventListener() {} };
  const posts = [];
  const box = { settings: { ...settings } };
  window.fetch = (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    if (u.includes('/api/settings')) {
      if (method === 'POST') {
        const body = JSON.parse(opts.body);
        posts.push(body);
        if (postStatus !== 200) return Promise.resolve({ ok: false, status: postStatus, json: async () => ({ error: 'sync.remote must be a remote NAME (e.g. origin), never a URL' }) });
        if ('sync' in body) {
          const next = body.sync === null ? {} : Object.fromEntries(Object.entries(body.sync).filter(([, v]) => v !== null));
          box.settings = { ...box.settings, sync: { ...BUILT_IN, ...next } };
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ...box.settings }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ...box.settings }) });
    }
    if (u.includes('/api/budget'))
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ pipelineLimitUsd: null, totalLimitUsd: null, resetPeriod: 'monthly', windowStartMs: 0, windowEndMs: 0, msUntilReset: 0, windowSpendUsd: 0, allTimeSpendUsd: 0, remainingUsd: null, blocked: false }) });
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
  const openSettings = async () => {
    window.location.hash = 'settings';
    window.dispatchEvent(new window.Event('hashchange'));
    await tick(); await tick(); await tick();
  };
  return { window, posts, tick, openSettings };
}

const ids = ['syncDefBeforeRun', 'syncDefOnDiverged', 'syncDefRemote', 'syncDefRefresh'];
const read = (doc) => {
  const [b, d, r, m] = ids.map((id) => doc.getElementById(id));
  return { beforeRun: b.checked, onDiverged: d.value, remote: r.value, refreshMinutes: m.value };
};

test('the Sync before run card sits on the Runs tab before Scheduled runs, Advanced level, and paints the stored defaults', async () => {
  const { window, openSettings } = await boot({ settings: { ...SETTINGS, sync: { beforeRun: false, remote: 'upstream', refreshMinutes: 30, onDiverged: 'fail' } } });
  await openSettings();
  const doc = window.document;
  const card = doc.getElementById('sync-settings-card');
  assert.ok(card.closest('.settings-pane[data-tab="runs"]'), 'on the Runs tab');
  assert.equal(card.dataset.minLevel, 'advanced');
  assert.equal(card.querySelector('h2').textContent.trim(), 'Sync before run');
  assert.equal(card.nextElementSibling.id, 'schedule-settings-card');
  assert.deepEqual(read(doc), { beforeRun: false, onDiverged: 'fail', remote: 'upstream', refreshMinutes: '30' });
  assert.deepEqual([...doc.getElementById('syncDefOnDiverged').options].map((o) => o.value), ['ask', 'origin', 'fail']);
  assert.match(card.textContent, /scheduled run cannot ask/i, 'the tip says what Ask me means for a schedule');
});

test('an off-list refresh interval is added as an option rather than painted as a blank select', async () => {
  const { window, openSettings } = await boot({ settings: { ...SETTINGS, sync: { ...BUILT_IN, refreshMinutes: 15 } } });
  await openSettings();
  assert.equal(window.document.getElementById('syncDefRefresh').value, '15');
});

test('Save posts all four fields (an empty remote resets it); Use defaults posts sync:null and repaints', async () => {
  const { window, openSettings, posts, tick } = await boot();
  await openSettings();
  const doc = window.document;
  doc.getElementById('syncDefBeforeRun').checked = false;
  doc.getElementById('syncDefOnDiverged').value = 'origin';
  doc.getElementById('syncDefRemote').value = '  ';
  doc.getElementById('syncDefRefresh').value = '0';
  doc.getElementById('syncDefaultsSave').click();
  await tick(); await tick();
  assert.deepEqual(posts.at(-1), { sync: { beforeRun: false, onDiverged: 'origin', remote: null, refreshMinutes: 0 } });
  assert.equal(doc.getElementById('syncDefaultsMsg').textContent, 'Saved.');
  assert.deepEqual(read(doc), { beforeRun: false, onDiverged: 'origin', remote: 'origin', refreshMinutes: '0' });

  doc.getElementById('syncDefaultsReset').click();
  await tick(); await tick();
  assert.deepEqual(posts.at(-1), { sync: null });
  assert.deepEqual(read(doc), { beforeRun: true, onDiverged: 'ask', remote: 'origin', refreshMinutes: '10' });
});

test('a refused save shows the server error and leaves the fields as typed', async () => {
  const { window, openSettings, tick } = await boot({ postStatus: 400 });
  await openSettings();
  const doc = window.document;
  doc.getElementById('syncDefRemote').value = 'https://example.com/x.git';
  doc.getElementById('syncDefaultsSave').click();
  await tick(); await tick();
  const msg = doc.getElementById('syncDefaultsMsg');
  assert.match(msg.textContent, /never a URL/);
  assert.ok(msg.classList.contains('err'));
  assert.equal(doc.getElementById('syncDefRemote').value, 'https://example.com/x.git');
});
