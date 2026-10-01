// test/env-proxy.test.mjs
// useEnvProxy(): Node's fetch() ignores HTTP(S)_PROXY unless the process opts in, so on a
// proxy-only network every outbound call died with "fetch failed" (Copilot sign-in first).
// Unit cases use a fake `api`; the last case runs Node's real API against a local proxy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { useEnvProxy } from '../src/core/env-proxy.mjs';

function fakeApi() {
  const calls = [];
  return { calls, setGlobalProxyFromEnv: (env) => { calls.push(env); return () => {}; } };
}

test('no proxy variables: fetch is left alone', () => {
  const api = fakeApi();
  assert.equal(useEnvProxy({ env: { NO_PROXY: 'corp.example' }, api }).status, 'off');
  assert.equal(api.calls.length, 0);
});

test('a proxy is set: loopback is appended to NO_PROXY, the existing entries kept', () => {
  const api = fakeApi();
  const r = useEnvProxy({ env: { HTTPS_PROXY: 'http://proxy.corp:8080', no_proxy: 'corp.example' }, api });
  assert.equal(r.status, 'on');
  assert.equal(api.calls.length, 1);
  const passed = api.calls[0];
  assert.equal(passed.HTTPS_PROXY, 'http://proxy.corp:8080');
  assert.equal(passed.no_proxy, 'corp.example,localhost,127.0.0.1,::1');
  assert.equal(passed.NO_PROXY, passed.no_proxy);
});

test('a proxy with no NO_PROXY at all still keeps loopback direct', () => {
  const api = fakeApi();
  useEnvProxy({ env: { http_proxy: 'http://proxy.corp:8080' }, api });
  assert.equal(api.calls[0].NO_PROXY, 'localhost,127.0.0.1,::1');
});

test('a Node without setGlobalProxyFromEnv: unsupported, never throws', () => {
  assert.equal(useEnvProxy({ env: { HTTPS_PROXY: 'http://proxy.corp:8080' }, api: {} }).status, 'unsupported');
});

test('a malformed proxy URL: invalid, never throws', { skip: typeof http.setGlobalProxyFromEnv !== 'function' }, () => {
  const r = useEnvProxy({ env: { HTTPS_PROXY: 'http://[not-a-host' } });
  assert.equal(r.status, 'invalid');
  assert.match(r.error, /proxy/i);
});

test('real fetch: an outside host goes through the proxy, loopback goes direct', { skip: typeof http.setGlobalProxyFromEnv !== 'function' }, async () => {
  const seen = [];
  // The proxy only records what it was asked for (absolute-form GET or CONNECT), then refuses.
  const proxy = http.createServer((req, res) => { seen.push(req.url); res.writeHead(502).end(); });
  proxy.on('connect', (req, socket) => { seen.push(req.url); socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
  const direct = http.createServer((req, res) => res.end('direct'));
  await Promise.all([proxy, direct].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const r = useEnvProxy({ env: { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl } });
  try {
    assert.equal(r.status, 'on');
    await fetch('http://upstream.invalid/login/device/code').catch(() => {});
    assert.ok(seen.some((u) => u.includes('upstream.invalid')), `the proxy saw: ${JSON.stringify(seen)}`);
    const res = await fetch(`http://127.0.0.1:${direct.address().port}/`);
    assert.equal(await res.text(), 'direct');
    assert.ok(!seen.some((u) => u.includes('127.0.0.1')), 'loopback must not reach the proxy');
  } finally {
    r.restore();
    await Promise.all([proxy, direct].map((s) => new Promise((done) => { s.closeAllConnections?.(); s.close(done); })));
  }
});
