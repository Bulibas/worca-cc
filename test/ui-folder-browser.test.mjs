// test/ui-folder-browser.test.mjs
// JSDOM tests for the add-project Browse button: native-dialog happy path and
// the in-app folder-browser modal fallback.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { useDomRelease } from './helpers/jsdom-release.mjs';

// Release each booted window after its test (see test/helpers/jsdom-release.mjs).
const trackDom = useDomRelease(afterEach);

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));

class WSStub {
  static last = null;
  constructor() { WSStub.last = this; this.sent = []; this.readyState = 0; }
  addEventListener(ev, fn) { (this._h ||= {})[ev] = fn; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() {}
  _open() { this.readyState = 1; this._h?.open?.(); }
}

const click = (window, node) => node.dispatchEvent(new window.Event('click', { bubbles: true }));
const tick = () => new Promise((r) => setTimeout(r, 0));

async function boot({ fetchHandler } = {}) {
  const dom = trackDom(new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' }));
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  window.WebSocket = WSStub;
  window.confirm = () => true;
  window.fetch = (url, opts) => {
    const u = String(url);
    if (fetchHandler) { const r = fetchHandler(u, opts || {}); if (r) return r; }
    if (u.includes('/api/projects')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ projects: [] }) });
    if (u.includes('/api/workspaces')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ workspaces: [] }) });
    if (u.includes('/api/branches')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ branches: [], current: '' }) });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ config: { steps: {}, customModels: [] }, models: [], efforts: [] }) });
  };
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch { /* read-only global */ }
  }
  globalThis.window = window;
  globalThis.document = window.document;
  await import(pathToFileURL(appPath).href + `?b=${Date.now()}_${Math.random()}`);
  await tick();
  if (WSStub.last) WSStub.last._open();
  return { window };
}

function openAddForm(window) {
  const sel = window.document.querySelector('#projectSelect');
  sel.value = '__add__';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
}

test('Browse fills the path (and an empty name) from the native dialog', async () => {
  const { window } = await boot({
    fetchHandler: (u, opts) => {
      if (u.endsWith('/api/fs/pick-folder') && opts.method === 'POST') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: 'picked', path: '/Users/me/dev/my-app' }) });
      }
      return null;
    },
  });
  openAddForm(window);
  const doc = window.document;
  click(window, doc.querySelector('#newProjectBrowse'));
  await tick(); await tick();
  assert.equal(doc.querySelector('#newProjectPath').value, '/Users/me/dev/my-app');
  assert.equal(doc.querySelector('#newProjectName').value, 'my-app', 'empty name prefilled from basename');
  assert.ok(doc.querySelector('#folder-browser').classList.contains('hidden'), 'modal stays closed');
});

test('a typed name is not overwritten by the picker', async () => {
  const { window } = await boot({
    fetchHandler: (u, opts) => (u.endsWith('/api/fs/pick-folder') && opts.method === 'POST'
      ? Promise.resolve({ ok: true, status: 200, json: async () => ({ status: 'picked', path: '/srv/code' }) })
      : null),
  });
  openAddForm(window);
  const doc = window.document;
  doc.querySelector('#newProjectName').value = 'Custom';
  click(window, doc.querySelector('#newProjectBrowse'));
  await tick(); await tick();
  assert.equal(doc.querySelector('#newProjectName').value, 'Custom');
  assert.equal(doc.querySelector('#newProjectPath').value, '/srv/code');
});

test('unsupported dialog opens the modal; navigating + Select fills the field', async () => {
  const listings = {
    '': { path: '/home/me', parent: '/home', home: '/home/me', dirs: [{ name: 'dev', path: '/home/me/dev' }] },
    '/home/me/dev': { path: '/home/me/dev', parent: '/home/me', home: '/home/me', dirs: [] },
  };
  const { window } = await boot({
    fetchHandler: (u, opts) => {
      if (u.endsWith('/api/fs/pick-folder') && opts.method === 'POST') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: 'unsupported' }) });
      }
      if (u.includes('/api/fs/dirs')) {
        const q = decodeURIComponent(u.split('path=')[1] || '');
        const body = listings[q] || listings[''];
        return Promise.resolve({ ok: true, status: 200, json: async () => body });
      }
      return null;
    },
  });
  openAddForm(window);
  const doc = window.document;
  click(window, doc.querySelector('#newProjectBrowse'));
  await tick(); await tick(); await tick();
  const modal = doc.querySelector('#folder-browser');
  assert.ok(!modal.classList.contains('hidden'), 'fallback modal opened');
  assert.equal(doc.querySelector('#folderCurrent').textContent, '/home/me');

  const item = [...doc.querySelectorAll('#folderList .folder-item')].find((b) => b.textContent === 'dev');
  assert.ok(item, 'dev folder rendered');
  click(window, item);
  await tick(); await tick();
  assert.equal(doc.querySelector('#folderCurrent').textContent, '/home/me/dev');

  click(window, doc.querySelector('#folderSelect'));
  assert.equal(doc.querySelector('#newProjectPath').value, '/home/me/dev');
  assert.ok(modal.classList.contains('hidden'), 'modal closed after Select');
});

