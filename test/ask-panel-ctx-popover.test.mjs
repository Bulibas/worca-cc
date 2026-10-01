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

test('trigger: a button with the meter text, popup semantics, no hover title, visible at every level', async () => {
  const ctx = makePanel({ fetchHandler: handler({ thread: thread() }) });
  await openThread(ctx);
  const btn = ctx.doc.querySelector('[data-ask-ctx-btn]');
  assert.equal(btn.tagName, 'BUTTON');
  assert.equal(btn.type, 'button');
  assert.ok(btn.classList.contains('ask-meter-tokens'));
  assert.equal(btn.textContent, '120.4k / 1M ctx · 12%');
  assert.ok(btn.querySelector('svg'), 'a chevron');
  assert.equal(btn.getAttribute('aria-haspopup'), 'menu');
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  assert.equal(btn.getAttribute('aria-label'), 'Context window, 12% full');
  assert.equal(btn.hasAttribute('title'), false, 'the hover text moved into the popover');
  assert.equal(btn.closest('[data-min-level]'), null, 'shown in every interface mode');
  assert.equal(ctx.doc.querySelector('.ask-meter-cost').dataset.minLevel, 'advanced', 'cost stays Advanced');
  for (const s of ctx.doc.querySelectorAll('.ask-meter-sep')) assert.equal(s.dataset.minLevel, 'advanced');
  ctx.panel.destroy();
});

test('trigger: aria-label without a known share; click toggles the popover and aria-expanded', async () => {
  const ctx = makePanel({ fetchHandler: handler({ thread: thread({ totals: T({ ctx: 68400 }) }) }) });
  await openThread(ctx);
  const btn = ctx.doc.querySelector('[data-ask-ctx-btn]');
  assert.equal(btn.textContent, '68.4k ctx');
  assert.equal(btn.getAttribute('aria-label'), 'Context window');
  btn.click();
  assert.ok(ctx.doc.querySelector('.ask-pop-ctx'));
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  btn.click();
  assert.equal(ctx.doc.querySelector('.ask-pop-ctx'), null);
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
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
  btn.getBoundingClientRect = rect(110, 230);                    // too far left for a 320px panel
  assert.equal(openCtx(ctx).style.right, '494px', 'clamped: 820 − 320 − 6 keeps 6px to the sheet edge');
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
