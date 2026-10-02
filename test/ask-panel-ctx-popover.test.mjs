// test/ask-panel-ctx-popover.test.mjs — the composer's context popover: window fill + the chat's topics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtShare, ctxBreakdown, groupContexts } from '../ui/public/ask-panel.mjs';
import { makePanel } from './helpers/ask-panel-harness.mjs';

test('fmtShare: one decimal of the window; null without a window', () => {
  assert.equal(fmtShare(120400, 1000000), '12.0%');
  assert.equal(fmtShare(33000, 1000000), '3.3%');
  assert.equal(fmtShare(0, 200000), '0.0%');
  assert.equal(fmtShare(230000, 200000), '115.0%', 'not clamped');
  assert.equal(fmtShare(1000, null), null);
  assert.equal(fmtShare(NaN, 200000), null);
});

test('ctxBreakdown: used / buffer / free / until compaction, with level and percent', () => {
  assert.deepEqual(ctxBreakdown(120400, 1000000),
    { used: 120400, buffer: 33000, free: 846600, untilCompact: 846600, pct: 12, level: 'ok' });
  assert.deepEqual(ctxBreakdown(76200, 200000),
    { used: 76200, buffer: 33000, free: 90800, untilCompact: 90800, pct: 38, level: 'ok' });
  assert.deepEqual(ctxBreakdown(230000, 200000),
    { used: 230000, buffer: 33000, free: 0, untilCompact: 0, pct: 115, level: 'high' }, 'over the window: nothing free');
  assert.equal(ctxBreakdown(40000, 50000).buffer, 0, 'a window too small for the buffer has none');
  assert.equal(ctxBreakdown(68400, null), null, 'unknown window');
  assert.equal(ctxBreakdown(0, 200000), null, 'no fill');
});

test('groupContexts: page topics vs mentioned, order kept, junk dropped', () => {
  const p = { kind: 'project', id: 'p1', label: 'P' };
  const m = { kind: 'run', id: 'r1', label: 'R', home: 'p1', source: 'chat' };
  const w = { kind: 'workspace', id: 'w1', label: 'W', pinned: true };
  assert.deepEqual(groupContexts([p, m, null, { kind: 'run' }, w]), { asked: [p, w], mentioned: [m] });
  assert.deepEqual(groupContexts(undefined), { asked: [], mentioned: [] });
});

