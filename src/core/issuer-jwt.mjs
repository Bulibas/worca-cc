// Identity tokens from a configured issuer (docs/remote-access.md, "A sign-in service of your
// own"). A gate in front of worca, such as the hosted platform's, signs a short-lived JWT per
// request and sends it in `X-Worca-Identity`; worca checks it against the issuer's published keys
// (a JWKS URL) with this host as the audience. The Cloudflare Access verifier (cf-access.mjs) is
// separate and unchanged; one deployment uses one or the other (remote-access.mjs).
//
// ES256 and RS256. Keys are cached 10 min and refetched on an unknown `kid` (key rotation) at most
// once per 30 s. node:crypto only.
import { createPublicKey, verify } from 'node:crypto';

const KEYS_TTL_MS = 600_000;
const REFETCH_MIN_MS = 30_000;
const CLOCK_SKEW_S = 30;

const ALGS = {
  ES256: { hash: 'SHA256', kty: 'EC', dsaEncoding: 'ieee-p1363' },
  RS256: { hash: 'RSA-SHA256', kty: 'RSA' },
};

/** "https://app.example.com/" -> "https://app.example.com" (an issuer compares exactly, minus a trailing slash). */
export function normalizeIssuer(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

const str = (v, max = 200) => (typeof v === 'string' && v.length <= max ? v : null);
const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length <= 128).slice(0, 100) : []);

/**
 * @returns {(token: string) => Promise<{ email, sub, name, org, inst, teams: string[], exp: number } | null>}
 *   the identity for a valid token, null for any invalid one; rejects only when the keys cannot be
 *   loaded (the caller answers 503, not 401).
 */
export function createIssuerVerifier({ issuer, jwksUrl, audience, fetchImpl = fetch, now = () => Date.now() }) {
  const iss = normalizeIssuer(issuer);
  if (!iss) throw new Error('createIssuerVerifier: issuer is required');
  if (!jwksUrl) throw new Error('createIssuerVerifier: jwksUrl is required');
  const auds = (Array.isArray(audience) ? audience : [audience]).map((a) => String(a || '').trim().toLowerCase()).filter(Boolean);
  if (!auds.length) throw new Error('createIssuerVerifier: audience is required');
  let keys = new Map();
  let fetchedAt = 0;
  let inflight = null;

  async function fetchKeys() {
    const res = await fetchImpl(jwksUrl);
    if (!res.ok) throw new Error(`identity issuer keys: HTTP ${res.status}`);
    const body = await res.json();
    const next = new Map();
    for (const k of Array.isArray(body?.keys) ? body.keys : []) {
      if (typeof k?.kid !== 'string' || (k.kty !== 'EC' && k.kty !== 'RSA')) continue;
      if (k.use && k.use !== 'sig') continue;
      try { next.set(k.kid, { kty: k.kty, key: createPublicKey({ key: k, format: 'jwk' }) }); } catch { /* skip a malformed key */ }
    }
    if (!next.size) throw new Error('identity issuer keys: no usable keys');
    keys = next;
    fetchedAt = now();
  }

  async function loadKeys(force) {
    const age = now() - fetchedAt;
    if (keys.size && age < (force ? REFETCH_MIN_MS : KEYS_TTL_MS)) return;
    inflight ||= fetchKeys().finally(() => { inflight = null; });
    try {
      await inflight;
    } catch (err) {
      if (!keys.size) throw err; // stale keys beat none
    }
  }

  const decode = (seg) => JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));

  return async function verifyIssuerJwt(token) {
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 3 || parts.some((p) => !p)) return null;
    let header, payload;
    try { header = decode(parts[0]); payload = decode(parts[1]); } catch { return null; }
    const alg = ALGS[header?.alg];
    if (!alg || typeof header.kid !== 'string') return null;
    if (!payload || typeof payload !== 'object') return null;

    await loadKeys(false);
    if (!keys.has(header.kid)) await loadKeys(true);
    const entry = keys.get(header.kid);
    if (!entry || entry.kty !== alg.kty) return null;

    let ok = false;
    try {
      const data = Buffer.from(`${parts[0]}.${parts[1]}`);
      const sig = Buffer.from(parts[2], 'base64url');
      ok = alg.dsaEncoding
        ? verify(alg.hash, data, { key: entry.key, dsaEncoding: alg.dsaEncoding }, sig)
        : verify(alg.hash, data, entry.key, sig);
    } catch { ok = false; }
    if (!ok) return null;

    const t = Math.floor(now() / 1000);
    const tokenAuds = (Array.isArray(payload.aud) ? payload.aud : [payload.aud]).map((a) => String(a || '').toLowerCase());
    if (normalizeIssuer(payload.iss) !== iss || !tokenAuds.some((a) => auds.includes(a))) return null;
    if (typeof payload.exp !== 'number' || payload.exp < t - CLOCK_SKEW_S) return null;
    if (typeof payload.nbf === 'number' && payload.nbf > t + CLOCK_SKEW_S) return null;
    const email = str(payload.email);
    const sub = str(payload.sub, 128);
    if (!email && !sub) return null;
    return {
      email,
      sub,
      name: str(payload.name),
      org: str(payload.org, 128),
      inst: str(payload.inst, 128),
      teams: ids(payload.teams),
      exp: payload.exp,
    };
  };
}
