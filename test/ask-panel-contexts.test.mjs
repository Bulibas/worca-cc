// test/ask-panel-contexts.test.mjs — context topics: the context popover's Topics section (links that
// close the sheet and route) and the History popover rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePanel } from './helpers/ask-panel-harness.mjs';

const TID = 'ask_0000c0de';
const CONTEXTS = [
  { kind: 'project', id: 'worca-cc-ace1a602', label: 'worca-cc' },
  { kind: 'run', id: '1a2b3c4d', label: 'Fix login', home: 'worca-cc-ace1a602' },
  { kind: 'workspace', id: 'wks-havn-0000abcd', label: 'havn', pinned: true },
  { kind: 'page', id: 'settings', label: 'Settings' },
  { kind: 'run', id: 'deadbeef', label: 'Live run', home: null },
];
const thread = (over = {}) => ({
  id: TID, title: 'A chat', createdAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z',
  model: null, effort: null, sessionId: null, context: null, contexts: CONTEXTS,
  totals: { costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, turns: 1, agents: 0 }, createdBy: null, ...over,
});
const ok = (body, status = 200) => ({ ok: true, status, json: async () => body });

function handler(state) {
  return (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (url === '/api/ask/threads?limit=50') return ok({ threads: state.threads, total: state.threads.length });
    if (url === `/api/ask/threads/${TID}` && method === 'GET') {
      return ok({ thread: state.thread, messages: [], attachments: [], runLinks: [], worktrees: { items: [] }, inFlight: null });
    }
    if (url === '/api/ask/threads' && method === 'POST') return ok({ thread: thread({ contexts: [] }) }, 201);
    if (url === `/api/ask/threads/${TID}/messages`) {
      return ok({ userMessageId: 'msg_00000001', assistantMessageId: 'msg_00000002', attachments: [], contexts: state.after }, 202);
    }
    return ok({});
  };
}

async function openThread(ctx) {
  ctx.panel.open();
  ctx.doc.querySelector('[data-ask-threads-btn]').click();
  await ctx.tick(); await ctx.tick(); await ctx.tick();
  ctx.doc.querySelector('.ask-thread-pick').click();
  await ctx.tick(); await ctx.tick(); await ctx.tick();
}

const openCtx = (ctx) => { ctx.doc.querySelector('[data-ask-ctx-btn]').click(); return ctx.doc.querySelector('.ask-pop-ctx'); };
const topics = (pop, group) => [...pop.querySelectorAll(`[data-ctx-group="${group}"] .ask-ctx-topic`)];

test('no header chip row any more', async () => {
  const ctx = makePanel({ fetchHandler: handler({ threads: [thread()], thread: thread() }) });
  await openThread(ctx);
  assert.equal(ctx.doc.querySelector('[data-ask-ctx-row]'), null);
  assert.equal(ctx.doc.querySelector('.ask-sheet .ask-ctx-chip'), null);
  ctx.panel.destroy();
});

test('topics: "Asked from" rows in stored order, links route + close, pinned marked, homeless run not a link', async () => {
  const ctx = makePanel({ fetchHandler: handler({ threads: [thread()], thread: thread() }) });
  await openThread(ctx);
  const pop = openCtx(ctx);
  assert.equal(pop.querySelector('[data-ctx-group="asked"] .ask-ctx-group').textContent, 'Asked from');
  assert.equal(pop.querySelector('[data-ctx-group="mentioned"]'), null, 'no mentioned topics: no group');
  const rows = topics(pop, 'asked');
  assert.deepEqual(rows.map((r) => r.dataset.kind), ['project', 'run', 'workspace', 'page', 'run']);
  assert.deepEqual(rows.map((r) => r.querySelector('.ask-ctx-topic-name').textContent), ['worca-cc', 'Fix login', 'havn', 'Settings', 'Live run']);
  assert.deepEqual(rows.map((r) => r.querySelector('.ask-ctx-topic-kind').textContent), ['project', 'run', 'workspace', 'page', 'run']);
  assert.deepEqual(rows.map((r) => r.getAttribute('role')), ['menuitem', 'menuitem', 'menuitem', 'menuitem', null]);
  assert.equal(rows[4].tagName, 'DIV', 'a run with no home is a plain row');
  assert.ok(rows[2].classList.contains('is-pinned'));
  assert.ok(rows[2].querySelector('svg'), 'pin icon');
  assert.equal(rows[2].querySelector('.ask-ctx-topic-pin').textContent, 'pinned');
  assert.equal(rows[0].querySelector('.ask-ctx-topic-pin'), null);
  assert.equal(ctx.doc.activeElement, rows[0], 'focus lands on the first topic');
  rows[1].click();
  assert.equal(ctx.window.location.hash, '#history/worca-cc-ace1a602/1a2b3c4d');
  assert.equal(ctx.panel.isOpen(), false, 'routing closes the sheet');
  assert.equal(ctx.doc.querySelector('.ask-pop-ctx'), null);
  ctx.panel.destroy();
});