test('a canceled native dialog changes nothing', async () => {
  const { window } = await boot({
    fetchHandler: (u, opts) => (u.endsWith('/api/fs/pick-folder') && opts.method === 'POST'
      ? Promise.resolve({ ok: true, status: 200, json: async () => ({ status: 'canceled' }) })
      : null),
  });
  openAddForm(window);
  const doc = window.document;
  doc.querySelector('#newProjectPath').value = '/keep/me';
  click(window, doc.querySelector('#newProjectBrowse'));
  await tick(); await tick();
  assert.equal(doc.querySelector('#newProjectPath').value, '/keep/me');
  assert.ok(doc.querySelector('#folder-browser').classList.contains('hidden'));
});

const LISTINGS = {
  '': { path: '/home/me', parent: '/home', home: '/home/me', dirs: [{ name: 'a', path: '/home/me/a' }, { name: 'dev', path: '/home/me/dev' }] },
  '/home/me/dev': { path: '/home/me/dev', parent: '/home/me', home: '/home/me', dirs: [{ name: 'b', path: '/home/me/dev/b' }] },
};
// Any other path (the '' seed, '/home/me') answers the home listing.
const dirsHandler = (status) => (u, opts) => {
  if (u.endsWith('/api/fs/pick-folder') && opts.method === 'POST') {
    return Promise.resolve({ ok: true, status: 200, json: async () => (typeof status === 'function' ? status(opts) : status) });
  }
  if (u.includes('/api/fs/dirs')) {
    const q = decodeURIComponent(u.split('path=')[1] || '');
    return Promise.resolve({ ok: true, status: 200, json: async () => LISTINGS[q] || LISTINGS[''] });
  }
  return null;
};

test('Browse asks the native dialog for multiple selections', async () => {
  let sent = null;
  const { window } = await boot({ fetchHandler: dirsHandler((opts) => { sent = JSON.parse(opts.body || '{}'); return { status: 'canceled' }; }) });
  openAddForm(window);
  click(window, window.document.querySelector('#newProjectBrowse'));
  await tick(); await tick();
  assert.deepEqual(sent, { purpose: 'project', multiple: true });
});

test('native multi-pick of 2 folders hides the inline form and opens the review list', async () => {
  const { window } = await boot({ fetchHandler: dirsHandler({ status: 'picked', path: '/home/me/a', paths: ['/home/me/a', '/home/me/dev/b'] }) });
  openAddForm(window);
  const doc = window.document;
  click(window, doc.querySelector('#newProjectBrowse'));
  await tick(); await tick();
  assert.ok(doc.querySelector('#add-project').classList.contains('hidden'), 'inline form hidden');
  assert.ok(!doc.querySelector('#project-bulk-modal').classList.contains('hidden'), 'review list open');
  const names = [...doc.querySelectorAll('#proj-bulk-list .pb-name')].map((i) => i.value);
  assert.deepEqual(names, ['a', 'b'], 'names default to the folder basename');
});