// ── the trigger and the popover ──────────────────────────────────────────────
const TID = 'ask_0000c0de';
const T = (over) => ({ costUsd: 0.1, input: 1, output: 1, cacheRead: 0, cacheCreation: 0, turns: 1, agents: 0, ...over });
const thread = (over = {}) => ({
  id: TID, title: 'A chat', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  model: null, effort: null, sessionId: null, context: null, contexts: [], totals: T({ ctx: 120400, ctxWindow: 1000000 }), createdBy: null, ...over,
});
const ok = (body, status = 200) => ({ ok: true, status, json: async () => body });
function handler(state) {
  return (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (url === '/api/ask/threads?limit=50') return ok({ threads: [state.thread], total: 1 });
    if (url === `/api/ask/threads/${TID}` && method === 'GET') {
      return ok({ thread: state.thread, messages: [], attachments: [], runLinks: [], worktrees: { items: [] }, inFlight: null });
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

const arc = (btn) => btn.querySelector('.ask-ctx-ring-arc').getAttribute('stroke-dasharray');

test('trigger: a ring button — arc = the fill, the figure in the hover, popup semantics, visible at every level', async () => {
  const ctx = makePanel({ fetchHandler: handler({ thread: thread() }) });
  await openThread(ctx);
  const btn = ctx.doc.querySelector('[data-ask-ctx-btn]');
  assert.equal(btn.tagName, 'BUTTON');
  assert.equal(btn.type, 'button');
  assert.equal(btn.className, 'ask-ctx-ring');
  assert.equal(btn.textContent, '', 'a ring, no text');
  assert.ok(btn.querySelector('svg .ask-ctx-ring-track'), 'the track');
  assert.equal(arc(btn), '12.04 100', 'the arc covers the fill on a 100-unit path');
  assert.equal(btn.title, '120.4k / 1M ctx · 12%', 'the old meter text moved into the hover');
  assert.equal(btn.getAttribute('aria-haspopup'), 'menu');
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  assert.equal(btn.getAttribute('aria-label'), 'Context window, 12% full');
  assert.equal(btn.closest('[data-min-level]'), null, 'shown in every interface mode');
  assert.equal(ctx.doc.querySelector('.ask-meter-cost').dataset.minLevel, 'advanced', 'cost stays Advanced');
  assert.equal(ctx.doc.querySelector('.ask-meter-cost').nextElementSibling, btn, 'the cost, then the ring');
  assert.equal(ctx.doc.querySelectorAll('.ask-meter-sep').length, 0, 'no separators');
  ctx.panel.destroy();
});

test('trigger: an unknown window keeps the ring empty; click toggles the popover and aria-expanded', async () => {
  const ctx = makePanel({ fetchHandler: handler({ thread: thread({ totals: T({ ctx: 68400 }) }) }) });
  await openThread(ctx);
  const btn = ctx.doc.querySelector('[data-ask-ctx-btn]');
  assert.equal(arc(btn), '0 100');
  assert.equal(btn.title, '68.4k ctx');
  assert.equal(btn.getAttribute('aria-label'), 'Context window');
  btn.click();
  assert.ok(ctx.doc.querySelector('.ask-pop-ctx'));
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  btn.click();
  assert.equal(ctx.doc.querySelector('.ask-pop-ctx'), null);
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  ctx.panel.destroy();
});

test('trigger: past the window the arc is a full circle', async () => {
  const ctx = makePanel({ fetchHandler: handler({ thread: thread({ totals: T({ ctx: 230000, ctxWindow: 200000 }) }) }) });
  await openThread(ctx);
  const btn = ctx.doc.querySelector('[data-ask-ctx-btn]');
  assert.equal(arc(btn), '100 100');
  assert.ok(btn.classList.contains('is-ctx-high'));
  ctx.panel.destroy();
});

test('footer: the agents and worktrees buttons are gone — their lists live in the context popover', async () => {
  const ctx = makePanel({ fetchHandler: handler({ thread: thread() }) });
  await openThread(ctx);
  assert.equal(ctx.doc.querySelector('[data-ask-agents-btn]'), null);
  assert.equal(ctx.doc.querySelector('[data-ask-wt-btn]'), null);
  ctx.panel.destroy();
});

const openCtx = (ctx) => { ctx.doc.querySelector('[data-ask-ctx-btn]').click(); return ctx.doc.querySelector('.ask-pop-ctx'); };
const stats = (pop) => [...pop.querySelectorAll('.ask-ctx-stat')].map((r) => [
  r.dataset.stat, r.querySelector('.ask-ctx-stat-name').textContent,
  r.querySelector('.ask-ctx-stat-tokens').textContent, r.querySelector('.ask-ctx-stat-share').textContent]);

test('popover: caption, bar, Used / Autocompact buffer / Free space, until auto-compact', async () => {
  const ctx = makePanel({ fetchHandler: handler({ thread: thread() }) });
  await openThread(ctx);
  const pop = openCtx(ctx);
  assert.equal(pop.getAttribute('aria-label'), 'Context window');
  assert.equal(pop.querySelector('.ask-pop-caption').textContent, 'Context window');
  assert.equal(pop.querySelector('.ask-pop-caption-meter').textContent, '120.4k / 1M (12%)');
  const bar = pop.querySelector('.ask-ctx-bar');
  assert.equal(bar.getAttribute('aria-hidden'), 'true');
  assert.equal(bar.querySelector('.ask-ctx-bar-used').style.width, '12.04%');
  assert.equal(bar.querySelector('.ask-ctx-bar-buffer').style.width, '3.3%');
  assert.deepEqual(stats(pop), [
    ['used', 'Used', '120.4k', '12.0%'],
    ['buffer', 'Autocompact buffer', '33.0k', '3.3%'],
    ['free', 'Free space', '846.6k', '84.7%'],
  ]);
  assert.equal(pop.querySelector('.ask-ctx-foot').textContent, '846.6k until auto-compact');
  assert.equal(pop.querySelector('.ask-ctx-hint'), null, 'under 200k: no re-send hint');
  ctx.panel.destroy();
});

test('popover: over the window — Used past 100%, nothing free, bar clamped, compaction soon, re-send hint', async () => {
  const ctx = makePanel({ fetchHandler: handler({ thread: thread({ totals: T({ ctx: 230000, ctxWindow: 200000 }) }) }) });
  await openThread(ctx);
  const pop = openCtx(ctx);
  assert.equal(pop.querySelector('.ask-pop-caption-meter').textContent, '230.0k / 200k (115%)');
  assert.equal(pop.querySelector('.ask-ctx-bar-used').style.width, '100%');
  assert.ok(pop.querySelector('.ask-ctx-bar-used').classList.contains('is-ctx-high'));
  assert.equal(pop.querySelector('.ask-ctx-bar-buffer'), null, 'no window left to hatch: the buffer never draws over the fill');
  assert.deepEqual(stats(pop).map((r) => r[3]), ['115.0%', '16.5%', '0.0%']);
  const foot = pop.querySelector('.ask-ctx-foot');
  assert.equal(foot.textContent, 'Compaction soon');
  assert.ok(foot.classList.contains('is-ctx-high'));
  assert.equal(pop.querySelector('.ask-ctx-hint').textContent, 'Each message re-sends about 230.0k tokens.');
  ctx.panel.destroy();
});

test('popover: a small window has no buffer row', async () => {
  const ctx = makePanel({ fetchHandler: handler({ thread: thread({ totals: T({ ctx: 10000, ctxWindow: 50000 }) }) }) });
  await openThread(ctx);
  assert.deepEqual(stats(openCtx(ctx)).map((r) => r[0]), ['used', 'free']);
  ctx.panel.destroy();
});

test('popover: window unknown — fill alone in the caption, one line, no bar or rows', async () => {
  for (const [totals, caption] of [[T({ ctx: 68400 }), '68.4k'], [T({}), ''], [{}, '']]) {
    const ctx = makePanel({ fetchHandler: handler({ thread: thread({ totals }) }) });
    await openThread(ctx);
    const pop = openCtx(ctx);
    assert.equal(pop.querySelector('.ask-pop-caption-meter').textContent, caption);
    assert.equal(pop.querySelector('.ask-pop-empty').textContent, 'The window shows after the first answer.');
    assert.equal(pop.querySelector('.ask-ctx-bar'), null);
    assert.equal(pop.querySelectorAll('.ask-ctx-stat').length, 0);
    assert.equal(pop.querySelector('.ask-ctx-foot'), null);
    ctx.panel.destroy();
  }
});

test('popover: follows the streaming fill without reopening', async () => {
  const ctx = makePanel({ fetchHandler: handler({ thread: thread() }) });
  await openThread(ctx);
  const pop = openCtx(ctx);
  ctx.panel.pushServerFrame({ type: 'ask-start', threadId: TID, messageId: 'msg_00000002', seq: 1, userMessageId: 'msg_00000001', model: 'm', effort: 'high', startedAt: 't' });
  ctx.panel.pushServerFrame({ type: 'ask-usage', threadId: TID, messageId: 'msg_00000002', seq: 2, usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, ctx: 250000 }, costUsd: null });
  ctx.flush();
  assert.equal(ctx.doc.querySelector('.ask-pop-ctx'), pop, 'same node');
  assert.equal(pop.querySelector('.ask-pop-caption-meter').textContent, '250.0k / 1M (25%)');
  ctx.panel.destroy();
});

test('popover: its right edge lines up with the trigger, kept inside the sheet', async () => {
  const ctx = makePanel({ fetchHandler: handler({ thread: thread() }) });
  await openThread(ctx);
  const btn = ctx.doc.querySelector('[data-ask-ctx-btn]');
  const sheet = btn.closest('.ask-sheet');
  const rect = (left, right) => () => ({ left, right, width: right - left, top: 0, bottom: 0, height: 0, x: left, y: 0 });
  sheet.getBoundingClientRect = rect(100, 920);
  btn.getBoundingClientRect = rect(350, 505);
  assert.equal(openCtx(ctx).style.right, '415px', '920 − 505: flush with the trigger');
  btn.click();
  btn.getBoundingClientRect = rect(110, 230);                    // too far left for a 340px panel
  assert.equal(openCtx(ctx).style.right, '474px', 'clamped: 820 − 340 − 6 keeps 6px to the sheet edge');
  ctx.panel.destroy();
});

test('popover: past the compaction point the hatch only covers what is left of the window', async () => {
  const ctx = makePanel({ fetchHandler: handler({ thread: thread({ totals: T({ ctx: 180000, ctxWindow: 200000 }) }) }) });
  await openThread(ctx);
  const pop = openCtx(ctx);
  assert.equal(pop.querySelector('.ask-ctx-bar-used').style.width, '90%');
  assert.equal(pop.querySelector('.ask-ctx-bar-buffer').style.width, '10%', '20k left, not the full 33k');
  assert.equal(stats(pop)[1][2], '33.0k', 'the row still reports the whole buffer');
  ctx.panel.destroy();
});

test('popover: a window resize while open moves it back over the trigger', async () => {
  const ctx = makePanel({ fetchHandler: handler({ thread: thread() }) });
  await openThread(ctx);
  const btn = ctx.doc.querySelector('[data-ask-ctx-btn]');
  const sheet = btn.closest('.ask-sheet');
  const rect = (left, right) => () => ({ left, right, width: right - left, top: 0, bottom: 0, height: 0, x: left, y: 0 });
  sheet.getBoundingClientRect = rect(100, 920);
  btn.getBoundingClientRect = rect(350, 505);
  const pop = openCtx(ctx);
  assert.equal(pop.style.right, '415px');
  sheet.getBoundingClientRect = rect(0, 600);                    // the window got narrower
  btn.getBoundingClientRect = rect(300, 420);
  ctx.window.dispatchEvent(new ctx.window.Event('resize'));
  assert.equal(pop.style.right, '180px', '600 − 420');
  ctx.panel.destroy();
});

// ── agents and worktrees: Expert sections under the topics ───────────────────
const agentBlock = (id, over = {}) => ({ kind: 'agent', id, label: 'count runs', type: 'general-purpose', model: 'claude-haiku-4-5', tokens: 25321, ctx: 11645, usage: null, costUsd: 0.62, estimated: true, status: 'done', durationMs: 2861, log: [], ...over });
const WT = {
  worktreeId: 'wt_00000001', projectKey: 'demo-00000001', ref: 'worca-cc/feat-1',
  commit: 'abcdef1234567890abcdef1234567890abcdef12',
  path: '/home/u/.worca-cc/ask/ask_0000c0de/wt/wt_00000001', createdAt: '2026-08-24T00:00:00.000Z',
};
function richHandler({ blocks = [], worktrees = [] }) {
  const messages = blocks.length ? [{ id: 'askm_00000001', threadId: TID, seq: 1, role: 'assistant', text: 'ok', blocks, status: 'done', reason: null, model: null, effort: null, usage: null, costUsd: null, durationMs: null, createdAt: 't' }] : [];
  return (url, opts = {}) => {
    const method = opts.method || 'GET';
    if (url === '/api/ask/threads?limit=50') return ok({ threads: [thread()], total: 1 });
    if (url === `/api/ask/threads/${TID}` && method === 'GET') {
      return ok({ thread: thread(), messages, attachments: [], runLinks: [], worktrees, inFlight: null });
    }
    return ok({});
  };
}

test('popover: Agents then Worktrees follow the topics, each an Expert section behind its own divider', async () => {
  const ctx = makePanel({ fetchHandler: richHandler({ blocks: [agentBlock('toolu_1'), agentBlock('toolu_2', { label: 'scan logs', costUsd: 0.18, status: 'running' })], worktrees: [WT] }) });
  await openThread(ctx);
  const pop = openCtx(ctx);
  await ctx.tick(); await ctx.tick(); await ctx.tick(); ctx.flush();   // the on-open worktree heal
  const agents = pop.querySelector('.ask-ctx-agents');
  const wts = pop.querySelector('.ask-ctx-worktrees');
  assert.equal(pop.querySelector('.ask-ctx-topics').nextElementSibling, agents, 'agents right after the topics');
  assert.equal(agents.nextElementSibling, wts, 'worktrees last');
  for (const sec of [agents, wts]) {
    assert.equal(sec.dataset.minLevel, 'expert', 'Expert only, as the footer buttons were');
    assert.ok(sec.firstElementChild.classList.contains('ask-pop-divider'), 'the divider hides with its section');
  }
  assert.equal(agents.querySelector('.ask-pop-caption').textContent, 'Agents');
  assert.equal(agents.querySelector('.ask-pop-caption-meter').textContent, '2 · ≈$0.80', 'count, then the summed cost');
  const rows = [...agents.querySelectorAll('.ask-runinfo-row')];
  assert.deepEqual(rows.map((r) => r.querySelector('.ask-runinfo-name').textContent), ['count runs', 'scan logs']);
  assert.match(rows[0].querySelector('.ask-runinfo-sub').textContent, /claude-haiku-4-5 · 11\.6k ctx · ≈\$0\.62 · done/);
  assert.equal(rows[0].querySelector('.ask-runinfo-sub').title, rows[0].querySelector('.ask-runinfo-sub').textContent, 'cut to one line; the whole line on hover');
  assert.ok(rows[1].querySelector('.ask-dot-run'), 'a running agent keeps its dot');
  assert.equal(wts.querySelector('.ask-pop-caption').textContent, 'Worktrees');
  assert.equal(wts.querySelector('.ask-pop-caption-meter').textContent, '1');
  assert.match(wts.querySelector('.ask-wt-row').textContent, /demo-00000001 · worca-cc\/feat-1@abcdef1/);
  ctx.panel.destroy();
});

test('popover: no agents → an empty line; no worktrees → no Worktrees section at all', async () => {
  const ctx = makePanel({ fetchHandler: richHandler({}) });
  await openThread(ctx);
  const pop = openCtx(ctx);
  await ctx.tick(); await ctx.tick(); await ctx.tick(); ctx.flush();
  const agents = pop.querySelector('.ask-ctx-agents');
  assert.equal(agents.querySelector('.ask-pop-caption-meter').textContent, '');
  assert.equal(agents.querySelector('.ask-pop-empty').textContent, 'No agents spawned yet.');
  assert.equal(pop.querySelector('.ask-ctx-worktrees'), null);
  ctx.panel.destroy();
});
