// test/ask-panel-live-meters.test.mjs — the footer moves WHILE a turn streams:
// agent blocks bump the context popover's Agents count, ask-usage's estimate
// shows "≈$", the popover re-renders in place, and an out-of-turn frame never
// resets the clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makePanel } from './helpers/ask-panel-harness.mjs';
import { stampFrames } from './helpers/ask-frames.mjs';
import { checkRows } from './helpers/rows.mjs';

const TID = 'ask_00000001';
const MID = 'askm_00000001';

const snap = (totals = {}) => ({
  thread: { id: TID, title: 'T', createdAt: 't', updatedAt: 't', model: null, effort: null, sessionId: null, context: null, totals },
  messages: [{ id: 'askm_u0000001', threadId: TID, seq: 1, role: 'user', text: 'hi', blocks: [], status: null, reason: null, model: null, effort: null, usage: null, costUsd: null, durationMs: null, createdAt: 't' }],
  attachments: [], runLinks: [], inFlight: null, worktrees: [],
});
const handler = (body) => (url, opts) => {
  const method = ((opts && opts.method) || 'GET').toUpperCase();
  if (url === `/api/ask/threads/${TID}` && method === 'GET') return { ok: true, status: 200, json: async () => body };
  return { ok: true, status: 200, json: async () => ({ threads: [] }) };
};
const agent = (id, status) => ({ kind: 'agent', id, label: 'count runs', type: 'general-purpose', model: null, tokens: null, ctx: null, usage: null, costUsd: null, estimated: true, status, durationMs: null, log: [] });
const start = { type: 'ask-start', userMessageId: 'askm_u0000001', model: 'm', effort: 'high', startedAt: 't' };

async function openLoaded(body, overrides = {}) {
  const ctx = makePanel({ fetchHandler: handler(body), ...overrides });
  ctx.storage.setItem('worca-cc.ask.thread', TID);
  ctx.panel.open();
  await ctx.tick(); await ctx.tick(); await ctx.tick(); ctx.flush();
  return ctx;
}

test('ask-panel-live-meters: an agent ask-block bumps the Agents count (and an open popover\'s section) before ask-done; ask-done does not double count', async () => {
  await checkRows([
    { name: 'ask-panel-live-meters: an agent ask-block bumps the Agents count before ask-done; ask-done does not double count', run: async () => {
      const ctx = await openLoaded(snap({ costUsd: 0.5, turns: 1, agents: 1 }));
      ctx.doc.querySelector('[data-ask-ctx-btn]').click();
      const label = () => ctx.doc.querySelector('.ask-pop-ctx .ask-ctx-agents .ask-pop-caption-meter').textContent;
      assert.equal(label(), '', 'the list counts the agents it shows: none loaded');
      const frames = stampFrames([
        start,
        { type: 'ask-block', block: agent('toolu_a1', 'running') },
        { type: 'ask-block', block: agent('toolu_a1', 'running') },
        { type: 'ask-block', block: agent('toolu_a2', 'running') },
        { type: 'ask-done', text: 'ok', blocks: [agent('toolu_a1', 'done'), agent('toolu_a2', 'done')], usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, costUsd: 0.1, durationMs: 5, model: 'm', status: 'done',
          threadTotals: { costUsd: 0.6, input: 1, output: 1, cacheRead: 0, cacheCreation: 0, turns: 2, agents: 3 } },
      ], { threadId: TID, messageId: MID });
      ctx.panel.pushServerFrame(frames[0]); ctx.panel.pushServerFrame(frames[1]); ctx.flush();
      assert.match(label(), /^1 · /, 'counted the moment its block streams');
      ctx.panel.pushServerFrame(frames[2]); ctx.panel.pushServerFrame(frames[3]); ctx.flush();
      assert.match(label(), /^2 · /, 'a re-emitted block counts once');
      ctx.panel.pushServerFrame(frames[4]); ctx.flush();
      assert.match(label(), /^2 · /, 'the finished blocks replace the live ones — no double count');
    } },
    { name: 'ask-panel-live-meters: an open context popover\'s Agents section follows agent blocks in place', run: async () => {
      const ctx = await openLoaded(snap({ costUsd: 0, turns: 0, agents: 0 }));
      ctx.doc.querySelector('[data-ask-ctx-btn]').click();
      await ctx.tick();
      const pop = ctx.doc.querySelector('.ask-pop-ctx');
      assert.match(pop.querySelector('.ask-ctx-agents').textContent, /No agents spawned yet\./);
      const frames = stampFrames([
        start,
        { type: 'ask-block', block: agent('toolu_a1', 'running') },
        { type: 'ask-block', block: { ...agent('toolu_a1', 'done'), costUsd: 0.62, ctx: 11600 } },
      ], { threadId: TID, messageId: MID });
      ctx.panel.pushServerFrame(frames[0]); ctx.panel.pushServerFrame(frames[1]); ctx.flush();
      assert.equal(ctx.doc.querySelector('.ask-pop-ctx'), pop, 'same panel — rebuilt in place, not reopened');
      assert.match(pop.textContent, /count runs/);
      assert.ok(pop.querySelector('.ask-dot-run'), 'running dot');
      ctx.panel.pushServerFrame(frames[2]); ctx.flush();
      assert.ok(pop.querySelector('.ask-dot-done'), 'done dot');
      assert.equal(pop.querySelector('.ask-ctx-agents .ask-pop-caption-meter').textContent, '1 · ≈$0.62');
    } },
  ]);
});

test('ask-panel-live-meters: an out-of-turn frame mid-turn (ask-title arrives early now) never resets the elapsed clock', async () => {
  let t = 1_000_000;
  const ctx = await openLoaded(snap(), { now: () => t });
  ctx.panel.pushServerFrame({ ...start, startedAt: new Date(t).toISOString(), threadId: TID, messageId: MID, seq: 1 });
  ctx.flush();
  t += 6400;
  ctx.panel.pushServerFrame({ type: 'ask-title', threadId: TID, title: 'Early Title' });
  ctx.panel.pushServerFrame({ type: 'ask-worktrees', threadId: TID, worktrees: [] });
  ctx.flush();
  assert.equal(ctx.doc.querySelector('.ask-title').textContent, 'Early Title');
  assert.match(ctx.doc.querySelector('.ask-thinking-meter').textContent, /^6\.4s/, 'the clock kept counting from ask-start');
});