test('unsupported dialog: the folder browser opens in multi mode; ticks survive navigation; Add N selected opens the review', async () => {
  const { window } = await boot({ fetchHandler: dirsHandler({ status: 'unsupported' }) });
  openAddForm(window);
  const doc = window.document;
  click(window, doc.querySelector('#newProjectBrowse'));
  await tick(); await tick(); await tick();
  assert.equal(doc.querySelector('#folderBrowserTitle').textContent, 'Select folders');
  const many = doc.querySelector('#folderSelectMany');
  assert.ok(!many.classList.contains('hidden'));
  assert.equal(many.disabled, true, 'nothing ticked yet');
  const pickA = doc.querySelector('#folderList .folder-pick');
  pickA.checked = true; pickA.dispatchEvent(new window.Event('change', { bubbles: true }));
  const dev = [...doc.querySelectorAll('#folderList .folder-item')].find((b) => b.textContent === 'dev');
  click(window, dev);
  await tick(); await tick();
  const pickB = doc.querySelector('#folderList .folder-pick');
  pickB.checked = true; pickB.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(doc.querySelector('#folderPickCount').textContent, '2 folders selected');
  assert.equal(many.textContent, 'Add 2 selected');
  click(window, many);
  await tick();
  assert.ok(doc.querySelector('#folder-browser').classList.contains('hidden'));
  const paths = [...doc.querySelectorAll('#proj-bulk-list .pb-row')].map((r) => r.dataset.path);
  assert.deepEqual(paths, ['/home/me/a', '/home/me/dev/b']);
});

test('one ticked folder fills the inline form instead of opening the review', async () => {
  const { window } = await boot({ fetchHandler: dirsHandler({ status: 'unsupported' }) });
  openAddForm(window);
  const doc = window.document;
  click(window, doc.querySelector('#newProjectBrowse'));
  await tick(); await tick(); await tick();
  const pick = doc.querySelector('#folderList .folder-pick');
  pick.checked = true; pick.dispatchEvent(new window.Event('change', { bubbles: true }));
  click(window, doc.querySelector('#folderSelectMany'));
  await tick();
  assert.equal(doc.querySelector('#newProjectPath').value, '/home/me/a');
  assert.ok(doc.querySelector('#project-bulk-modal').classList.contains('hidden'));
});

test('Several folders… opens Worca\'s browser in multi mode without asking the native dialog', async () => {
  let asked = 0;
  const { window } = await boot({ fetchHandler: dirsHandler(() => { asked += 1; return { status: 'picked', path: '/x' }; }) });
  openAddForm(window);
  const doc = window.document;
  click(window, doc.querySelector('#newProjectBrowseMany'));
  await tick(); await tick(); await tick();
  assert.equal(asked, 0);
  assert.ok(!doc.querySelector('#folder-browser').classList.contains('hidden'));
  assert.ok(doc.querySelector('#folderList .folder-pick'), 'checkboxes rendered');
});

test('a single-mode opener (Settings/export) gets no checkboxes and no Add-selected button', async () => {
  const { window } = await boot({ fetchHandler: dirsHandler({ status: 'unsupported' }) });
  const doc = window.document;
  await window.__projects.openFolderBrowser('', () => {});
  await tick();
  assert.equal(doc.querySelector('#folderList .folder-pick'), null);
  assert.ok(doc.querySelector('#folderSelectMany').classList.contains('hidden'));
  assert.equal(doc.querySelector('#folderBrowserTitle').textContent, 'Select a folder');
});

test('bulk add from New Pipeline selects the first added project in the dropdown', async () => {
  let posted = null;
  const { window } = await boot({
    fetchHandler: (u, opts) => {
      if (u.endsWith('/api/projects/bulk')) {
        posted = JSON.parse(opts.body);
        const projects = [
          { key: 'a-1', name: 'a', path: '/home/me/a', exists: true },
          { key: 'b-2', name: 'b', path: '/home/me/dev/b', exists: true },
        ];
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ projects, results: [
          { index: 0, status: 'added', name: 'a', path: '/home/me/a' },
          { index: 1, status: 'added', name: 'b', path: '/home/me/dev/b' },
        ] }) });
      }
      return dirsHandler({ status: 'picked', path: '/home/me/a', paths: ['/home/me/a', '/home/me/dev/b'] })(u, opts);
    },
  });
  openAddForm(window);
  const doc = window.document;
  click(window, doc.querySelector('#newProjectBrowse'));
  await tick(); await tick();
  click(window, doc.querySelector('#proj-bulk-save'));
  await tick(); await tick(); await tick();
  assert.deepEqual(posted, { projects: [{ name: 'a', path: '/home/me/a' }, { name: 'b', path: '/home/me/dev/b' }] });
  assert.ok(doc.querySelector('#project-bulk-modal').classList.contains('hidden'), 'all added -> dialog closes');
  const sel = doc.querySelector('#projectSelect');
  assert.equal(sel.options[sel.selectedIndex].dataset.name, 'a');
});
