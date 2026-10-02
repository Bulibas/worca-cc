// test/ask-panel-worktrees.test.mjs
// P4/T9: the chat's worktrees — the Worktrees section of the context popover:
// count from the snapshot, rows, manual delete round trip. Harness + frame
// driving as in the other ask-panel-*.test.mjs files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePanel } from './helpers/ask-panel-harness.mjs';

const TID = 'ask_00000001';
const WT = {
  worktreeId: 'wt_00000001', projectKey: 'demo-00000001', ref: 'worca-cc/feat-1',
  commit: 'abcdef1234567890abcdef1234567890abcdef12',
  path: '/home/u/.worca-cc/ask/ask_00000001/wt/wt_00000001', createdAt: '2026-08-24T00:00:00.000Z',
};

function snapshotHandler(state) {
  return (url, opts) => {
    const method = ((opts && opts.method) || 'GET').toUpperCase();
    if (url === `/api/ask/threads/${TID}` && method === 'GET') {
      return { ok: true, status: 200, json: async () => ({
        thread: { id: TID, title: 'chat', createdAt: 't', updatedAt: 't', model: null, effort: null, sessionId: null, context: null, totals: {} },
        messages: [], attachments: [], runLinks: [], inFlight: null,
        worktrees: state.deleted ? [] : [WT],
      }) };
    }
    if (url === `/api/ask/threads/${TID}/worktrees/${WT.worktreeId}` && method === 'DELETE') {
      state.deleted = true;
      return { ok: true, status: 200, json: async () => ({ ok: true, steps: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({ threads: [] }) };
  };
}

// The harness injects `confirm` as a dep (default: resolve true) and `storage`
// for the stored-thread pointer — key 'worca-cc.ask.thread' (ask-panel.mjs:96).
function seededStorage() {
  const map = new Map([['worca-cc.ask.thread', TID]]);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

// The ring opens the context popover; the Worktrees section is there only while the chat has one.
async function openPop(ctx) {
  ctx.doc.querySelector('[data-ask-ctx-btn]').click();
  await ctx.tick(); await ctx.tick(); await ctx.tick(); ctx.flush();   // the on-open heal's dirty.worktrees flush
  return ctx.doc.querySelector('.ask-pop-ctx');
}
const section = (ctx) => ctx.doc.querySelector('.ask-pop-ctx .ask-ctx-worktrees');
const count = (ctx) => section(ctx).querySelector('.ask-pop-caption-meter').textContent;

test('the context popover lists the chat\'s worktrees after a thread loads; trash deletes and the section goes', async () => {
  const state = { deleted: false };
  const confirms = [];
  const ctx = makePanel({
    fetchHandler: snapshotHandler(state),
    storage: seededStorage(),
    confirm: async (opts) => { confirms.push(opts); return true; },
  });
  ctx.panel.open();                       // ensureFirstOpen → switchThread(TID) → snapshot
  await ctx.tick(); await ctx.tick(); await ctx.tick();
  ctx.flush();
  await openPop(ctx);
  assert.ok(section(ctx), 'Worktrees section in the popover');
  assert.equal(count(ctx), '1');
  assert.match(section(ctx).textContent, /demo-00000001 · worca-cc\/feat-1@abcdef1/);
  assert.match(section(ctx).textContent, /\/wt\/wt_00000001/);
  const trash = section(ctx).querySelector('.ask-wt-row .ask-thread-trash');
  assert.ok(trash, 'per-row trash');
  trash.click();
  await ctx.tick(); await ctx.tick(); await ctx.tick();
  assert.equal(confirms.length, 1, 'confirm dialog invoked');
  assert.match(confirms[0].message, /branches are untouched/);
  assert.equal(state.deleted, true, 'DELETE was issued');
  assert.equal(ctx.doc.querySelector('.ask-pop-ctx'), null, 'the trash closed the popover before the confirm');
  await openPop(ctx);
  assert.equal(section(ctx), null, 'no worktrees left: no section');
});

test('turn end refetches worktrees (count refresh on ask-done)', async () => {
  // Without the afterFrame hook, a turn that created a worktree leaves a stale
  // count. Drive a CLEAN, stamped ask-start → ask-done turn (NO seq gap) and assert
  // a SECOND snapshot GET. The clean seq is load-bearing: `pushServerFrame` early-
  // returns unless `frame.threadId === st.threadId` and only runs `afterFrame` after
  // a successful `st.model.apply(frame)`, and a seq GAP would trigger resync()→
  // loadThread()→a snapshot GET that satisfies the assertion WITHOUT refreshWorktrees
  // (a vacuous green).
  const state = { deleted: false, snapshots: 0 };
  const inner = snapshotHandler(state);
  const handler = (url, opts) => {
    if (url === `/api/ask/threads/${TID}` && (((opts && opts.method) || 'GET').toUpperCase() === 'GET')) state.snapshots += 1;
    return inner(url, opts);
  };
  const ctx = makePanel({ fetchHandler: handler, storage: seededStorage(), confirm: async () => true });
  ctx.panel.open();
  await ctx.tick(); await ctx.tick(); await ctx.tick(); ctx.flush();
  const before = state.snapshots;
  const MID = 'askm_00000001';
  ctx.panel.pushServerFrame({ type: 'ask-start', userMessageId: 'askm_u0000001', model: 'm', effort: 'high', startedAt: 't', threadId: TID, messageId: MID, seq: 1 });
  ctx.panel.pushServerFrame({ type: 'ask-done', text: 'ok', blocks: [], usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, costUsd: 0, durationMs: 5, model: 'm', status: 'done', threadTotals: { costUsd: 0, input: 1, output: 1, cacheRead: 0, cacheCreation: 0, turns: 1, agents: 0 }, threadId: TID, messageId: MID, seq: 2 });
  await ctx.tick(); await ctx.tick(); await ctx.tick();
  assert.equal(state.snapshots, before + 1, 'exactly one refetch from afterFrame — no resync, no double GET');
});

test('cancel at the confirm dialog issues NO delete and keeps the worktree listed', async () => {
  // The harness confirm defaults to true, so the destructive path is otherwise
  // untested. A confirm→false must NOT fetch DELETE and must keep the worktree.
  const state = { deleted: false };
  const ctx = makePanel({ fetchHandler: snapshotHandler(state), storage: seededStorage(), confirm: async () => false });
  ctx.panel.open();
  await ctx.tick(); await ctx.tick(); await ctx.tick(); ctx.flush();
  await openPop(ctx);
  section(ctx).querySelector('.ask-wt-row .ask-thread-trash').click();
  await ctx.tick(); await ctx.tick(); await ctx.tick();
  assert.equal(state.deleted, false, 'cancelled → no DELETE issued');
  await openPop(ctx);
  assert.equal(count(ctx), '1', 'worktree still listed');
});

test('an ask-worktrees frame moves an open popover\'s section with NO snapshot GET; another thread\'s frame is ignored', async () => {
  const state = { deleted: false, snapshots: 0 };
  const inner = snapshotHandler(state);
  const handler = (url, opts) => {
    if (url === `/api/ask/threads/${TID}` && (((opts && opts.method) || 'GET').toUpperCase() === 'GET')) state.snapshots += 1;
    return inner(url, opts);
  };
  const ctx = makePanel({ fetchHandler: handler, storage: seededStorage() });
  ctx.panel.open();
  await ctx.tick(); await ctx.tick(); await ctx.tick(); ctx.flush();
  const pop = await openPop(ctx);
  assert.equal(count(ctx), '1');
  const before = state.snapshots;
  ctx.panel.pushServerFrame({ type: 'ask-worktrees', threadId: TID, worktrees: [WT, { ...WT, worktreeId: 'wt_00000002', ref: 'main' }] });
  ctx.flush();
  assert.equal(ctx.doc.querySelector('.ask-pop-ctx'), pop, 'same panel, still open');
  assert.equal(count(ctx), '2');
  assert.equal(section(ctx).querySelectorAll('.ask-wt-row').length, 2);
  ctx.panel.pushServerFrame({ type: 'ask-worktrees', threadId: 'ask_ffffffff', worktrees: [] });
  ctx.flush();
  assert.equal(count(ctx), '2', 'another thread\'s frame is ignored');
  ctx.panel.pushServerFrame({ type: 'ask-worktrees', threadId: TID, worktrees: [] });
  ctx.flush();
  assert.equal(section(ctx), null, 'an empty list drops the section');
  assert.ok(pop.querySelector('.ask-ctx-topics'), 'the rest of the popover survives the re-render');
  assert.equal(state.snapshots, before, 'the frame carried the list — no GET');
});
