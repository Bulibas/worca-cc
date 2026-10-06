// test/helpers/issuer-jwt.mjs
// A local stand-in for an identity issuer such as the hosted platform's control plane: a P-256
// key pair, its JWKS, and a signer for X-Worca-Identity tokens with the platform's claims. No
// network: `jwksFetch` is a fetchImpl for createIssuerVerifier.
import { generateKeyPairSync, sign } from 'node:crypto';

export const ISSUER = 'https://app.example.dev';
export const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
export const INSTANCE_HOST = 'k7m2qz9xwp.example.run';

export function makeIssuerKey(kid = 'es-1') {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' };
  return { kid, privateKey, jwk };
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

/** Sign a token; `claims` override the valid defaults, `header` overrides alg/kid. */
export function signIssuerJwt(key, claims = {}, header = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'ES256', kid: key.kid, typ: 'JWT', ...header });
  const p = b64({
    iss: ISSUER, aud: INSTANCE_HOST, sub: 'usr_ada', email: 'ada@example.com', name: 'Ada',
    org: 'org_1', inst: 'inst_1', teams: ['team_mobile'], iat: now, exp: now + 300, ...claims,
  });
  const sig = sign('SHA256', Buffer.from(`${h}.${p}`), { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${h}.${p}.${sig}`;
}

/** fetchImpl serving `keysRef.keys` (mutable, for rotation) and counting calls. */
export function jwksFetch(keysRef, url = JWKS_URL) {
  const f = async (u) => {
    f.calls += 1;
    if (String(u) !== url) return new Response('not found', { status: 404 });
    if (keysRef.down) return new Response('down', { status: 502 });
    return Response.json({ keys: keysRef.keys.map((k) => k.jwk) });
  };
  f.calls = 0;
  return f;
}
