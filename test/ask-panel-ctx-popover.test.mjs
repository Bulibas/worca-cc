// test/ask-panel-ctx-popover.test.mjs — the composer's context popover: window fill + the chat's topics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtShare, ctxBreakdown, groupContexts } from '../ui/public/ask-panel.mjs';

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
