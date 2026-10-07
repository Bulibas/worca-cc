// test/api-remote-access-issuer.test.mjs
// ui/server.mjs behind a gate with its own identity issuer (W1, W4, W7), configured the way the
// hosted platform configures an instance: exact host, WORCA_IDENTITY_ISSUER / _JWKS_URL /
// _AUDIENCE. The JWKS endpoint is a patched global fetch, so no network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';

import { useTempHome } from './helpers/temp-home.mjs';
import { ISSUER, JWKS_URL, INSTANCE_HOST, makeIssuerKey, signIssuerJwt, jwksFetch } from './helpers/issuer-jwt.mjs';

useTempHome(after);

const key = makeIssuerKey();
const fakeJwks = jwksFetch({ keys: [key] });
const realFetch = globalThis.fetch;
const ENV = {
  WORCA_MOCK: '1',
  WORCA_ALLOWED_HOSTS: INSTANCE_HOST,
  WORCA_IDENTITY_ISSUER: ISSUER,
  WORCA_IDENTITY_JWKS_URL: JWKS_URL,
  WORCA_IDENTITY_AUDIENCE: INSTANCE_HOST,
};
let srv, port, mod;

before(async () => {
  Object.assign(process.env, ENV);
  globalThis.fetch = (url, opts) => (String(url) === JWKS_URL ? fakeJwks(url) : realFetch(url, opts));
  mod = await import('../ui/server.mjs');
  srv = mod.server;
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  port = srv.address().port;
});

after(async () => {
  if (srv) await new Promise((r) => srv.close(r));
  globalThis.fetch = realFetch;
  for (const k of Object.keys(ENV)) delete process.env[k];
});

function get(path, headers = {}) {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port, path, headers: { host: INSTANCE_HOST, ...headers } }, (resp) => {
      let body = '';
      resp.setEncoding('utf8');
      resp.on('data', (c) => { body += c; });
      resp.on('end', () => res({ status: resp.statusCode, body: body ? JSON.parse(body) : null }));
    });
    r.on('error', rej);
    r.end();
  });
}
const withToken = (claims) => ({ 'x-worca-identity': signIssuerJwt(key, claims) });

test('no token -> 401 with a sign-in hint; a valid token passes', async () => {
  const r = await get('/api/projects');
  assert.equal(r.status, 401);
  assert.match(r.body.error, /^unauthorized: sign in through/);
  assert.equal((await get('/api/projects', { ...withToken(), origin: `https://${INSTANCE_HOST}` })).status, 200);
});

test('refused: another instance\'s token, an expired one, a Cloudflare Access header', async () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await get('/api/projects', withToken({ aud: 'sibling.example.run' }))).status, 401);
  assert.equal((await get('/api/projects', withToken({ exp: now - 300 }))).status, 401);
  assert.equal((await get('/api/projects', { 'cf-access-jwt-assertion': signIssuerJwt(key) })).status, 401);
});

test('W2: a sibling instance\'s page (Origin) is refused even with a valid token', async () => {
  const r = await get('/api/projects', { ...withToken(), origin: 'https://sibling.example.run' });
  assert.equal(r.status, 403);
});

test('/api/health stays open for the platform\'s probe, name + version only', async () => {
  const r = await get('/api/health');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['name', 'version']);
});

test('W4: the token\'s email is who started things (attribution unchanged)', async () => {
  const { resolveIdentity } = await import('../src/core/identity.mjs');
  const who = resolveIdentity({ worcaUser: { email: 'ada@example.com', sub: 'usr_ada', provider: 'issuer' }, headers: {} });
  assert.deepEqual(who, { name: 'ada@example.com', source: 'access' });
});

function wsOpen(headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    ws.on('open', () => resolve({ ws }));
    ws.on('unexpected-response', (_req, resp) => { resolve({ status: resp.statusCode }); resp.resume(); });
    ws.on('error', () => resolve({ status: 'error' }));
  });
}

test('WebSocket: token required; refused for another instance', async () => {
  const origin = `https://${INSTANCE_HOST}`;
  assert.equal((await wsOpen({ host: INSTANCE_HOST, origin })).status, 401);
  assert.equal((await wsOpen({ host: INSTANCE_HOST, origin, ...withToken({ aud: 'sibling.example.run' }) })).status, 401);
  const { ws } = await wsOpen({ host: INSTANCE_HOST, origin, ...withToken() });
  assert.ok(ws, 'opens with a valid token');
  ws.close();
});

test('W7: the server closes the socket with 4001 when its token expires', async () => {
  const exp = Math.floor(Date.now() / 1000) + 2;
  const { ws } = await wsOpen({ host: INSTANCE_HOST, origin: `https://${INSTANCE_HOST}`, ...withToken({ exp }) });
  assert.ok(ws);
  const started = Date.now();
  const code = await new Promise((resolve) => ws.on('close', (c) => resolve(c)));
  assert.equal(code, mod.WS_TOKEN_EXPIRED);
  assert.equal(code, 4001);
  assert.ok(Date.now() - started < 4000, 'closed around the expiry, not later');
});

test('W7: closeAtTokenExpiry ignores identities without an issuer token (Access, local)', () => {
  const { closeAtTokenExpiry } = mod._testing;
  const fake = { close() { throw new Error('must not close'); }, once() {} };
  assert.equal(closeAtTokenExpiry(fake, { email: 'a@b.c', sub: 'x' }), null, 'Access identity');
  assert.equal(closeAtTokenExpiry(fake, { local: true }), null);
  assert.equal(closeAtTokenExpiry(fake, undefined), null);
});
