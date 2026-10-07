// test/ask-panel-pill-live.test.mjs — the collapsed launcher pill's "thinking"
// state. The thinking ring and the mark ↔ orb morph are CSS (style.css .ask-pill.is-live,
// pinned by test/ui-ask-style.test.mjs); this suite pins WHEN the panel raises and lowers
// the `is-live` class, through the same public surface the stream suite drives
// (pushServerFrame / open / close / the History popover / the composer).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { checkRows } from './helpers/rows.mjs';

import { makePanel } from './helpers/ask-panel-harness.mjs';
import { replayFixture, stampFrames } from './helpers/ask-frames.mjs';

const TID = 'ask_00000001';
const TID2 = 'ask_00000002';
const MID = 'askm_00000001';
// The mark host wraps the masked logo AND the pill's own orb (a CSS mask clips
// children, so the orb cannot sit under the masked span): both are built once,
// at build time, and the morph between them is CSS keyed off .is-live.
const PILL_CHILDREN = ['ask-pill-mark', 'ask-pill-label'];
const MARK_CHILDREN = ['ask-pill-logo', 'ask-orb'];

function snapBody(over = {}) {
  return {
    thread: { id: TID, title: 'T', createdAt: 't', updatedAt: 't', model: null, effort: null, sessionId: null, context: null, totals: {} },
    messages: [{ id: 'askm_u0000001', threadId: TID, seq: 1, role: 'user', text: 'hi', blocks: [], status: null, reason: null, model: null, effort: null, usage: null, costUsd: null, durationMs: null, createdAt: 't' }],
    attachments: [], runLinks: [], inFlight: null, ...over,
  };
}

const listRow = (id, inFlight) => ({ id, title: id, updatedAt: 't', createdAt: 't', model: null, effort: null, sessionId: null, context: null, totals: {}, runLinks: 0, inFlight });

