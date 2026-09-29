// test/ui-projects-bulk-add.test.mjs
// JSDOM tests for adding several projects at once from the Projects view: native multi-pick
// -> review list -> POST /api/projects/bulk -> partial success reported per row and in #projects-msg.
// (boot/WSStub/tick/click/goProjects/PROJECTS: copied from test/ui-projects-view.test.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));

class WSStub {
  constructor() { WSStub.last = this; this.readyState = 0; this._listeners = {}; }
  send() {} close() {}
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  _open() { this.readyState = 1; (this._listeners.open || []).forEach((fn) => fn({})); }
}

const PROJECTS = [
  { name: 'alpha', path: '/Users/me/dev/alpha', exists: true, key: 'alpha-00000001' },
  { name: 'beta', path: '/Users/me/dev/beta', exists: false, key: 'beta-00000002' },
];

async function boot({ fetchHandler } = {}) {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4321/' });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  window.WebSocket = WSStub;
  window.confirm = () => true;
  window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  window.fetch = (url, opts) => {
    const u = String(url);
    if (fetchHandler) { const r = fetchHandler(u, opts || {}); if (r) return r; }
    if (u.includes('/api/projects')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ projects: PROJECTS }) });
    if (u.includes('/api/history')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ pipelines: [], ghAvailable: false }) });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ config: { steps: {}, customModels: [] }, models: [], efforts: [], branches: [], workspaces: [], agents: [], channels: [] }) });
  };
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator', 'requestAnimationFrame']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch {}
  }
  globalThis.window = window; globalThis.document = window.document;
  await import(pathToFileURL(appPath).href + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0));
  if (WSStub.last) WSStub.last._open();
  return { window };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const click = (window, node) => node.dispatchEvent(new window.Event('click', { bubbles: true }));

async function goProjects(window) {
  window.location.hash = 'projects';
  window.dispatchEvent(new window.Event('hashchange'));
  await tick(); await tick();
}

const json = (body, status = 200) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });

test('Add project with several picked folders opens the review; an already-registered folder starts unticked', async () => {
  const { window } = await boot({
    fetchHandler: (u) => (u.includes('/api/fs/pick-folder')
      ? json({ status: 'picked', path: '/Users/me/dev/cool', paths: ['/Users/me/dev/cool', '/Users/me/dev/alpha', '/Users/me/dev/zed'] })
      : null),
  });
  await goProjects(window);
  const doc = window.document;
  click(window, doc.querySelector('#project-add-btn'));
  await tick(); await tick();
  assert.ok(doc.querySelector('#project-add-modal').classList.contains('hidden'), 'single dialog not used');
  assert.ok(!doc.querySelector('#project-bulk-modal').classList.contains('hidden'));
  const rows = [...doc.querySelectorAll('#proj-bulk-list .pb-row')];
  assert.equal(rows.length, 3);
  assert.equal(rows[1].querySelector('.pb-include').checked, false, 'alpha is already registered');
  assert.match(rows[1].querySelector('.pb-status').textContent, /already registered as “alpha”/);
  assert.equal(doc.querySelector('#proj-bulk-save').textContent, 'Add 2 projects');
});

test('partial success: added rows lock, skipped rows show the reason, a rename + Add retries only those', async () => {
  const posts = [];
  let round = 0;
  const { window } = await boot({
    fetchHandler: (u, opts) => {
      // A DIFFERENT folder named beta (registered beta lives at /Users/me/dev/beta): a name clash, not a registered path.
      if (u.includes('/api/fs/pick-folder')) return json({ status: 'picked', path: '/Users/me/dev/cool', paths: ['/Users/me/dev/cool', '/Users/me/other/beta'] });
      if (u.endsWith('/api/projects/bulk')) {
        posts.push(JSON.parse(opts.body));
        round += 1;
        if (round === 1) {
          return json({ projects: [...PROJECTS, { key: 'cool-1', name: 'cool', path: '/Users/me/dev/cool', exists: true }], results: [
            { index: 0, status: 'added', name: 'cool', path: '/Users/me/dev/cool' },
            { index: 1, status: 'skipped', name: 'beta', path: '/Users/me/other/beta', reason: 'a project named "beta" already exists' },
          ] });
        }
        return json({ projects: [...PROJECTS], results: [{ index: 0, status: 'added', name: 'beta-2', path: '/Users/me/other/beta' }] });
      }
      return null;
    },
  });
  await goProjects(window);
  const doc = window.document;
  click(window, doc.querySelector('#project-add-btn'));
  await tick(); await tick();
  click(window, doc.querySelector('#proj-bulk-save'));
  await tick(); await tick(); await tick();
  assert.equal(posts[0].projects.length, 2);
  assert.ok(!doc.querySelector('#project-bulk-modal').classList.contains('hidden'), 'stays open with a skipped row');
  let rows = [...doc.querySelectorAll('#proj-bulk-list .pb-row')];
  assert.ok(rows[0].classList.contains('added'));
  assert.equal(rows[0].querySelector('.pb-name').disabled, true);
  assert.match(rows[1].querySelector('.pb-status').textContent, /already exists/);
  assert.match(doc.querySelector('#proj-bulk-msg').textContent, /Added 1\. 1 could not be added/);

  const name = rows[1].querySelector('.pb-name');
  name.value = 'beta-2'; name.dispatchEvent(new window.Event('input', { bubbles: true }));
  click(window, doc.querySelector('#proj-bulk-save'));
  await tick(); await tick(); await tick();
  assert.deepEqual(posts[1], { projects: [{ name: 'beta-2', path: '/Users/me/other/beta' }] }, 'only the skipped row is re-sent');
  assert.ok(doc.querySelector('#project-bulk-modal').classList.contains('hidden'), 'nothing left skipped -> closes');
  assert.match(doc.querySelector('#projects-msg').textContent, /Added 2 projects\./);
});

