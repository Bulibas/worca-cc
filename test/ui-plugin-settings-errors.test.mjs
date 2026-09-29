// test/ui-plugin-settings-errors.test.mjs — a failure inside the plugin Settings
// modal is reported INSIDE it, and the user's typing survives:
//   1. a rejected Save keeps the modal open and shows the error in it (it used
//      to close the modal and post the error on the Plugins page behind it);
//   2. a rejected profile Add re-asks with the typed id and the error, instead
//      of dropping both and posting the error behind the Settings modal;
//   3. a rejected profile Remove is reported in the Settings modal too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));

const json = (body, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: async () => body });

// Boot app.js in jsdom with a controllable fetch (mirrors ui-plugin-connect).
async function boot(handlers) {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4319/' });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  window.WebSocket = class {
    constructor() { this.readyState = 1; this._listeners = {}; }
    send() {} close() {}
    addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
  };
  window.fetch = (url, opts) => {
    const u = String(url);
    for (const [prefix, fn] of Object.entries(handlers)) {
      if (u.includes(prefix)) return fn(u, opts || {});
    }
    if (u.includes('/api/projects')) return json({ projects: [] });
    if (u.includes('/api/sources') && !u.includes('/call')) return json({ sources: [] });
    if (u.includes('/api/workflows')) return json({ workflows: [] });
    return json({ config: { steps: {}, customModels: [] }, models: [], efforts: [], branches: [] });
  };
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator', 'HTMLInputElement', 'HTMLSelectElement']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch {}
  }
  globalThis.window = window; globalThis.document = window.document;
  await import(pathToFileURL(appPath).href + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0));
  return { window };
}

