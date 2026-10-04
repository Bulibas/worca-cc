// test/actions-view.test.mjs — pure jsdom tests for the Actions renderers (issue #529).
// No app.js boot: every renderer takes `doc` explicitly and returns detached DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { memberViewState, renderActionsCard, renderOverviewStrip, renderRunPill, renderShipItStrip,
  renderRunningActionsCard, historyActionBadges, formatUptime, isSafeHref, createActionsController } from '../ui/public/actions-view.mjs';

const doc = new JSDOM('<!doctype html><body></body>').window.document;
const member = (over = {}) => ({ projectKey: 'app-0cea65fb', projectName: 'app', branch: 'worca-cc/x', worktreeDir: '/h/runs/ab/repos/app-0cea65fb',
  checkout: null, copyCommand: 'cd "/p"\ngit switch worca-cc/x', setup: 'npm ci',
  actions: [{ id: 'run', label: 'Run', kind: 'service' }, { id: 'test', label: 'Test', kind: 'task' }],
  builtins: [{ key: 'editor', label: 'VS Code' }, { key: 'terminal', label: 'Terminal' }, { key: 'fileManager', label: 'Finder' }, { key: 'copyCommand', label: 'Copy command' }], ...over });
const model = (m, instances = []) => ({ enabled: true, finished: true, workspace: false, estimate: { lastSetupMs: 42000 }, members: [m], stacks: [], stackStates: [], instances });
// A button's accessible name (aria-label when it has one: the stop button reads "Stop Run"); icon-only copy buttons are left out.
const labelsOf = (el) => [...el.querySelectorAll('button:not(.act-copy)')].map((b) => b.getAttribute('aria-label') || b.textContent);

test('four states (plus pending / interrupted setup)', () => {
  assert.equal(memberViewState(member(), []), 'not-checked-out');
  assert.equal(memberViewState(member({ checkout: { setup: { status: 'running' } } }), []), 'setting-up');
  assert.equal(memberViewState(member({ checkout: { setup: { status: 'pending' } }, setupQueued: true }), []), 'setting-up');
  // a kept-by-policy checkout: setup has not run yet and nothing is queued → usable, not stuck
  assert.equal(memberViewState(member({ checkout: { setup: { status: 'pending' } } }), []), 'ready');
  assert.equal(memberViewState(member({ checkout: { setup: { status: 'interrupted' } } }), []), 'setup-failed');
  const run = { instanceId: 'i', member: 'app-0cea65fb', actionId: 'run', kind: 'service', status: 'ready', ports: { PORT: 4417 }, url: 'http://localhost:4417', startedAt: 0 };
  assert.equal(memberViewState(member({ checkout: { setup: { status: 'ok' } } }), [run]), 'running');
  const task = { instanceId: 't', member: 'app-0cea65fb', actionId: 'test', kind: 'task', status: 'exited', exitCode: 1 };
  assert.equal(memberViewState(member({ checkout: { setup: { status: 'ok' } } }), [task]), 'task-result');
});

test('not checked out: folder to come, estimate, Check out + Copy command, the other built-ins check out first', () => {
  const el = renderActionsCard(model(member()), { doc, handlers: {} });
  assert.doesNotMatch(el.textContent, /\/h\/runs\/ab\/repos\/app-0cea65fb/, 'no folder path before it exists');
  assert.match(el.querySelector('.act-meta').textContent, /FolderCreated when you check out/);
  assert.match(el.querySelector('.act-apps').textContent, /^Check out takes about 42 s\./);
  assert.deepEqual(labelsOf(el), ['Check out', 'Copy command', 'VS Code', 'Terminal', 'Finder']);
  const opens = [...el.querySelectorAll('button')].filter((b) => ['VS Code', 'Terminal', 'Finder'].includes(b.textContent));
  assert.ok(opens.every((b) => !b.disabled && b.title.startsWith('Check out first (asks), then: ')));
  assert.equal(opens.find((b) => b.textContent === 'Terminal').title, 'Check out first (asks), then: open Terminal in the checkout');
  assert.match(el.textContent, /VS Code, Terminal and Finder open the checkout, so they check out first\./);
  const seen = [];
  const el2 = renderActionsCard(model(member()), { doc, handlers: { onOpenBeforeCheckout: (...a) => seen.push(a) } });
  [...el2.querySelectorAll('button')].find((b) => b.textContent === 'Terminal').click();
  assert.deepEqual(seen, [['app-0cea65fb', 'terminal', 'Terminal']]);
  const ws = model(member()); ws.workspace = true;
  const wsEl = renderActionsCard(ws, { doc, handlers: {} });
  assert.ok([...wsEl.querySelectorAll('button')].filter((b) => b.textContent === 'Terminal').every((b) => b.disabled && b.title === 'Available after Check out'),
    'a workspace run checks out from its checklist');
});

