// test/server-mock-mode.test.mjs
// The server's mock mode (#510): WORCA_MOCK / ORCH_MOCK force EVERY run to mock, whatever the
// request says, so the WS hello tells the UI (`serverMock`) and the UI locks its Mock switch on.
// Read per connection, so one import covers all three environments.
// Boot = the ask-api-threads recipe (temp home BEFORE the dynamic import; listen on the MODULE
// server so /ws upgrades work).
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

import { useTempHome } from './helpers/temp-home.mjs';

useTempHome(after);

let srv, wsBase;
const saved = { WORCA_MOCK: process.env.WORCA_MOCK, ORCH_MOCK: process.env.ORCH_MOCK };

before(async () => {
  delete process.env.WORCA_MOCK;
  delete process.env.ORCH_MOCK;
  const mod = await import('../ui/server.mjs');
  srv = mod.server;
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  wsBase = `ws://127.0.0.1:${srv.address().port}/ws`;
});

afterEach(() => {
  delete process.env.WORCA_MOCK;
  delete process.env.ORCH_MOCK;
});

after(async () => {
  if (srv) {
    await Promise.race([
      new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); }),
      new Promise((r) => { const t = setTimeout(r, 500); t.unref?.(); }),
    ]);
  }
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

function hello() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBase);
    const t = setTimeout(() => { ws.terminate(); reject(new Error('no hello')); }, 3000);
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.type !== 'hello') return;
      clearTimeout(t);
      ws.close();
      resolve(msg);
    });
    ws.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

test('hello: serverMock is false when neither WORCA_MOCK nor ORCH_MOCK is set', async () => {
  assert.equal((await hello()).serverMock, false);
});

test('hello: serverMock is true with WORCA_MOCK=1', async () => {
  process.env.WORCA_MOCK = '1';
  assert.equal((await hello()).serverMock, true);
});

test('hello: serverMock is true with ORCH_MOCK=1, the same as WORCA_MOCK', async () => {
  process.env.ORCH_MOCK = '1';
  assert.equal((await hello()).serverMock, true);
});

test('hello: a falsy WORCA_MOCK is off', async () => {
  process.env.WORCA_MOCK = '0';
  assert.equal((await hello()).serverMock, false);
});
