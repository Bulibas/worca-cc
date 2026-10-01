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
