// test/ask-panel-contexts.test.mjs — context chips: the open chat's header row (links that
// close the sheet and route) and the History popover rows (display-only, max 3 + overflow).
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

test('header chips: one per context, links route + close, pinned styled, dead run not a link', async () => {
  const state = { threads: [thread()], thread: thread() };
  const ctx = makePanel({ fetchHandler: handler(state) });
  await openThread(ctx);
  const row = ctx.doc.querySelector('[data-ask-ctx-row]');
  assert.equal(row.hidden, false);
  assert.equal(row.getAttribute('role'), 'group', 'the aria-label needs a role to be announced');
  assert.equal(row.getAttribute('aria-label'), 'Chat context');
  const chips = [...row.querySelectorAll('.ask-ctx-chip')];
  assert.deepEqual(chips.map((c) => c.dataset.kind), ['project', 'run', 'workspace', 'page', 'run']);
  assert.deepEqual(chips.map((c) => c.getAttribute('href')), [
    '#projects/worca-cc-ace1a602',
    '#history/worca-cc-ace1a602/1a2b3c4d',
    '#workspaces/wks-havn-0000abcd',
    '#settings',
    null,
  ]);
  assert.equal(chips[4].tagName, 'SPAN', 'a run with no home is display-only');
  assert.ok(chips[2].classList.contains('is-pinned'));
  assert.ok(chips[2].querySelector('svg'), 'pinned chip carries the pin icon');
  assert.ok(!chips[0].classList.contains('is-pinned'));
  assert.match(chips[0].textContent, /project\s*worca-cc/);
  assert.equal(chips[3].textContent.trim(), 'Settings');

  chips[1].click();
  assert.equal(ctx.window.location.hash, '#history/worca-cc-ace1a602/1a2b3c4d');
  assert.equal(ctx.panel.isOpen(), false, 'routing closes the sheet');
  ctx.panel.destroy();
});

test('legacy chat (contexts []) shows no indicator; new chat clears the row', async () => {
  const state = { threads: [thread({ contexts: [] })], thread: thread({ contexts: [] }) };
  const ctx = makePanel({ fetchHandler: handler(state) });
  await openThread(ctx);
  assert.equal(ctx.doc.querySelector('[data-ask-ctx-row]').hidden, true);
  assert.equal(ctx.doc.querySelectorAll('.ask-thread-ctx').length, 0, 'no chips in the history row either');
  ctx.panel.destroy();
});

test('send repaints the header from the 202 contexts', async () => {
  const state = { threads: [], thread: thread({ contexts: [] }), after: [{ kind: 'page', id: 'team-policy', label: 'Team policy' }] };
  const ctx = makePanel({ fetchHandler: handler(state), getPageContext: () => ({ view: 'team-policy' }) });
  ctx.panel.open();
  ctx.doc.querySelector('textarea.ask-input').value = 'hello';
  ctx.doc.querySelector('[data-ask-send]').click();
  await ctx.tick(); await ctx.tick(); await ctx.tick();
  const row = ctx.doc.querySelector('[data-ask-ctx-row]');
  assert.equal(row.hidden, false);
  assert.deepEqual([...row.querySelectorAll('.ask-ctx-chip')].map((c) => c.getAttribute('href')), ['#team-policy']);
  ctx.doc.querySelector('[data-ask-new-btn]').click();
  assert.equal(row.hidden, true, 'New chat starts with no chips');
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

test('chat chips: is-mentioned styling and title in the header (links) and History rows; pinned stays page-only', async () => {
  const mentioned = [
    { kind: 'project', id: 'worca-cc-ace1a602', label: 'worca-cc' },
    { kind: 'run', id: '5e6f7081', label: 'Fix login', home: 'worca-cc-ace1a602', source: 'chat' },
  ];
  const state = { threads: [thread({ contexts: mentioned })], thread: thread({ contexts: mentioned }) };
  const ctx = makePanel({ fetchHandler: handler(state) });
  await openThread(ctx);
  const chips = [...ctx.doc.querySelectorAll('[data-ask-ctx-row] .ask-ctx-chip')];
  assert.ok(!chips[0].classList.contains('is-mentioned'), 'a page chip is not a mentioned one');
  assert.ok(chips[1].classList.contains('is-mentioned'));
  assert.ok(!chips[1].classList.contains('is-pinned'));
  assert.match(chips[1].title, /Mentioned in this chat/);
  assert.doesNotMatch(chips[0].title, /Mentioned/);
  assert.equal(chips[1].getAttribute('href'), '#history/worca-cc-ace1a602/5e6f7081', 'routes like a page chip');
  ctx.doc.querySelector('[data-ask-threads-btn]').click();
  await ctx.tick(); await ctx.tick(); await ctx.tick();
  const rowChips = [...ctx.doc.querySelectorAll('.ask-thread-row .ask-thread-ctx .ask-ctx-chip')];
  assert.deepEqual(rowChips.map((c) => c.classList.contains('is-mentioned')), [false, true]);
  ctx.panel.destroy();
});

test('ask-done contexts repaint the header row; a frame without them keeps what is shown', async () => {
  const state = { threads: [thread({ contexts: CONTEXTS.slice(0, 1) })], thread: thread({ contexts: CONTEXTS.slice(0, 1) }) };
  const ctx = makePanel({ fetchHandler: handler(state) });
  await openThread(ctx);
  const ids = () => [...ctx.doc.querySelectorAll('[data-ask-ctx-row] .ask-ctx-chip')].map((c) => c.dataset.kind);
  assert.deepEqual(ids(), ['project']);
  const done = (seq, over = {}) => ({ type: 'ask-done', threadId: TID, messageId: 'msg_00000002', seq, text: 'ok', blocks: [], usage: null,
    costUsd: null, durationMs: 1, model: 'm', status: 'done', threadTotals: null, ...over });
  ctx.panel.pushServerFrame({ type: 'ask-start', threadId: TID, messageId: 'msg_00000002', seq: 1, userMessageId: 'msg_00000001', model: 'm', effort: 'high', startedAt: 't' });
  ctx.panel.pushServerFrame(done(2, { contexts: [CONTEXTS[0], { kind: 'run', id: '5e6f7081', label: 'Fix login', home: 'worca-cc-ace1a602', source: 'chat' }] }));
  ctx.flush();
  assert.deepEqual(ids(), ['project', 'run']);
  assert.ok(ctx.doc.querySelector('[data-ask-ctx-row] .ask-ctx-chip.is-mentioned'));
  ctx.panel.pushServerFrame({ type: 'ask-start', threadId: TID, messageId: 'msg_00000003', seq: 3, userMessageId: 'msg_00000001', model: 'm', effort: 'high', startedAt: 't' });
  ctx.panel.pushServerFrame(done(4, { messageId: 'msg_00000003' }));         // an older server omits contexts
  ctx.flush();
  assert.deepEqual(ids(), ['project', 'run']);
  ctx.panel.destroy();
});
