// test/scripts-view-notify.test.mjs — #555 §7.1: without an injected `notify`, the Scripts controller
// falls back to today's inline line for its results.
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
