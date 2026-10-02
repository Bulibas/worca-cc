// test/scripts-view-notify.test.mjs — #555 §7.1 / D9: the Scripts controller reports a result through
// an injected `notify` (a toast that outlives the route change), keeps progress text inline, turns a
// refused (409) Delete into one err toast instead of a second dialog, and without `notify` falls
// back to today's inline line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createScriptsController } from '../ui/public/scripts-view.mjs';

const doc = new JSDOM('<!doctype html><body></body>').window.document;
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 4; i++) await tick(); };

const SCRIPTS = [
  { key: 'shell', displayName: 'Shell', description: '', origin: 'builtin', runtime: 'shell', order: 10,
    ports: 'config', params: [], portSummary: '', caseCount: 0 },
  { key: 'runTests', displayName: 'Run tests', description: '', origin: 'user', runtime: 'node', order: 20,
    inputs: [], outputs: [], params: [], portSummary: '', caseCount: 0 },
];
const ok = (data) => ({ ok: true, status: 200, data });
function mountCtl({ notify = true, api: apiOver = {} } = {}) {
  const host = doc.createElement('div');
  const msgEl = doc.createElement('div');
  doc.body.replaceChildren(host, msgEl);
  const toasts = [];
  const asked = [];
  const api = {
    list: async () => ok({ scripts: SCRIPTS }),
    runtimes: async () => ok({ node: { ok: true }, shell: { ok: true }, python: { ok: true } }),
    remove: async () => ok({ ok: true }),
    duplicate: async (k, n) => ok({ meta: { key: n } }),
    ...apiOver,
  };
  const ctl = createScriptsController({
    host, msgEl, api, doc,
    navigate: () => {},
    confirm: async (o) => { asked.push(o); return true; },
    highlight: async (t) => t,
    ws: { send: () => {} },
    ...(notify ? { notify: (o) => toasts.push(o) } : {}),
  });
  return { host, msgEl, ctl, toasts, asked };
}

test('Duplicate: the result is an ok toast; the inline line stays empty after the route', async () => {
  const { host, msgEl, ctl, toasts } = mountCtl();
  await ctl.route('');
  host.querySelector('.script-card[data-script-key="shell"] .script-duplicate').click();
  await settle();
  assert.deepEqual(toasts, [{ tone: 'ok', title: 'Duplicated as "shellCopy".', detail: '' }]);
  assert.equal(msgEl.textContent, '');
  ctl.destroy();
});

test('Delete: the result is an ok toast', async () => {
  const { host, msgEl, ctl, toasts } = mountCtl();
  await ctl.route('');
  host.querySelector('.script-card[data-script-key="runTests"] .script-delete').click();
  await settle();
  assert.deepEqual(toasts, [{ tone: 'ok', title: 'Deleted "runTests".', detail: '' }]);
  assert.equal(msgEl.textContent, '');
  ctl.destroy();
});

test('D9: a refused (409) Delete is one err toast; confirm is asked only the delete question', async () => {
  const sentence = 'script "runTests" is placed in 2 saved workflows: Ship it, Nightly';
  const { host, ctl, toasts, asked } = mountCtl({ api: { remove: async () => ({ ok: false, status: 409, data: { error: sentence } }) } });
  await ctl.route('');
  host.querySelector('.script-card[data-script-key="runTests"] .script-delete').click();
  await settle();
  assert.equal(asked.length, 1, 'no second "Cannot delete" dialog');
  assert.equal(asked[0].title, 'Delete script');
  assert.deepEqual(toasts, [{ tone: 'err', title: 'Cannot delete script', detail: sentence, key: 'script-del-runTests' }]);
  ctl.destroy();
});

test('a failed list is an err toast with notify; progress-free inline line', async () => {
  const { msgEl, ctl, toasts } = mountCtl({ api: { list: async () => ({ ok: false, status: 500, data: { error: 'registry unreadable' } }) } });
  await ctl.route('');
  assert.deepEqual(toasts, [{ tone: 'err', title: 'registry unreadable', detail: '' }]);
  assert.equal(msgEl.textContent, '');
  assert.equal(msgEl.className, 'form-msg');
  ctl.destroy();
});

test('no notify injected: results fall back to the inline line (and survive the route)', async () => {
  const { host, msgEl, ctl } = mountCtl({ notify: false });
  await ctl.route('');
  host.querySelector('.script-card[data-script-key="shell"] .script-duplicate').click();
  await settle();
  assert.equal(msgEl.textContent, 'Duplicated as "shellCopy".');
  assert.ok(msgEl.className.includes('ok'));
  ctl.destroy();

  const failed = mountCtl({ notify: false, api: { list: async () => ({ ok: false, status: 500, data: { error: 'registry unreadable' } }) } });
  await failed.ctl.route('');
  assert.equal(failed.msgEl.textContent, 'registry unreadable');
  assert.ok(failed.msgEl.className.includes('err'));
  failed.ctl.destroy();
});