test('topics: arrow keys skip the homeless run', async () => {
  const ctx = makePanel({ fetchHandler: handler({ threads: [thread()], thread: thread() }) });
  await openThread(ctx);
  const pop = openCtx(ctx);
  const rows = topics(pop, 'asked');
  rows[3].focus();
  pop.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(ctx.doc.activeElement, rows[0], 'wraps past the plain row');
  ctx.panel.destroy();
});

test('topics: mentioned ones get their own group, muted, routing like page topics', async () => {
  const mentioned = [
    { kind: 'project', id: 'worca-cc-ace1a602', label: 'worca-cc' },
    { kind: 'run', id: '5e6f7081', label: 'Fix login', home: 'worca-cc-ace1a602', source: 'chat' },
  ];
  const ctx = makePanel({ fetchHandler: handler({ threads: [thread({ contexts: mentioned })], thread: thread({ contexts: mentioned }) }) });
  await openThread(ctx);
  const pop = openCtx(ctx);
  assert.equal(pop.querySelector('[data-ctx-group="mentioned"] .ask-ctx-group').textContent, 'Mentioned in chat');
  const [m] = topics(pop, 'mentioned');
  assert.ok(m.classList.contains('is-mentioned'));
  assert.ok(!m.classList.contains('is-pinned'));
  assert.equal(topics(pop, 'asked').length, 1);
  m.click();
  assert.equal(ctx.window.location.hash, '#history/worca-cc-ace1a602/5e6f7081');
  ctx.panel.destroy();
});

test('topics: none yet says so', async () => {
  const ctx = makePanel({ fetchHandler: handler({ threads: [thread({ contexts: [] })], thread: thread({ contexts: [] }) }) });
  await openThread(ctx);
  const pop = openCtx(ctx);
  assert.equal(pop.querySelector('.ask-ctx-topics .ask-pop-empty').textContent, 'No topics yet.');
  assert.equal(pop.querySelectorAll('.ask-ctx-topic').length, 0);
  ctx.panel.destroy();
});

test('topics: the 202 contexts and New chat repaint an open popover in place', async () => {
  const state = { threads: [], thread: thread({ contexts: [] }), after: [{ kind: 'page', id: 'team-policy', label: 'Team policy' }] };
  const ctx = makePanel({ fetchHandler: handler(state), getPageContext: () => ({ view: 'team-policy' }) });
  ctx.panel.open();
  const pop = openCtx(ctx);
  ctx.doc.querySelector('textarea.ask-input').value = 'hello';
  ctx.doc.querySelector('[data-ask-send]').click();
  await ctx.tick(); await ctx.tick(); await ctx.tick();
  assert.equal(ctx.doc.querySelector('.ask-pop-ctx'), pop, 'still open, same node');
  assert.deepEqual(topics(pop, 'asked').map((r) => r.querySelector('.ask-ctx-topic-name').textContent), ['Team policy']);
  ctx.doc.querySelector('[data-ask-new-btn]').click();
  const p3 = ctx.doc.querySelector('.ask-pop-ctx') || openCtx(ctx);
  assert.equal(p3.querySelectorAll('.ask-ctx-topic').length, 0, 'New chat starts with no topics');
  ctx.panel.destroy();
});