function handlerFor(snapshotRef) {
  return (url) => {
    if (url.startsWith(`/api/ask/threads/${TID}`)) return { ok: true, status: 200, json: async () => snapshotRef.body };
    if (url.startsWith('/api/ask/threads')) return { ok: true, status: 200, json: async () => ({ threads: [listRow(TID, !!snapshotRef.body.inFlight)] }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

// Open the sheet, pick the one thread from the History popover (loadThread),
// then COLLAPSE the sheet so the pill is the visible surface again.
async function openCollapsed(snapshotRef, overrides = {}) {
  const ctx = makePanel({ fetchHandler: handlerFor(snapshotRef), ...overrides });
  ctx.panel.open();
  ctx.doc.querySelector('[data-ask-threads-btn]').click();
  await ctx.tick();
  ctx.doc.querySelector('.ask-pop [role="menuitem"]').click();
  await ctx.tick();
  await ctx.tick();
  ctx.flush();
  ctx.panel.close();
  ctx.pill = ctx.doc.querySelector('.ask-pill');
  return ctx;
}

const lit = (pill) => pill.classList.contains('is-live');
const childClasses = (pill) => [...pill.children].map((c) => c.className);
const startFrame = { type: 'ask-start', userMessageId: 'askm_u0000001', model: 'm', effort: 'high', startedAt: 't', threadId: TID, messageId: MID, seq: 1 };

test('pill-live: lit on send / ask-start / an in-flight or adopted turn; at rest on ask-done, ask-error, a failed send, New chat and an idle thread', async () => {
  await checkRows([
    { name: 'pill-live: ask-start lights the collapsed pill; ask-done puts it back to rest; no node is added', run: async () => {
      const ref = { body: snapBody() };
      const ctx = await openCollapsed(ref);
      assert.equal(ctx.pill.hidden, false, 'the pill is the visible surface');
      assert.equal(lit(ctx.pill), false, 'idle thread, dark pill');
      const { frames } = replayFixture('plain-text', { threadId: TID, messageId: MID });
      const done = frames[frames.length - 1];
      for (const f of frames.slice(0, -1)) ctx.panel.pushServerFrame(f);
      ctx.flush();
      assert.equal(lit(ctx.pill), true, 'lit from ask-start while the sheet is closed');
      assert.equal(ctx.pill.hidden, false);
      assert.deepEqual(childClasses(ctx.pill), PILL_CHILDREN, 'the thinking ring is CSS on the button itself, not a new child');
      assert.deepEqual(childClasses(ctx.pill.firstElementChild), MARK_CHILDREN, 'the orb was built with the pill, not on lighting');
      ctx.panel.pushServerFrame(done);
      ctx.flush();
      assert.equal(lit(ctx.pill), false, 'dark after ask-done');
    } },
    { name: 'pill-live: ask-error puts the pill back to rest too', run: async () => {
      const ref = { body: snapBody() };
      const ctx = await openCollapsed(ref);
      const bare = [
        { type: 'ask-start', userMessageId: 'askm_u0000001', model: 'm', effort: 'high', startedAt: 't' },
        { type: 'ask-delta', text: 'partial' },
      ];
      for (const f of stampFrames(bare, { threadId: TID, messageId: MID })) ctx.panel.pushServerFrame(f);
      ctx.flush();
      assert.equal(lit(ctx.pill), true);
      ctx.panel.pushServerFrame({ type: 'ask-error', message: 'claude exited with code 1: boom', errorClass: null, threadId: TID, messageId: MID, seq: 3 });
      ctx.flush();
      assert.equal(lit(ctx.pill), false);
    } },
    { name: 'pill-live: New chat during a live turn puts the pill to rest', run: async () => {
      const ref = { body: snapBody() };
      const ctx = await openCollapsed(ref);
      ctx.panel.pushServerFrame(startFrame);
      ctx.flush();
      assert.equal(lit(ctx.pill), true);
      ctx.panel.open();
      ctx.doc.querySelector('[data-ask-new-btn]').click();
      assert.equal(lit(ctx.pill), false, 'newThread() resets it like Send/Stop');
    } },
    { name: 'pill-live: the pill lights the moment a message is sent and rests again when the send fails', run: async () => {
      let resolvePost = null;
      const handler = (url, opts) => {
        const method = (opts && opts.method) || 'GET';
        if (method === 'POST' && url === '/api/ask/threads') {
          return { ok: true, status: 201, json: async () => ({ thread: { id: TID, title: null, createdAt: 't', updatedAt: 't', model: null, effort: null, sessionId: null, context: null, totals: {} } }) };
        }
        if (method === 'POST' && url === `/api/ask/threads/${TID}/messages`) return new Promise((r) => { resolvePost = r; });
        return { ok: true, status: 200, json: async () => ({}) };
      };
      const ctx = makePanel({ fetchHandler: handler });
      const pill = ctx.doc.querySelector('.ask-pill');
      ctx.panel.open();
      ctx.doc.querySelector('textarea.ask-input').value = 'hello';
      ctx.doc.querySelector('[data-ask-send]').click();
      assert.equal(lit(pill), true, 'lit synchronously on send, before any response');
      for (let i = 0; i < 6 && !resolvePost; i++) await ctx.tick();
      assert.ok(resolvePost, 'the message POST is in flight');
      ctx.panel.close();
      assert.equal(pill.hidden, false);
      assert.equal(lit(pill), true, 'still lit while the POST is pending, pill visible');
      assert.equal(ctx.doc.querySelector('[data-ask-send]').hidden, false, 'Send/Stop are untouched by the early update');
      resolvePost({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
      await ctx.tick();
      await ctx.tick();
      assert.equal(lit(pill), false, 'a failed send rests the pill (the finally block runs updateSendStop)');
      assert.equal(ctx.doc.querySelector('.ask-composer-msg').textContent, 'boom');
    } },
    { name: 'pill-live: loading an in-flight thread lights the pill before any frame; an idle thread darkens it', run: async () => {
      const handler = (url) => {
        if (url.startsWith(`/api/ask/threads/${TID2}`)) return { ok: true, status: 200, json: async () => ({ ...snapBody(), thread: { ...snapBody().thread, id: TID2 } }) };
        if (url.startsWith(`/api/ask/threads/${TID}`)) return { ok: true, status: 200, json: async () => snapBody({ inFlight: { messageId: MID } }) };
        if (url.startsWith('/api/ask/threads')) return { ok: true, status: 200, json: async () => ({ threads: [listRow(TID, true), listRow(TID2, false)] }) };
        return { ok: true, status: 200, json: async () => ({}) };
      };
      const ctx = makePanel({ fetchHandler: handler });
      const pill = ctx.doc.querySelector('.ask-pill');
      ctx.panel.open();
      const pick = async (i) => {
        ctx.doc.querySelector('[data-ask-threads-btn]').click();
        await ctx.tick();
        ctx.doc.querySelectorAll('.ask-pop [role="menuitem"]')[i].click();
        await ctx.tick();
        await ctx.tick();
        ctx.flush();
      };
      await pick(0);
      assert.equal(lit(pill), true, 'snapshot.inFlight lights the pill with no frame seen (D3)');
      ctx.panel.close();
      assert.equal(pill.hidden, false);
      assert.equal(lit(pill), true, 'collapsing the sheet does not touch the state');
      ctx.panel.open();
      await pick(1);
      assert.equal(lit(pill), false, 'the idle thread darkens it — the same reset as the Stop button');
    } },
    { name: 'pill-live: a frame adopted mid-turn keeps the pill lit; ask-done ends it', run: async () => {
      const ref = { body: snapBody({ inFlight: { messageId: MID } }) };
      const ctx = await openCollapsed(ref);
      assert.equal(lit(ctx.pill), true);
      ctx.panel.pushServerFrame({ type: 'ask-delta', text: 'adopted', threadId: TID, messageId: MID, seq: 77 });
      ctx.flush();
      assert.equal(lit(ctx.pill), true, 'adoption (no ask-start seen) is still a live turn');
      ctx.panel.pushServerFrame({ type: 'ask-done', text: 'adopted', status: 'done', reason: null, threadId: TID, messageId: MID, seq: 78 });
      ctx.flush();
      assert.equal(lit(ctx.pill), false);
    } },
  ]);
});

// ---- the pill orb loop: canvas frames only while lit AND visible ---------------
// With `orb: true` the harness records rAF and the arcs painted per canvas;
// `painted()` runs the pending frames once and reports whether the PILL's
// canvas (the one under .ask-pill-mark — the transcript orb paints its own)
// received any, i.e. whether the pill orb's loop is armed. The orbs' clock is
// `ctx.orbFrames.t`, so the morph tween is stepped by hand.
const pillCanvas = (ctx) => ctx.doc.querySelector('.ask-pill-mark canvas');
const arcsOf = (ctx, cv) => ctx.orbFrames.paints.get(cv) || [];
function painted(ctx, cv) {
  const before = arcsOf(ctx, cv).length;
  ctx.orbFrames.run();
  return arcsOf(ctx, cv).length > before;
}
const reach = (ctx, cv) => Math.max(...arcsOf(ctx, cv).slice(-46).map(([x, y]) => Math.hypot(x - 11, y - 11)));
const doneFrame = { type: 'ask-done', text: 'x', status: 'done', reason: null, threadId: TID, messageId: MID, seq: 2 };
const endTransition = (ctx, propertyName = 'opacity') => {
  const orb = ctx.doc.querySelector('.ask-pill-mark .ask-orb');
  orb.dispatchEvent(new ctx.window.TransitionEvent('transitionend', { propertyName, bubbles: true }));
};

test('pill-live: the rAF loop runs only while lit, stops after the morph-back (transitionend or timeout) and on destroy', async () => {
  await checkRows([
    { name: 'pill-live: with rAF the pill orb mounts a canvas, arms nothing at rest, loops once lit, and destroy() cuts it', run: async () => {
      const ref = { body: snapBody() };
      const ctx = await openCollapsed(ref, { orb: true });
      const cv = pillCanvas(ctx);
      assert.ok(cv, 'the pill orb mounted a canvas');
      assert.equal(painted(ctx, cv), false, 'rest: the factory-armed frame was cancelled at build, nothing paints');
      ctx.panel.pushServerFrame(startFrame);
      ctx.flush();
      assert.equal(painted(ctx, cv), true, 'lit and visible: the loop paints the pill canvas');
      assert.equal(painted(ctx, cv), true, 'and re-arms itself every frame');
      ctx.panel.destroy();
      assert.equal(painted(ctx, cv), false, 'destroy() cuts the loop');
    } },
    { name: 'pill-live: after ask-done the loop keeps painting through the morph-back and stops on the transitionend', run: async () => {
      const ref = { body: snapBody() };
      const ctx = await openCollapsed(ref, { orb: true });
      const cv = pillCanvas(ctx);
      ctx.orbFrames.t = 1000;
      ctx.panel.pushServerFrame(startFrame); ctx.flush();
      ctx.orbFrames.t = 2000;
      assert.equal(painted(ctx, cv), true);
      ctx.panel.pushServerFrame(doneFrame); ctx.flush();
      assert.equal(lit(ctx.pill), false);
      ctx.orbFrames.t = 2400;
      assert.equal(painted(ctx, cv), true, 'dark but visible: the dots sink back on the canvas while CSS fades it');
      const sinking = reach(ctx, cv);
      assert.ok(sinking > 0.3 && sinking < 6, `half way back (${sinking.toFixed(2)}px)`);
      endTransition(ctx, 'transform');
      assert.equal(painted(ctx, cv), true, 'only the opacity transition ends the morph-back');
      endTransition(ctx);
      assert.equal(painted(ctx, cv), false, 'settled: the loop is cut');
      ctx.panel.destroy();
    } },
    { name: 'pill-live: without a transitionend the morph-back settles on a timeout', run: async () => {
      const ref = { body: snapBody() };
      const ctx = await openCollapsed(ref, { orb: true });
      const cv = pillCanvas(ctx);
      ctx.panel.pushServerFrame(startFrame); ctx.flush();
      mock.timers.enable({ apis: ['setTimeout'] });
      try {
        ctx.panel.pushServerFrame(doneFrame); ctx.flush();
        assert.equal(painted(ctx, cv), true, 'morph-back in progress');
        mock.timers.tick(600);
        assert.equal(painted(ctx, cv), true, 'the ~.8s morph-back is not over at 600ms');
        mock.timers.tick(600);
        assert.equal(painted(ctx, cv), false, 'the fallback timer settled it');
      } finally { mock.timers.reset(); }
      ctx.panel.destroy();
    } },
  ]);
});
