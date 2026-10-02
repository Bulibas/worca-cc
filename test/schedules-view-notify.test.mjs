// test/schedules-view-notify.test.mjs — #555 §7.1 / §7.4: the Schedules view reports an action's
// result through `deps.notify` (a toast), keeps load()/loadFeed() failures on its inline line
// (err-inline), and without `deps.notify` falls back to that line.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const { window } = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost:4317/#schedules' });
for (const k of ['document', 'location', 'DOMParser']) Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true });
const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });
const { createSchedulesView } = await import('../ui/public/schedules-view.mjs');

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
const SOON = new Date(Date.now() + 3600_000).toISOString();
const summary = { target: 'project', workflowId: 'wf_default', prompt: 'p', source: null, sourceBranch: null, mock: false };
const SERIES = { id: 'sch_1', kind: 'recurring', title: 'Nightly', rule: { freq: 'daily', interval: 1, time: '02:00', tz: 'UTC' }, sentence: 'Every day at 02:00',
  tz: 'UTC', overlap: 'skip', maxFailures: 3, failureStreak: 0, ifMissed: 'run', graceMin: 360, status: 'active', pauseReason: null, nextRunAt: SOON, lastResult: null, summary };
const TICKET = { id: 't_1', kind: 'once', scheduleId: null, title: 'Upgrade', runAt: SOON, scheduledFor: SOON, status: 'scheduled', ifMissed: 'run', graceMin: 360, summary };

function mount({ routes = {}, notify = true } = {}) {
  const calls = [];
  const toasts = [];
  globalThis.fetch = async (url, init = {}) => {
    const key = `${init.method || 'GET'} ${String(url).split('?')[0]}`;
    calls.push(key);
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (Object.hasOwn(routes, key)) return json(...routes[key]);
    if (key === 'GET /api/schedules') return json(200, { schedules: [SERIES], tickets: [TICKET], counts: {} });
    if (key === 'GET /api/notifications') return json(200, { notifications: [], unread: 0 });
    if (key === 'GET /api/schedules/dependents') return json(200, { dependents: [] });
    if (key.endsWith('/run-now')) return json(200, { status: 'queued' });
    return json(200, {});
  };
  const hosts = { feedHost: document.createElement('div'), onceHost: document.createElement('div'), repeatingHost: document.createElement('div') };
  const msgEl = document.createElement('p');
  document.body.replaceChildren(hosts.feedHost, hosts.onceHost, hosts.repeatingHost, msgEl);
  const deps = { confirmModal: async () => true, targetLabel: () => '', workflowLabel: () => '' };
  if (notify) deps.notify = (o) => toasts.push(o);
  const view = createSchedulesView({ ...hosts, msgEl, deps });
  return { view, toasts, msgEl, calls, ...hosts };
}
const btn = (host, text) => [...host.querySelectorAll('button')].find((b) => b.textContent === text);

test('series actions toast their okText: Paused, Run started, Next run skipped, Schedule deleted', async () => {
  const m = mount();
  await m.view.load();
  m.repeatingHost.querySelector('.switch').click();
  await settle();
  btn(m.repeatingHost, 'Run now').click();
  await settle();
  btn(m.repeatingHost, 'Skip next').click();
  await settle();
  btn(m.repeatingHost, 'Delete').click();
  await settle();
  assert.deepEqual(m.toasts, ['Paused', 'Run started', 'Next run skipped', 'Schedule deleted'].map((title) => ({ tone: 'ok', title, detail: '' })));
  assert.equal(m.msgEl.textContent, '');
  m.view.destroy();
});

test('a paused series resumes with "Resumed"; a ticket Run now / Cancel toast "Run started" / "Schedule cancelled"', async () => {
  const m = mount({ routes: { 'GET /api/schedules': [200, { schedules: [{ ...SERIES, status: 'paused' }], tickets: [TICKET], counts: {} }] } });
  await m.view.load();
  m.repeatingHost.querySelector('.switch').click();
  await settle();
  btn(m.onceHost, 'Run now').click();
  await settle();
  btn(m.onceHost, 'Cancel').click();
  await settle();
  assert.deepEqual(m.toasts.map((t) => t.title), ['Resumed', 'Run started', 'Schedule cancelled']);
  m.view.destroy();
});

test('a failed action is an err toast', async () => {
  const m = mount({ routes: { 'POST /api/schedules/sch_1/skip-next': [409, { error: 'nothing to skip' }] } });
  await m.view.load();
  btn(m.repeatingHost, 'Skip next').click();
  await settle();
  assert.deepEqual(m.toasts, [{ tone: 'err', title: 'nothing to skip', detail: '' }]);
  assert.equal(m.msgEl.textContent, '');
  m.view.destroy();
});

test('load() and loadFeed() failures stay inline (err-inline), never a toast', async () => {
  const m = mount({ routes: { 'GET /api/schedules': [500, { error: 'store unreadable' }] } });
  await m.view.load();
  assert.deepEqual(m.toasts, []);
  assert.equal(m.msgEl.textContent, 'store unreadable');
  assert.equal(m.msgEl.className, 'form-msg err');
  m.view.destroy();

  const f = mount({ routes: { 'GET /api/notifications': [416, { error: 'feed unavailable' }] } });
  await f.view.loadFeed();
  assert.deepEqual(f.toasts, []);
  assert.equal(f.msgEl.className, 'form-msg err');
  assert.equal(f.msgEl.textContent, 'feed unavailable');
  f.view.destroy();
});

test('no deps.notify: results and failures fall back to the inline line', async () => {
  const m = mount({ notify: false, routes: { 'POST /api/schedules/sch_1/skip-next': [409, { error: 'nothing to skip' }] } });
  await m.view.load();
  m.repeatingHost.querySelector('.switch').click();
  await settle();
  assert.equal(m.msgEl.textContent, 'Paused');
  assert.equal(m.msgEl.className, 'form-msg ok');
  btn(m.repeatingHost, 'Skip next').click();
  await settle();
  assert.equal(m.msgEl.textContent, 'nothing to skip');
  assert.equal(m.msgEl.className, 'form-msg err');
  m.view.destroy();
});