test('history rows: at most 3 display-only chips + overflow; clicking a chip opens the chat', async () => {
  const state = { threads: [thread()], thread: thread() };
  const ctx = makePanel({ fetchHandler: handler(state) });
  ctx.panel.open();
  ctx.doc.querySelector('[data-ask-threads-btn]').click();
  await ctx.tick(); await ctx.tick(); await ctx.tick();
  const holder = ctx.doc.querySelector('.ask-thread-row .ask-thread-ctx');
  const chips = [...holder.querySelectorAll('.ask-ctx-chip')];
  assert.equal(chips.length, 3);
  assert.ok(chips.every((c) => c.tagName === 'SPAN' && !c.hasAttribute('href')), 'display-only');
  assert.equal(holder.querySelector('.ask-ctx-more').textContent, '+2');
  chips[0].click();                                             // bubbles to the row's pick button
  await ctx.tick(); await ctx.tick(); await ctx.tick();
  assert.equal(ctx.doc.querySelector('.ask-title').textContent, 'A chat', 'the row opened the chat');
  assert.equal(ctx.window.location.hash, '', 'no navigation from a history chip');
  ctx.panel.destroy();
});

test('history rows: mentioned chips marked (rewritten in the next step)', async () => {
  const mentioned = [
    { kind: 'project', id: 'worca-cc-ace1a602', label: 'worca-cc' },
    { kind: 'run', id: '5e6f7081', label: 'Fix login', home: 'worca-cc-ace1a602', source: 'chat' },
  ];
  const ctx = makePanel({ fetchHandler: handler({ threads: [thread({ contexts: mentioned })], thread: thread({ contexts: mentioned }) }) });
  ctx.panel.open();
  ctx.doc.querySelector('[data-ask-threads-btn]').click();
  await ctx.tick(); await ctx.tick(); await ctx.tick();
  const rowChips = [...ctx.doc.querySelectorAll('.ask-thread-row .ask-thread-ctx .ask-ctx-chip')];
  assert.deepEqual(rowChips.map((c) => c.classList.contains('is-mentioned')), [false, true]);
  ctx.panel.destroy();
});

test('topics: ask-done contexts repaint the open popover; a frame without them keeps what is shown', async () => {
  const state = { threads: [thread({ contexts: CONTEXTS.slice(0, 1) })], thread: thread({ contexts: CONTEXTS.slice(0, 1) }) };
  const ctx = makePanel({ fetchHandler: handler(state) });
  await openThread(ctx);
  const pop = openCtx(ctx);
  const ids = () => [...ctx.doc.querySelectorAll('.ask-pop-ctx .ask-ctx-topic')].map((r) => r.dataset.kind);
  assert.deepEqual(ids(), ['project']);
  const done = (seq, over = {}) => ({ type: 'ask-done', threadId: TID, messageId: 'msg_00000002', seq, text: 'ok', blocks: [], usage: null,
    costUsd: null, durationMs: 1, model: 'm', status: 'done', threadTotals: null, ...over });
  ctx.panel.pushServerFrame({ type: 'ask-start', threadId: TID, messageId: 'msg_00000002', seq: 1, userMessageId: 'msg_00000001', model: 'm', effort: 'high', startedAt: 't' });
  ctx.panel.pushServerFrame(done(2, { contexts: [CONTEXTS[0], { kind: 'run', id: '5e6f7081', label: 'Fix login', home: 'worca-cc-ace1a602', source: 'chat' }] }));
  ctx.flush();
  assert.equal(ctx.doc.querySelector('.ask-pop-ctx'), pop, 'rebuilt in place');
  assert.deepEqual(ids(), ['project', 'run']);
  assert.ok(ctx.doc.querySelector('.ask-pop-ctx .ask-ctx-topic.is-mentioned'));
  ctx.panel.pushServerFrame({ type: 'ask-start', threadId: TID, messageId: 'msg_00000003', seq: 3, userMessageId: 'msg_00000001', model: 'm', effort: 'high', startedAt: 't' });
  ctx.panel.pushServerFrame(done(4, { messageId: 'msg_00000003' }));         // an older server omits contexts
  ctx.flush();
  assert.deepEqual(ids(), ['project', 'run']);
  ctx.panel.destroy();
});