async function waitFor(fn, what, { timeoutMs = 3000, everyMs = 10 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

function openSettings(doc, name) {
  const btn = doc.createElement('button');
  btn.className = 'pl-settings';
  btn.dataset.name = name;
  doc.querySelector('#plugins-list').appendChild(btn);
  btn.click();
}

const modalOpen = (doc, id) => !doc.getElementById(id).classList.contains('hidden');
const actionBtn = (doc, label) =>
  [...doc.querySelectorAll('#plugin-modal-actions button')].find((b) => b.textContent === label);

test('a rejected Save keeps the Settings modal open and shows the error inside it', async () => {
  let reject = true;
  const puts = [];
  const { window } = await boot({
    '/api/plugins/jira/config': (u, opts) => {
      if ((opts.method || 'GET') === 'PUT') {
        puts.push(JSON.parse(opts.body));
        return reject ? json({ error: 'sampleUrl must be an http(s) URL' }, 400) : json({ ok: true });
      }
      return json({
        sources: [{ id: 'jira', schema: [{ key: 'sampleUrl', type: 'text', label: 'Sample ticket URL' }], values: {} }],
        channels: [],
      });
    },
  });
  const doc = window.document;

  openSettings(doc, 'jira');
  await waitFor(() => modalOpen(doc, 'plugin-modal') && actionBtn(doc, 'Save'), 'the settings modal');
  const input = doc.querySelector('#plugin-modal-body input[data-key="sampleUrl"]');
  input.value = 'not a url';
  actionBtn(doc, 'Save').click();

  const err = await waitFor(() => {
    const e = doc.querySelector('#plugin-modal-body .pl-settings-err');
    return e && !e.hidden && e.textContent ? e : null;
  }, 'the in-modal error');
  assert.match(err.textContent, /sampleUrl must be an http\(s\) URL/);
  assert.ok(modalOpen(doc, 'plugin-modal'), 'the modal stays open');
  assert.equal(doc.querySelector('#plugin-modal-body input[data-key="sampleUrl"]').value, 'not a url',
    'the typed value is still there to correct');
  assert.equal(doc.getElementById('plugins-msg').textContent, '', 'nothing posted behind the modal');

  reject = false;
  input.value = 'https://tracker.example.com/browse/PROJ-1';
  actionBtn(doc, 'Save').click();
  await waitFor(() => !modalOpen(doc, 'plugin-modal'), 'the modal to close on success');
  assert.equal(doc.getElementById('plugins-msg').textContent, 'Settings saved.');
  assert.equal(puts.at(-1).values.sampleUrl, 'https://tracker.example.com/browse/PROJ-1');
});

// The prompt's required-field guard listens for `input`; a bare .value write
// would leave Create disabled.
function type(doc, id, value) {
  const inp = doc.getElementById(id);
  inp.value = value;
  inp.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
}

const multiProfileConfig = () => json({
  sources: [{
    id: 'jira', multiProfile: true, profile: 'work', profiles: [{ id: 'work', label: 'Work' }],
    schema: [{ key: 'sampleUrl', type: 'text', label: 'Sample ticket URL' }], values: {},
  }],
  channels: [],
});

test('a rejected profile Add re-asks with the typed id and the error; nothing lands behind the modal', async () => {
  const posts = [];
  const { window } = await boot({
    '/api/plugins/jira/profiles': (u, opts) => {
      const body = JSON.parse(opts.body);
      posts.push(body);
      return body.id === 'Bad Id'
        ? json({ error: 'profile id must be lowercase letters, digits and dashes' }, 400)
        : json({ ok: true, profile: { id: body.id } });
    },
    '/api/plugins/jira/config': () => multiProfileConfig(),
  });
  const doc = window.document;

  openSettings(doc, 'jira');
  await waitFor(() => modalOpen(doc, 'plugin-modal') && doc.querySelector('.pl-profile-add'), 'the settings modal');
  doc.querySelector('.pl-profile-add').click();
  await waitFor(() => modalOpen(doc, 'confirm-modal'), 'the New profile prompt');
  type(doc, 'confirm-f-id', 'Bad Id');
  type(doc, 'confirm-f-label', 'My label');
  doc.getElementById('confirm-ok').click();

  await waitFor(() => posts.length === 1 && modalOpen(doc, 'confirm-modal')
    && doc.getElementById('confirm-f-id'), 'the prompt to re-open');
  assert.match(doc.getElementById('confirm-message').textContent, /profile id must be lowercase letters/);
  assert.equal(doc.getElementById('confirm-message').hidden, false);
  assert.equal(doc.getElementById('confirm-f-id').value, 'Bad Id', 'the typed id survives');
  assert.equal(doc.getElementById('confirm-f-label').value, 'My label', 'the typed label survives');
  assert.ok(modalOpen(doc, 'plugin-modal'), 'the Settings modal is still open underneath');
  assert.equal(doc.getElementById('plugins-msg').textContent, '', 'nothing posted behind the modal');

  type(doc, 'confirm-f-id', 'good-id');
  doc.getElementById('confirm-ok').click();
  await waitFor(() => posts.length === 2 && !modalOpen(doc, 'confirm-modal'), 'the second attempt');
  assert.deepEqual(posts[1], { sourceId: 'jira', id: 'good-id', label: 'My label' });
  assert.equal(doc.getElementById('plugins-msg').textContent, '');
});

test('a rejected profile Remove is reported inside the Settings modal', async () => {
  const { window } = await boot({
    '/api/plugins/jira/profiles/': () => json({ error: 'profile is locked by the team policy' }, 409),
    '/api/plugins/jira/config': () => multiProfileConfig(),
  });
  const doc = window.document;

  openSettings(doc, 'jira');
  await waitFor(() => modalOpen(doc, 'plugin-modal') && doc.querySelector('.pl-profile-del'), 'the settings modal');
  doc.querySelector('.pl-profile-del').click();
  await waitFor(() => modalOpen(doc, 'confirm-modal'), 'the delete confirmation');
  doc.getElementById('confirm-ok').click();

  const err = await waitFor(() => {
    const e = doc.querySelector('#plugin-modal-body .pl-settings-err');
    return e && !e.hidden && e.textContent ? e : null;
  }, 'the in-modal error');
  assert.match(err.textContent, /profile is locked by the team policy/);
  assert.ok(modalOpen(doc, 'plugin-modal'));
  assert.equal(doc.getElementById('plugins-msg').textContent, '', 'nothing posted behind the modal');
});