test('an editor that is not there is not mentioned on the run card: only what opens is named (no nagging)', () => {
  const m = member({ builtins: [{ key: 'terminal', label: 'Terminal' }, { key: 'copyCommand', label: 'Copy command' }] });
  const before = renderActionsCard(model(m), { doc, handlers: {} });
  assert.doesNotMatch(before.textContent, /editor was found|No editor/i);
  assert.match(before.querySelector('.act-apps').textContent, /Terminal open the checkout, so they check out first\. Change the terminal in Settings › Runs › Actions\.$/);
  const after = renderActionsCard(model({ ...m, checkout: { setup: { status: 'ok' } } }), { doc, handlers: {} });
  assert.equal(after.querySelector('.act-apps').textContent, 'Opens in Terminal. Change it in Settings › Runs › Actions.');
  const none = renderActionsCard(model(member({ builtins: [{ key: 'copyCommand', label: 'Copy command' }], checkout: { setup: { status: 'ok' } } })), { doc, handlers: {} });
  assert.equal(none.querySelector('.act-apps'), null, 'no editor and no terminal: nothing to say');
});

test('running: Stop Run, Test, built-ins, open link, Discard', () => {
  const run = { instanceId: 'i', member: 'app-0cea65fb', actionId: 'run', kind: 'service', status: 'ready', ports: { PORT: 4417 }, url: 'http://localhost:4417', startedAt: Date.now() - 65000 };
  const el = renderActionsCard(model(member({ checkout: { setup: { status: 'ok' } } }), [run]), { doc, handlers: {} });
  const labels = labelsOf(el);
  const stop = el.querySelector('.act-stop-btn');
  assert.equal(stop.textContent, 'Run', 'the service name, not "Stop Run"');
  assert.ok(stop.querySelector('svg rect') && stop.classList.contains('btn-danger'), 'a stop square, in the stop colour');
  assert.equal(stop.title, 'Stop Run and free its port');
  for (const l of ['Stop Run', 'Test', 'VS Code', 'Terminal', 'Finder', 'Copy command', 'Discard']) assert.ok(labels.includes(l), l);
  assert.equal(el.querySelector('a.act-open').getAttribute('href'), 'http://localhost:4417');
  assert.equal(el.querySelector('a.act-open').getAttribute('rel'), 'noopener noreferrer');
});

test('an unsafe url is never rendered as a link (D24, defence in depth)', () => {
  const run = { instanceId: 'i', member: 'app-0cea65fb', actionId: 'run', kind: 'service', status: 'ready', ports: { PORT: 4417 }, url: 'javascript:alert(1)', startedAt: 0 };
  const el = renderActionsCard(model(member({ checkout: { setup: { status: 'ok' } } }), [run]), { doc, handlers: {} });
  assert.equal(el.querySelector('a.act-open'), null);
  assert.equal(isSafeHref('http://localhost:1'), true);
  assert.equal(isSafeHref(' JAVASCRIPT:x'), false);
});

test('ready with setup pending: action buttons shown, with the "Setup runs before the first action" note', () => {
  const el = renderActionsCard(model(member({ checkout: { setup: { status: 'pending' } } })), { doc, handlers: {} });
  const labels = labelsOf(el);
  assert.ok(labels.includes('Run') && labels.includes('Test'));
  assert.match(el.textContent, /Setup runs before the first action/);
});

test('run not finished (interrupted / paused): no Check out, a hint', () => {
  const m = model(member()); m.finished = false; m.runStatus = 'interrupted';
  const el = renderActionsCard(m, { doc, handlers: {} });
  assert.match(el.textContent, /Check out is available once the run has finished\./);
  assert.doesNotMatch(el.textContent, /stop the run/);
  assert.equal(labelsOf(el).some((t) => t === 'Check out'), false);
});

test('skipped setup with actions enabled offers "Run setup"', () => {
  const el = renderActionsCard(model(member({ checkout: { setup: { status: 'skipped' } } })), { doc, handlers: {} });
  assert.ok(labelsOf(el).some((t) => t === 'Run setup'));
});

test('disabled (hosted): actions and built-ins hidden, Check out and Copy command kept', () => {
  const m = model(member()); m.enabled = false;
  const el = renderActionsCard(m, { doc, handlers: {} });
  assert.match(el.textContent, /turned off on this hosted deployment/);
  assert.deepEqual(labelsOf(el), ['Check out', 'Copy command']);
});

test('pill, sidebar card, history badges', () => {
  const run = { instanceId: 'i', runId: 'ab12cd34', member: 'app-0cea65fb', label: 'Run', kind: 'service', status: 'ready', ports: { PORT: 4417 }, url: 'http://localhost:4417' };
  assert.equal(renderRunPill([run], { doc }).textContent, 'Run :4417');
  assert.equal(renderRunPill([], { doc }), null);
  assert.equal(renderRunPill([{ ...run, ports: {} }], { doc }).textContent, 'Run');   // no port variable
  assert.deepEqual(historyActionBadges({ id: 'ab12cd34', checkout: null }, [{ ...run, ports: {} }]).map((b) => b.text), ['Running']);
  const card = renderRunningActionsCard([run], { doc, titleOf: () => 'Fix login' });
  assert.match(card.textContent, /Running actions/); assert.match(card.textContent, /:4417/);
  assert.deepEqual(historyActionBadges({ id: 'ab12cd34', checkout: { members: [{ policy: 'on-success' }, { policy: 'on-success' }] } }, [run]).map((b) => b.text),
    ['Running :4417', '2 checked out', 'Kept · on success']);
  assert.equal(formatUptime(3_723_000), '1h 2m');
  assert.equal(renderOverviewStrip(undefined, { doc }), null);
});

// ── Beyond the plan's pinned cases: the remaining renderers and the controller ──

