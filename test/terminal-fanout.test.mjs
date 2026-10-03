// test/terminal-fanout.test.mjs — term-* frames reach the right sockets; a slow socket is resynced, not flooded (#573, D15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalFanout } from '../src/core/terminal/fanout.mjs';

const fakeWs = ({ allowed = true, attached = [] } = {}) => ({ OPEN: 1, readyState: 1, bufferedAmount: 0, terminalAllowed: allowed,
  termAttached: new Set(attached), sent: [], send(t) { this.sent.push(JSON.parse(t)); } });
const data = (seq) => ({ type: 'term-data', sessionId: 't-1', data: `d${seq}`, seq });

test('output goes to attached sockets only; status to every allowed socket', () => {
  const a = fakeWs({ attached: ['t-1'] });
  const b = fakeWs();
  const c = fakeWs({ allowed: false });
  const fan = createTerminalFanout({ sockets: new Set([a, b, c]), replayFrame: () => null });
  fan.toAttached('t-1', data(1));
  fan.toAllowed({ type: 'term-status', snapshot: { id: 't-1' } });
  assert.deepEqual(a.sent.map((f) => f.type), ['term-data', 'term-status']);
  assert.deepEqual(b.sent.map((f) => f.type), ['term-status']);
  assert.deepEqual(c.sent, []);
});

test('a socket over the high mark skips term-data, still gets blocks, and gets one replay once drained', async () => {
  const ws = fakeWs({ attached: ['t-1'] });
  const fan = createTerminalFanout({ sockets: new Set([ws]), high: 100, low: 10, poll: 5,
    replayFrame: (id) => ({ type: 'term-replay', sessionId: id, data: 'TAIL', seq: 9 }) });
  fan.toAttached('t-1', data(1));
  ws.bufferedAmount = 500;
  fan.toAttached('t-1', data(2));
  fan.toAttached('t-1', { type: 'term-block', sessionId: 't-1', block: { seq: 1 } });
  ws.bufferedAmount = 50;                                   // under high, over low: still lagging
  fan.toAttached('t-1', data(3));
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ws.sent.map((f) => f.type), ['term-data', 'term-block']);
  ws.bufferedAmount = 0;
  await new Promise((r) => setTimeout(r, 30));
  fan.toAttached('t-1', data(10));
  assert.deepEqual(ws.sent.map((f) => `${f.type}:${f.seq ?? ''}`), ['term-data:1', 'term-block:', 'term-replay:9', 'term-data:10']);
});

test('a lagging socket that detaches or closes gets no replay', async () => {
  const ws = fakeWs({ attached: ['t-1'] });
  const fan = createTerminalFanout({ sockets: new Set([ws]), high: 100, low: 10, poll: 5, replayFrame: () => ({ type: 'term-replay' }) });
  ws.bufferedAmount = 500;
  fan.toAttached('t-1', data(1));
  ws.termAttached.delete('t-1');
  ws.bufferedAmount = 0;
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ws.sent, []);
  assert.equal(ws.termLagging.size, 0);
});
