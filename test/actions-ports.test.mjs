import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { parsePortRange, allocatePort, probePort, DEFAULT_PORT_RANGE } from '../src/core/actions/ports.mjs';

test('range defaults and validation', () => {
  assert.deepEqual(parsePortRange({}), DEFAULT_PORT_RANGE);
  assert.deepEqual(parsePortRange({ portLow: 5000, portHigh: 5010 }), { low: 5000, high: 5010 });
  assert.throws(() => parsePortRange({ portLow: 5010, portHigh: 5000 }, { strict: true }), /low/);
  assert.throws(() => parsePortRange({ portLow: 80, portHigh: 90 }, { strict: true }), /1024/);
});

test('skips held ports and ports bound by someone else', async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const busy = blocker.address().port;
  const got = await allocatePort({ range: { low: busy, high: busy + 3 }, held: new Set([busy + 1]) });
  assert.ok(got === busy + 2 || got === busy + 3, `got ${got}`);
  blocker.close();
});

test('throws PORTS_EXHAUSTED when the range is full', async () => {
  await assert.rejects(allocatePort({ range: { low: 4400, high: 4401 }, held: new Set([4400, 4401]) }),
    (e) => e.code === 'PORTS_EXHAUSTED');
});

test('probePort is false for a bound port (loopback or wildcard)', async () => {
  const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  assert.equal(await probePort(s.address().port), false);
  s.close();
  const w = net.createServer(); await new Promise((r) => w.listen(0, r));      // wildcard, like most dev servers
  assert.equal(await probePort(w.address().port), false);
  w.close();
});

test('probePort is false for a port held on ::1 only (Vite/Storybook on macOS)', async (t) => {
  const v6 = net.createServer();
  const ok = await new Promise((r) => { v6.once('error', () => r(false)); v6.listen(0, '::1', () => r(true)); });
  if (!ok) return t.skip('no IPv6 loopback on this host');
  assert.equal(await probePort(v6.address().port), false);
  v6.close();
});