test('every member state renders a section.act-card, including no-branch', () => {
  const el = renderActionsCard(model(member({ branch: null, copyCommand: null })), { doc, handlers: {} });
  assert.equal(el.querySelectorAll('section.card.act-card').length, 1);
  assert.match(el.querySelector('.act-meta').textContent, /BranchNone: this run made no branch/);
});

test('setup failed: exit code and "Run setup again"', () => {
  const el = renderActionsCard(model(member({ checkout: { setup: { status: 'failed', exitCode: 2 } } })), { doc, handlers: {} });
  assert.match(el.textContent, /exit 2/);
  assert.ok(labelsOf(el).includes('Run setup again'));
});

test('task result shows the exit code; a queued start reads "Starts after setup"', () => {
  const task = { instanceId: 't', member: 'app-0cea65fb', actionId: 'test', label: 'Test', kind: 'task', status: 'exited', exitCode: 1 };
  const el = renderActionsCard(model(member({ checkout: { setup: { status: 'ok' } } }), [task]), { doc, handlers: {}, queued: new Set(['app-0cea65fb:run']) });
  assert.match(el.querySelector('.act-exit.fail').textContent, /exit 1/);
  assert.ok(labelsOf(el).includes('Starts after setup'));
});

test('handlers receive the member and action ids', () => {
  const calls = [];
  const handlers = { onStart: (m, a) => calls.push(['start', m, a]), onBuiltin: (m, k) => calls.push(['builtin', m, k]),
    onCopy: (t) => calls.push(['copy', t]), onDiscard: (ms) => calls.push(['discard', ms]) };
  const el = renderActionsCard(model(member({ checkout: { setup: { status: 'ok' } } })), { doc, handlers });
  const click = (label) => [...el.querySelectorAll('button')].find((b) => b.textContent === label).click();
  click('Test'); click('VS Code'); click('Copy command'); click('Discard');
  assert.deepEqual(calls, [['start', 'app-0cea65fb', 'test'], ['builtin', 'app-0cea65fb', 'editor'],
    ['copy', 'cd "/p"\ngit switch worca-cc/x'], ['discard', ['app-0cea65fb']]]);
});

test('workspace: member checkboxes, "Check out selected", stack rows', () => {
  const api = member({ projectKey: 'api-1a2b3c4d', projectName: 'api' });
  const web = member({ projectKey: 'web-5e6f7a8b', projectName: 'web' });
  const m = { ...model(api), workspace: true, members: [api, web], stacks: [{ id: 'dev', label: 'Dev stack', kind: 'service' }],
    stackStates: [{ runId: 'ab', stackId: 'dev', status: 'running' }] };
  const got = [];
  const el = renderActionsCard(m, { doc, handlers: { onCheckout: (ms) => got.push(ms), onStack: (id, op) => got.push([id, op]) } });
  assert.equal(el.querySelectorAll('.act-members input[type="checkbox"]').length, 2);
  el.querySelectorAll('.act-members input[type="checkbox"]')[1].checked = false;
  [...el.querySelectorAll('button')].find((b) => b.textContent === 'Check out selected').click();
  [...el.querySelectorAll('button')].find((b) => b.textContent === 'Stop stack').click();
  assert.deepEqual(got, [['api-1a2b3c4d'], ['dev', 'stop']]);
  assert.equal(el.querySelectorAll('section.act-card').length, 2);
  assert.equal(labelsOf(el).filter((t) => t === 'Check out').length, 0);
});

test('overview strip: Check out, then open link + Stop while a service runs; null without a branch', () => {
  const calls = [];
  const handlers = { onCheckout: () => calls.push('checkout'), onStop: (m, a) => calls.push(['stop', m, a]), onOpenTab: () => calls.push('tab') };
  const a = renderOverviewStrip(model(member()), { doc, handlers });
  assert.deepEqual(labelsOf(a), ['Check out', 'Open tab ›']);
  a.querySelector('button').click();
  const run = { instanceId: 'i', member: 'app-0cea65fb', actionId: 'run', label: 'Run', kind: 'service', status: 'ready', ports: { PORT: 4417 }, url: 'http://localhost:4417' };
  const b = renderOverviewStrip(model(member({ checkout: { setup: { status: 'ok' } } }), [run]), { doc, handlers });
  assert.equal(b.querySelector('a.act-open').textContent, 'Open :4417');
  [...b.querySelectorAll('button')].find((x) => x.textContent === 'Stop').click();
  [...b.querySelectorAll('button')].find((x) => x.textContent === 'Open tab ›').click();
  assert.deepEqual(calls, ['checkout', ['stop', 'app-0cea65fb', 'run'], 'tab']);
  assert.equal(renderOverviewStrip(model(member({ branch: null })), { doc, handlers }), null);
});

test('ship it strip: Check out, or Open / actions / Editor / Stop', () => {
  assert.equal(renderShipItStrip(undefined, { doc }), null);
  assert.ok(labelsOf(renderShipItStrip(model(member()), { doc, handlers: {} })).includes('Check out'));
  const run = { instanceId: 'i', member: 'app-0cea65fb', actionId: 'run', label: 'Run', kind: 'service', status: 'ready', ports: { PORT: 4417 }, url: 'http://localhost:4417' };
  const el = renderShipItStrip(model(member({ checkout: { setup: { status: 'ok' } } }), [run]), { doc, handlers: {} });
  assert.equal(el.querySelector('a.act-open').textContent, 'Open :4417');
  const labels = labelsOf(el);
  for (const l of ['Test', 'VS Code', 'Stop']) assert.ok(labels.includes(l), l);
});