test('closing with a skipped row reports it in #projects-msg as a warning', async () => {
  const { window } = await boot({
    fetchHandler: (u) => {
      if (u.includes('/api/fs/pick-folder')) return json({ status: 'picked', path: '/Users/me/dev/x', paths: ['/Users/me/dev/x', '/Users/me/dev/gone'] });
      if (u.endsWith('/api/projects/bulk')) {
        return json({ projects: PROJECTS, results: [
          { index: 0, status: 'added', name: 'x', path: '/Users/me/dev/x' },
          { index: 1, status: 'skipped', name: 'gone', path: '/Users/me/dev/gone', reason: 'folder does not exist' },
        ] });
      }
      return null;
    },
  });
  await goProjects(window);
  const doc = window.document;
  click(window, doc.querySelector('#project-add-btn'));
  await tick(); await tick();
  click(window, doc.querySelector('#proj-bulk-save'));
  await tick(); await tick(); await tick();
  click(window, doc.querySelector('#proj-bulk-close'));
  const msg = doc.querySelector('#projects-msg');
  assert.equal(msg.textContent, 'Added “x”. Skipped 1: gone (folder does not exist).');
  assert.ok(msg.classList.contains('warn'));
});

test('unticking every row disables Add; Escape closes without a request', async () => {
  let posted = 0;
  const { window } = await boot({
    fetchHandler: (u) => {
      if (u.includes('/api/fs/pick-folder')) return json({ status: 'picked', path: '/a/one', paths: ['/a/one', '/a/two'] });
      if (u.endsWith('/api/projects/bulk')) { posted += 1; return json({ projects: PROJECTS, results: [] }); }
      return null;
    },
  });
  await goProjects(window);
  const doc = window.document;
  click(window, doc.querySelector('#project-add-btn'));
  await tick(); await tick();
  for (const cb of doc.querySelectorAll('#proj-bulk-list .pb-include')) { cb.checked = false; cb.dispatchEvent(new window.Event('change', { bubbles: true })); }
  assert.equal(doc.querySelector('#proj-bulk-save').disabled, true);
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.ok(doc.querySelector('#project-bulk-modal').classList.contains('hidden'));
  assert.equal(posted, 0);
  assert.equal(doc.querySelector('#projects-msg').textContent, '', 'nothing added, nothing skipped -> no message');
});

test('a single native pick keeps the single Add dialog (unchanged flow)', async () => {
  const { window } = await boot({
    fetchHandler: (u) => (u.includes('/api/fs/pick-folder') ? json({ status: 'picked', path: '/Users/me/dev/solo', paths: ['/Users/me/dev/solo'] }) : null),
  });
  await goProjects(window);
  const doc = window.document;
  click(window, doc.querySelector('#project-add-btn'));
  await tick(); await tick();
  assert.ok(!doc.querySelector('#project-add-modal').classList.contains('hidden'));
  assert.equal(doc.querySelector('#proj-add-path').value, '/Users/me/dev/solo');
  assert.ok(doc.querySelector('#project-bulk-modal').classList.contains('hidden'));
});

test('Choose folder… with several native picks swaps the Add dialog for the review list', async () => {
  const { window } = await boot({
    fetchHandler: (u) => (u.includes('/api/fs/pick-folder') ? json({ status: 'picked', path: '/p/a', paths: ['/p/a', '/p/b'] }) : null),
  });
  await goProjects(window);
  const doc = window.document;
  window.__projects.openProjectAddModal('');
  click(window, doc.querySelector('#proj-add-browse'));
  await tick(); await tick();
  assert.ok(doc.querySelector('#project-add-modal').classList.contains('hidden'));
  assert.ok(!doc.querySelector('#project-bulk-modal').classList.contains('hidden'));
});

test('project names from the folder go in as text, never HTML', async () => {
  const { window } = await boot({
    fetchHandler: (u) => (u.includes('/api/fs/pick-folder') ? json({ status: 'picked', path: '/p/<img src=x>', paths: ['/p/<img src=x>', '/p/b'] }) : null),
  });
  await goProjects(window);
  const doc = window.document;
  click(window, doc.querySelector('#project-add-btn'));
  await tick(); await tick();
  assert.equal(doc.querySelector('#proj-bulk-list img'), null);
  assert.equal(doc.querySelector('#proj-bulk-list .pb-path').textContent, '/p/<img src=x>');
});
