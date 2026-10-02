// test/mcp-view-notify.test.mjs — #555 §7.1: the MCP view reports a write's result through an
// injected `notify` (a toast), keeps every message load() emits on its inline .form-msg line, and
// falls back to that line for everything when no `notify` is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMcpView } from '../ui/public/mcp-view.mjs';

const doc = new JSDOM('<!doctype html><body></body>').window.document;
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
const click = (el) => el.dispatchEvent(new doc.defaultView.Event('click', { bubbles: true }));
const change = (el) => el.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));

const SETS = [
  { id: 'general', name: 'General', group: 'general', greyed: false, home: null, serverCount: 0, problem: false, usedBy: [], members: [] },
  { id: 'billing', name: 'Billing', group: 'set', greyed: false, home: null, serverCount: 1, problem: false, usedBy: [], members: [] },
];
const MEMBER = { serverId: 'manual:pg', base: 'pg', copy: 'pg_billing', provisional: false, source: 'manual', sourceLabel: 'Manual',
  type: 'stdio', description: 'Replica', enabled: true, fields: [], reason: null, problem: null, test: null, tooLong: null };
const VIEWS = {
  general: { set: { id: 'general', name: 'General', group: 'general', greyed: false, home: null, usedBy: [] }, members: [] },
  billing: { set: { id: 'billing', name: 'Billing', group: 'set', greyed: false, home: null, usedBy: [] }, members: [MEMBER] },
};

function mount({ over = {}, notify = undefined, newer = false } = {}) {
  const toasts = [];
  const modal = { opened: null, open(title, body, actions) { this.opened = { title, body, actions }; }, close() { this.opened = null; } };
  const api = async (method, path, body) => {
    const key = `${method} ${path}`;
    if (Object.hasOwn(over, key)) return over[key];
    if (key === 'GET /api/mcp/sets') return { ok: true, status: 200, data: { newer, sets: SETS } };
    if (method === 'GET' && path.startsWith('/api/mcp/sets/')) {
      const v = VIEWS[decodeURIComponent(path.slice(14))];
      return v ? { ok: true, status: 200, data: v } : { ok: false, status: 404, data: { error: 'set not found' } };
    }
    if (key === 'GET /api/mcp/servers') return { ok: true, status: 200, data: { newer, servers: [] } };
    return { ok: true, status: 200, data: { ok: true, id: 'new-set' } };
  };
  const host = doc.createElement('section');
  doc.body.replaceChildren(host);
  const opts = { host, api, navigate: () => {}, confirm: async () => true, modal, doc, now: () => 0 };
  if (notify !== null) opts.notify = (o) => toasts.push(o);
  const ctl = createMcpView(opts);
  return { host, ctl, toasts, modal };
}

test('a write failure is an err toast and leaves the inline line empty', async () => {
  const { host, ctl, toasts } = mount({ over: { 'PUT /api/mcp/sets/billing/members/manual%3Apg': { ok: false, status: 404, data: { error: 'server not found' } } } });
  await ctl.show('sets/billing');
  const sw = host.querySelector('[data-toggle="manual:pg"]');
  sw.checked = false;
  change(sw);
  await settle();
  assert.deepEqual(toasts, [{ tone: 'err', title: 'server not found', detail: '' }]);
  assert.equal(host.querySelector('.form-msg').textContent, '');
});

test('a load failure stays inline (err-inline), never a toast', async () => {
  const { host, ctl, toasts } = mount();
  await ctl.show('sets/nope');
  assert.deepEqual(toasts, []);
  assert.equal(host.querySelector('.form-msg.err').textContent, 'set not found');
});

test('"need a newer Worca" from load() stays inline', async () => {
  const { host, ctl, toasts } = mount({ newer: true });
  await ctl.show('sets/billing');
  assert.deepEqual(toasts, []);
  assert.equal(host.querySelector('.form-msg.err').textContent, 'MCP registry files need a newer Worca');
  const servers = mount({ newer: true });
  await servers.ctl.show('servers');
  assert.deepEqual(servers.toasts, []);
  assert.equal(servers.host.querySelector('.form-msg.err').textContent, 'MCP registry files need a newer Worca');
});

test('removing a server from a set toasts "Server removed"; a field toggle stays state-only', async () => {
  const { host, ctl, toasts } = mount();
  await ctl.show('sets/billing');
  const sw = host.querySelector('[data-toggle="manual:pg"]');
  sw.checked = false;
  change(sw);
  await settle();
  assert.deepEqual(toasts, [], 'a toggle says nothing');
  click(host.querySelector('[data-remove="manual:pg"]'));
  await settle();
  assert.deepEqual(toasts, [{ tone: 'ok', title: 'Server removed', detail: '' }]);
});

test('set actions toast their result: renamed, duplicated, deleted', async () => {
  const { host, ctl, toasts, modal } = mount();
  await ctl.show('sets/billing');
  const named = async (act, name) => {
    click(host.querySelector(`[data-act="${act}"]`));
    await settle();
    modal.opened.body.querySelector('input').value = name;
    modal.opened.actions.find(([label]) => label === 'Save')[2]();
    await settle();
  };
  await named('rename', 'Billing 2');
  await named('duplicate', 'Billing copy');
  await ctl.show('sets/billing');
  click(host.querySelector('[data-act="delete"]'));
  await settle();
  assert.deepEqual(toasts.map((t) => t.title), ['Set renamed', 'Set duplicated', 'Set deleted']);
  assert.ok(toasts.every((t) => t.tone === 'ok'));
});

test('no notify injected: a write failure and a success text fall back to the inline line', async () => {
  const fail = mount({ notify: null, over: { 'PUT /api/mcp/sets/billing/members/manual%3Apg': { ok: false, status: 500, data: { error: 'disk full' } } } });
  await fail.ctl.show('sets/billing');
  const sw = fail.host.querySelector('[data-toggle="manual:pg"]');
  sw.checked = false;
  change(sw);
  await settle();
  assert.equal(fail.host.querySelector('.form-msg.err').textContent, 'disk full');

  const ok = mount({ notify: null });
  await ok.ctl.show('sets/billing');
  click(ok.host.querySelector('[data-remove="manual:pg"]'));
  await settle();
  assert.equal(ok.host.querySelector('.form-msg.ok').textContent, 'Server removed');
});