test('running actions card: null when empty, Stop and row callbacks', () => {
  assert.equal(renderRunningActionsCard([], { doc }), null);
  const run = { instanceId: 'i', runId: 'ab12cd34', member: 'app-0cea65fb', label: 'Run', kind: 'service', status: 'ready', ports: { PORT: 4417 }, startedAt: Date.now() - 5000 };
  const got = [];
  const card = renderRunningActionsCard([run], { doc, titleOf: (s) => s.runId, onStop: (s) => got.push(['stop', s.instanceId]), onOpen: (s) => got.push(['open', s.runId]) });
  card.querySelector('button.act-stop').click();
  card.querySelector('.act-running-title').click();
  assert.deepEqual(got, [['stop', 'i'], ['open', 'ab12cd34']]);
  assert.equal(formatUptime(5000), '5s');
  assert.equal(formatUptime(65000), '1m 5s');
});

test('history badges: on-demand checkout is not "Kept"; one member reads "Checked out"', () => {
  assert.deepEqual(historyActionBadges({ id: 'x', checkout: { members: [{ policy: 'on-demand' }] } }, []).map((b) => b.text), ['Checked out']);
  assert.deepEqual(historyActionBadges({ id: 'x', checkout: { members: [{ policy: 'until-pr' }] } }, []).map((b) => b.text), ['Checked out', 'Kept · until PR']);
  assert.deepEqual(historyActionBadges({ id: 'x' }, []), []);
});

function fakeApi(routes) {
  const calls = [];
  const api = async (method, url, body) => {
    calls.push([method, url, body]);
    const r = routes(method, url, body, calls);
    return r || { ok: true, status: 200, data: {} };
  };
  return { api, calls };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('controller: refresh renders, subscribes every instance, dedupes frames, appends log lines in place', async () => {
  const run = { instanceId: 'act:ab:app-0cea65fb:run', runId: 'ab', member: 'app-0cea65fb', actionId: 'run', label: 'Run', kind: 'service', status: 'ready', ports: { PORT: 4417 }, url: 'http://localhost:4417', startedAt: Date.now() };
  const m = model(member({ checkout: { setup: { status: 'ok' } } }), [run]);
  const { api } = fakeApi((method, url) => (method === 'GET' ? { ok: true, status: 200, data: m } : null));
  const sent = []; const models = [];
  const host = doc.createElement('div');
  const ctl = createActionsController({ runId: 'ab', scopeQuery: 'projectKey=app', api, ws: { send: (o) => sent.push(o) }, host, doc,
    confirm: async () => true, navigate: () => {}, onModel: (x) => models.push(x) });
  assert.equal(ctl.runId, 'ab');
  await ctl.refresh();
  assert.deepEqual(sent, [{ type: 'subscribe', instanceId: run.instanceId }]);
  assert.equal(models.length, 1);
  assert.ok(labelsOf(host).includes('Stop Run'));
  const pre = host.querySelector('pre.act-log');
  assert.equal(pre.dataset.instanceId, run.instanceId);
  ctl.onFrame({ type: 'action-line', instanceId: run.instanceId, stream: 'out', text: 'listening', seq: 1 });
  ctl.onFrame({ type: 'action-line', instanceId: run.instanceId, stream: 'out', text: 'listening', seq: 1 });   // replay duplicate
  ctl.onFrame({ type: 'action-line', instanceId: 'act:other:x:run', stream: 'out', text: 'not mine', seq: 2 });
  assert.equal(host.querySelector('pre.act-log'), pre, 'no re-render on a line');
  assert.equal(pre.textContent, 'listening\n');
  ctl.onFrame({ type: 'action-status', instanceId: run.instanceId, snapshot: { ...run, status: 'stopped' }, seq: 2 });
  assert.ok(labelsOf(host).includes('Run'));
  assert.match(host.querySelector('pre.act-log').textContent, /listening/, 'the tail survives a re-render');
  ctl.destroy();
  assert.equal(host.childNodes.length, 0);
});

test('controller: 202 start subscribes at once and shows "Starts after setup"', async () => {
  const m = model(member({ checkout: { setup: { status: 'pending' } } }));
  const { api, calls } = fakeApi((method) => (method === 'GET' ? { ok: true, status: 200, data: m }
    : { ok: true, status: 202, data: { queued: true, instanceId: 'act:ab:app-0cea65fb:run' } }));
  const sent = [];
  const host = doc.createElement('div');
  const ctl = createActionsController({ runId: 'ab', scopeQuery: 'projectKey=app', api, ws: { send: (o) => sent.push(o) }, host, doc,
    confirm: async () => true, navigate: () => {}, onModel: () => {} });
  await ctl.refresh();
  [...host.querySelectorAll('button')].find((b) => b.textContent === 'Run').click();
  await tick(); await tick();
  assert.deepEqual(calls[1], ['POST', '/api/runs/ab/actions/run/start?projectKey=app', { member: 'app-0cea65fb' }]);
  assert.deepEqual(sent.at(-1), { type: 'subscribe', instanceId: 'act:ab:app-0cea65fb:run' });
  assert.ok(labelsOf(host).includes('Starts after setup'));
  ctl.destroy();
});

test('controller: a queued start that cannot start leaves "Starts after setup"', async () => {
  // While setup runs the start waits; once setup settled with no instance for it, a refresh drops the wait.
  let m = model(member({ checkout: { setup: { status: 'pending' } } }));   // a kept checkout: setup not run yet
  const { api } = fakeApi((method) => (method === 'GET' ? { ok: true, status: 200, data: m }
    : { ok: true, status: 202, data: { queued: true, instanceId: 'act:ab:app-0cea65fb:run' } }));
  const host = doc.createElement('div');
  const ctl = createActionsController({ runId: 'ab', scopeQuery: 'projectKey=app', api, ws: { send: () => {} }, host, doc,
    confirm: async () => true, navigate: () => {}, onModel: () => {} });
  await ctl.refresh();
  [...host.querySelectorAll('button')].find((b) => b.textContent === 'Run').click();
  await tick(); await tick();
  m = model({ ...member({ checkout: { setup: { status: 'running' } } }), setupQueued: true });
  await ctl.refresh();
  assert.equal(host.querySelector('section.act-card').dataset.state, 'setting-up');
  m = model({ ...member({ checkout: { setup: { status: 'ok' } } }), setupQueued: false });   // e.g. no free port
  await ctl.refresh();
  assert.ok(!labelsOf(host).includes('Starts after setup'));
  assert.ok(labelsOf(host).includes('Run'));
  ctl.destroy();

  // The server's snapshot-less status frame clears the wait at once and shows why.
  m = model(member({ checkout: { setup: { status: 'pending' } } }));
  const host2 = doc.createElement('div');
  const ctl2 = createActionsController({ runId: 'ab', scopeQuery: 'projectKey=app', api, ws: { send: () => {} }, host: host2, doc,
    confirm: async () => true, navigate: () => {}, onModel: () => {} });
  await ctl2.refresh();
  [...host2.querySelectorAll('button')].find((b) => b.textContent === 'Run').click();
  await tick(); await tick();
  ctl2.onFrame({ type: 'action-status', instanceId: 'act:ab:app-0cea65fb:run', snapshot: null, error: 'Not started: no free port in 4400-4499', seq: 1 });
  assert.ok(!labelsOf(host2).includes('Starts after setup'));
  assert.match(host2.textContent, /Not started: no free port/);
  ctl2.destroy();
});

test('controller: Discard confirms, and SNAPSHOT_FAILED asks again before force', async () => {
  const m = model(member({ checkout: { setup: { status: 'ok' } } }));
  let deletes = 0;
  const { api, calls } = fakeApi((method) => {
    if (method === 'GET') return { ok: true, status: 200, data: m };
    if (method === 'DELETE') return ++deletes === 1 ? { ok: false, status: 409, data: { code: 'SNAPSHOT_FAILED', error: 'x' } } : { ok: true, status: 200, data: { removed: ['app-0cea65fb'] } };
    return null;
  });
  const asked = [];
  const host = doc.createElement('div');
  const ctl = createActionsController({ runId: 'ab', scopeQuery: 'projectKey=app', api, ws: { send: () => {} }, host, doc,
    confirm: async (o) => { asked.push(o.title); return true; }, navigate: () => {}, onModel: () => {} });
  await ctl.refresh();
  [...host.querySelectorAll('button')].find((b) => b.textContent === 'Discard').click();
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(asked.length, 2);
  assert.equal(asked[0], 'Discard the checkout?');
  const dels = calls.filter((c) => c[0] === 'DELETE');
  assert.deepEqual(dels.map((c) => c[2]), [{ members: ['app-0cea65fb'] }, { members: ['app-0cea65fb'], force: true }]);
  ctl.destroy();
});

test('controller: a declined Discard sends nothing', async () => {
  const m = model(member({ checkout: { setup: { status: 'ok' } } }));
  const { api, calls } = fakeApi((method) => (method === 'GET' ? { ok: true, status: 200, data: m } : null));
  const host = doc.createElement('div');
  const ctl = createActionsController({ runId: 'ab', scopeQuery: 'projectKey=app', api, ws: { send: () => {} }, host, doc,
    confirm: async () => false, navigate: () => {}, onModel: () => {} });
  await ctl.refresh();
  [...host.querySelectorAll('button')].find((b) => b.textContent === 'Discard').click();
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(calls.some((c) => c[0] === 'DELETE'), false);
  ctl.destroy();
});

// ---------------------------------------------------------------------------
// Page links: a message that names an in-app page links to it (appendWithPageLinks)
// ---------------------------------------------------------------------------

const hrefs = (el) => [...el.querySelectorAll('a.act-page-link')].map((a) => [a.textContent, a.getAttribute('href')]);

test('the apps note links to the Settings card', () => {
  const m = member({ builtins: [{ key: 'terminal', label: 'Terminal' }, { key: 'copyCommand', label: 'Copy command' }] });
  const el = renderActionsCard(model(m), { doc, handlers: {} });
  assert.deepEqual(hrefs(el), [['Settings › Runs › Actions', '#settings/runs/actions']]);
  assert.match(el.querySelector('.act-apps').textContent, /in Settings › Runs › Actions\.$/);
});

test('a checked-out project with no actions says where to add them, linked to its Actions tab', () => {
  const m = member({ actions: [], checkout: { setup: { status: 'ok' } } });
  const el = renderActionsCard(model(m), { doc, handlers: {} });
  assert.match(el.querySelector('.act-none').textContent, /^This project has no actions yet\. Add a Run or Test command on the project's Actions tab\.$/);
  assert.deepEqual(hrefs(el), [["the project's Actions tab", '#projects/app-0cea65fb/actions'], ['Settings › Runs › Actions', '#settings/runs/actions']]);
  const withActions = renderActionsCard(model(member({ checkout: { setup: { status: 'ok' } } })), { doc, handlers: {} });
  assert.equal(withActions.querySelector('.act-none'), null, 'not when it has actions');
  assert.equal(withActions.querySelector('.act-edit').textContent, "Add or change actions on the project's Actions tab.");
  assert.equal(withActions.querySelector('.act-edit a').getAttribute('href'), '#projects/app-0cea65fb/actions');
  const off = model(m); off.enabled = false;
  assert.equal(renderActionsCard(off, { doc, handlers: {} }).querySelector('.act-none'), null, 'not on a hosted worca with actions off');
});

test('an error notice that names the Settings card links it; other text stays text', () => {
  const el = renderActionsCard(model(member()), { doc, handlers: {},
    notice: { kind: 'err', text: 'no free port between 4400 and 4499; widen the range in Settings › Runs › Actions' } });
  const n = el.querySelector('.act-notice');
  assert.equal(n.textContent, 'no free port between 4400 and 4499; widen the range in Settings › Runs › Actions');
  assert.deepEqual(hrefs(n), [['Settings › Runs › Actions', '#settings/runs/actions']]);
  const plain = renderActionsCard(model(member()), { doc, handlers: {}, notice: { kind: 'err', text: 'Request failed (500)' } });
  assert.equal(plain.querySelectorAll('.act-notice a').length, 0);
});

test('layout: name and state on top, then Branch and Folder as labelled rows with copy buttons', () => {
  const copied = [];
  const long = 'worca-cc/github-source-sinishadjukic-worca-cc-529-da7d143d';
  const m = member({ branch: long, checkout: { worktreeDir: '/Users/ada/.worca-cc/runs/da7d143d/repos/worca-cc-189d6679', setup: { status: 'ok' } } });
  const el = renderActionsCard(model(m), { doc, handlers: { onCopy: (t) => copied.push(t) } });
  const head = el.querySelector('.act-head');
  assert.deepEqual([...head.children].map((c) => c.className), ['act-name', 'badge act-state'], 'the branch left the title line');
  assert.deepEqual([...el.querySelectorAll('.act-meta dt')].map((d) => d.textContent), ['Branch', 'Folder']);
  const br = el.querySelector('.act-branch');
  assert.equal(br.title, long);
  assert.ok(br.textContent.length <= 56 && br.textContent.includes('…') && br.textContent.endsWith('da7d143d'), br.textContent);
  assert.equal(el.querySelector('.act-path').title, m.checkout.worktreeDir);
  for (const b of el.querySelectorAll('.act-meta .act-copy')) b.click();
  assert.deepEqual(copied, [long, m.checkout.worktreeDir]);
  assert.deepEqual([...el.querySelectorAll('.act-meta .act-copy')].map((b) => b.getAttribute('aria-label')), ['Copy branch name', 'Copy folder path']);
});

test('middleClip keeps both ends', async () => {
  const { middleClip } = await import('../ui/public/actions-view.mjs');
  assert.equal(middleClip('short'), 'short');
  const c = middleClip('a'.repeat(40) + 'END', 20);
  assert.equal(c.length, 20);
  assert.ok(c.startsWith('aaaa') && c.endsWith('END') && c.includes('…'));
});

test('controller: Terminal before Check out asks, then checks out this member and opens it; Cancel does nothing', async () => {
  const m = model(member());
  const { api, calls } = fakeApi((method) => (method === 'GET' ? { ok: true, status: 200, data: m } : null));
  const asked = [];
  let answer = false;
  const host = doc.createElement('div');
  const ctl = createActionsController({ runId: 'ab', scopeQuery: 'projectKey=app', api, ws: { send: () => {} }, host, doc,
    confirm: async (o) => { asked.push(o); return answer; }, navigate: () => {} });
  await ctl.refresh();
  const click = () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Terminal').click();
  click(); await tick(); await tick();
  assert.equal(asked[0].title, 'Check out to open Terminal?');
  assert.deepEqual(asked[0].message, ["Terminal opens the run's checkout, which doesn't exist yet. Worca checks out ", { strong: 'worca-cc/x' },
    ' first (a few seconds), then opens Terminal.', ' Then the setup command runs: ', { strong: 'npm ci' }], 'the branch and the setup command are bold');
  assert.equal(asked[0].confirmLabel, 'Check out and open');
  assert.ok(!calls.some((c) => c[0] === 'POST'), 'cancel: nothing posted');
  answer = true;
  click(); for (let i = 0; i < 6; i++) await tick();
  const posts = calls.filter((c) => c[0] === 'POST');
  assert.deepEqual(posts.map((c) => [c[1], c[2]]), [
    ['/api/runs/ab/checkout?projectKey=app', { members: ['app-0cea65fb'] }],
    ['/api/runs/ab/builtins/terminal?projectKey=app', { member: 'app-0cea65fb' }],
  ]);
  ctl.destroy();
});

test('an error notice is a red alert; a success notice a green status', () => {
  const err = renderActionsCard(model(member()), { doc, handlers: {}, notice: { kind: 'error', text: "Can't check out: x is already checked out in /p." } }).querySelector('.act-notice');
  assert.equal(err.className, 'act-notice err');
  assert.equal(err.getAttribute('role'), 'alert');
  const ok = renderActionsCard(model(member()), { doc, handlers: {}, notice: { kind: 'ok', text: 'Copied' } }).querySelector('.act-notice');
  assert.equal(ok.className, 'act-notice ok');
  assert.equal(ok.getAttribute('role'), 'status');
});

// ---------------------------------------------------------------------------
// The branch is already checked out in the person's own folder (heldBy / a linked checkout)
// ---------------------------------------------------------------------------

test('a branch held in another folder offers "Use that folder" instead of Check out, and shows the folder', () => {
  const el = renderActionsCard(model(member({ heldBy: '/Users/ada/dev/app' })), { doc, handlers: {} });
  const labels = labelsOf(el);
  assert.ok(labels.includes('Use that folder') && !labels.includes('Check out'));
  assert.equal(el.querySelector('.act-path').title, '/Users/ada/dev/app');
  assert.match(el.querySelector('.act-meta').textContent, /already has this branch/);
  assert.match(el.querySelector('.act-apps').textContent, /^This branch is already checked out in that folder, so Worca can use it instead of making a copy\. Worca never deletes or changes your folder\. VS Code, Terminal and Finder open that folder\. Change the editor and terminal in Settings › Runs › Actions\.$/);
  const term = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Terminal');
  assert.equal(term.title, 'Open Terminal in the folder that has this branch (asks first)');
});

test('a linked folder: "Your folder" badge and Unlink instead of Discard', () => {
  const m = member({ checkout: { external: true, worktreeDir: '/Users/ada/dev/app', setup: { status: 'skipped' } } });
  const el = renderActionsCard(model(m), { doc, handlers: {} });
  assert.equal(el.querySelector('.act-linked').textContent, 'Your folder');
  const labels = labelsOf(el);
  assert.ok(labels.includes('Unlink') && !labels.includes('Discard'));
  assert.ok(labels.includes('Run setup'), 'setup did not run by itself; it stays one click away');
});

test('controller: Use that folder confirms, links with useExisting; Terminal before it links then opens; Unlink deletes the link', async () => {
  const held = model(member({ heldBy: '/Users/ada/dev/app' }));
  const { api, calls } = fakeApi((method) => (method === 'GET' ? { ok: true, status: 200, data: held } : null));
  const asked = [];
  const host = doc.createElement('div');
  const ctl = createActionsController({ runId: 'ab', scopeQuery: 'projectKey=app', api, ws: { send: () => {} }, host, doc,
    confirm: async (o) => { asked.push(o); return true; }, navigate: () => {} });
  await ctl.refresh();
  const press = async (label) => { [...host.querySelectorAll('button')].find((b) => b.textContent === label).click(); for (let i = 0; i < 6; i++) await tick(); };
  await press('Use that folder');
  assert.equal(asked[0].title, 'Use the folder that has this branch?');
  assert.deepEqual(asked[0].message[1], { strong: '/Users/ada/dev/app' });
  await press('Terminal');
  assert.equal(asked[1].title, 'Open Terminal in your folder?');
  assert.equal(asked[1].confirmLabel, 'Use it and open Terminal');
  const posts = calls.filter((c) => c[0] === 'POST').map((c) => [c[1], c[2]]);
  assert.deepEqual(posts, [
    ['/api/runs/ab/checkout?projectKey=app', { members: ['app-0cea65fb'], useExisting: true }],
    ['/api/runs/ab/checkout?projectKey=app', { members: ['app-0cea65fb'], useExisting: true }],
    ['/api/runs/ab/builtins/terminal?projectKey=app', { member: 'app-0cea65fb' }],
  ]);
  ctl.destroy();

  const linked = model(member({ checkout: { external: true, worktreeDir: '/Users/ada/dev/app', setup: { status: 'skipped' } } }));
  const two = fakeApi((method) => (method === 'GET' ? { ok: true, status: 200, data: linked } : null));
  const host2 = doc.createElement('div');
  const asked2 = [];
  const ctl2 = createActionsController({ runId: 'ab', scopeQuery: 'projectKey=app', api: two.api, ws: { send: () => {} }, host: host2, doc,
    confirm: async (o) => { asked2.push(o); return true; }, navigate: () => {} });
  await ctl2.refresh();
  [...host2.querySelectorAll('button')].find((b) => b.textContent === 'Unlink').click();
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(asked2[0].title, 'Stop using this folder?');
  assert.ok(!asked2[0].danger, 'nothing is deleted');
  assert.deepEqual(two.calls.filter((c) => c[0] === 'DELETE').map((c) => [c[1], c[2]]), [['/api/runs/ab/checkout?projectKey=app', { members: ['app-0cea65fb'] }]]);
  ctl2.destroy();
});

test('controller: a Check out refused because the branch is held elsewhere refreshes into "Use that folder", with no red error', async () => {
  let current = model(member());
  const { api } = fakeApi((method) => (method === 'GET' ? { ok: true, status: 200, data: current }
    : method === 'POST' ? (current = model(member({ heldBy: '/Users/ada/dev/app' })), { ok: false, status: 409, data: { code: 'BRANCH_CHECKED_OUT', error: 'x', holder: '/Users/ada/dev/app' } }) : null));
  const host = doc.createElement('div');
  const ctl = createActionsController({ runId: 'ab', scopeQuery: 'projectKey=app', api, ws: { send: () => {} }, host, doc, confirm: async () => true, navigate: () => {} });
  await ctl.refresh();
  [...host.querySelectorAll('button')].find((b) => b.textContent === 'Check out').click();
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(host.querySelector('.act-notice'), null);
  assert.ok(labelsOf(host).includes('Use that folder'));
  ctl.destroy();
});

test('every command on the Actions surfaces says what it does on hover', () => {
  const run = { instanceId: 'act:ab:app-0cea65fb:run', runId: 'ab', member: 'app-0cea65fb', actionId: 'run', label: 'Run', kind: 'service', status: 'ready', ports: { PORT: 4417 }, url: 'http://localhost:4417', startedAt: Date.now() };
  const untitled = (el) => [...el.querySelectorAll('button')].filter((b) => !b.title).map((b) => b.textContent || b.getAttribute('aria-label'));
  const states = [
    model(member()),
    model(member({ heldBy: '/Users/ada/dev/app' })),
    model(member({ checkout: { setup: { status: 'ok' } } }), [run]),
    model(member({ checkout: { setup: { status: 'skipped' } } })),
    model(member({ checkout: { setup: { status: 'failed', exitCode: 1 } } })),
    model(member({ checkout: { external: true, worktreeDir: '/Users/ada/dev/app', setup: { status: 'skipped' } } })),
  ];
  for (const m of states) assert.deepEqual(untitled(renderActionsCard(m, { doc, handlers: {} })), [], JSON.stringify(m.members[0].checkout));
  assert.deepEqual(untitled(renderOverviewStrip(model(member()), { doc, handlers: {} })), []);
  assert.deepEqual(untitled(renderOverviewStrip(model(member({ checkout: { setup: { status: 'ok' } } }), [run]), { doc, handlers: {} })), []);
  assert.deepEqual(untitled(renderShipItStrip(model(member()), { doc, handlers: {} })), []);
  assert.deepEqual(untitled(renderShipItStrip(model(member({ checkout: { setup: { status: 'ok' } } }), [run]), { doc, handlers: {} })), []);
  const discard = [...renderActionsCard(states[2], { doc, handlers: {} }).querySelectorAll('button')].find((b) => b.textContent === 'Discard');
  assert.match(discard.title, /^Delete the checkout folder\. .*saved as a patch first\.$/);
  const unlink = [...renderActionsCard(states[5], { doc, handlers: {} }).querySelectorAll('button')].find((b) => b.textContent === 'Unlink');
  assert.equal(unlink.title, 'Stop using your folder for this run. Running services stop; the folder and its changes stay as they are.');
});

test('the notes under a card sit together in one block', () => {
  const m = member({ actions: [], checkout: { setup: { status: 'ok' } } });
  const notes = renderActionsCard(model(m), { doc, handlers: {} }).querySelector('.act-notes');
  assert.deepEqual([...notes.children].map((c) => c.className), ['hint act-none', 'hint act-apps']);
  assert.ok(!notes.textContent.includes('app has'), 'instructional text never names the project');
});

test('Run setup shows only when setup was skipped AND the project has a setup command', () => {
  const linked = { external: true, worktreeDir: '/Users/ada/dev/app', setup: { status: 'skipped' } };
  assert.ok(labelsOf(renderActionsCard(model(member({ checkout: linked })), { doc, handlers: {} })).includes('Run setup'));
  assert.ok(!labelsOf(renderActionsCard(model(member({ checkout: linked, setup: null })), { doc, handlers: {} })).includes('Run setup'),
    'no setup command: nothing to run, no button');
  assert.ok(!labelsOf(renderActionsCard(model(member({ checkout: { setup: { status: 'ok' } } })), { doc, handlers: {} })).includes('Run setup'),
    'setup already ran: no button');
});

test('all set: the note names what opens and links to Settings; before Check out it only says where to change them', () => {
  const after = renderActionsCard(model(member({ checkout: { setup: { status: 'ok' } } })), { doc, handlers: {} });
  const note = after.querySelector('.act-apps');
  assert.equal(note.textContent, 'Opens in VS Code and Terminal. Change them in Settings › Runs › Actions.');
  assert.equal(note.querySelector('a').getAttribute('href'), '#settings/runs/actions');
  const one = renderActionsCard(model(member({ builtins: [{ key: 'terminal', label: 'iTerm' }], checkout: { setup: { status: 'ok' } } })), { doc, handlers: {} });
  assert.equal(one.querySelector('.act-apps').textContent, 'Opens in iTerm. Change it in Settings › Runs › Actions.');
  const before = renderActionsCard(model(member()), { doc, handlers: {} });
  assert.match(before.querySelector('.act-apps').textContent, /open the checkout, so they check out first\. Change the editor and terminal in Settings › Runs › Actions\.$/);
  const off = model(member({ checkout: { setup: { status: 'ok' } } })); off.enabled = false;
  assert.equal(renderActionsCard(off, { doc, handlers: {} }).querySelector('.act-apps'), null, 'hosted with actions off: nothing to change');
});
