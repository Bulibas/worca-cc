// src/broker/copilot.mjs
// GitHub Copilot inside the credential broker (plans/credential-broker-design.html §5.3).
// A person signs in on the key page with GitHub's device flow; the broker keeps their
// GitHub token sealed in the vault and, per request, exchanges it for Copilot's
// short-lived API token (cached until shortly before it expires). worca never sees
// either token. The editor headers and endpoints are the ones worca's own Copilot
// provider uses (src/core/bridge/providers/copilot.mjs), imported from there.
import { githubHeaders, GITHUB_API, GITHUB_BASE, GITHUB_CLIENT_ID, GITHUB_SCOPES } from '../core/bridge/providers/copilot.mjs';

export const DEFAULT_EXCHANGE_URL = `${GITHUB_API}/copilot_internal/v2/token`;
const REFRESH_MARGIN_MS = 60_000;

/** A Copilot API host must be GitHub's (the exchange response names it; never trust anything else). */
export function isCopilotHost(origin) {
  try {
    const u = new URL(origin);
    return u.protocol === 'https:' && (u.hostname === 'githubcopilot.com' || u.hostname.endsWith('.githubcopilot.com'));
  } catch { return false; }
}

/**
 * The exchange, cached per GitHub token.
 * @param {{fetchImpl?:typeof fetch, exchangeUrl?:string, now?:()=>number, defaultHost?:string, allowHost?:(o:string)=>boolean}} o
 */
export function createCopilotExchange({ fetchImpl = globalThis.fetch, exchangeUrl = DEFAULT_EXCHANGE_URL, now = Date.now, defaultHost = 'https://api.githubcopilot.com', allowHost = isCopilotHost } = {}) {
  const cache = new Map();   // github token -> {token, host, expiresAt}
  return {
    /** {token, host} or throws with .status (401/403 = the GitHub sign-in no longer works). */
    async token(githubToken, { force = false } = {}) {
      const hit = cache.get(githubToken);
      if (!force && hit && hit.expiresAt - REFRESH_MARGIN_MS > now()) return hit;
      const res = await fetchImpl(exchangeUrl, { headers: githubHeaders(githubToken) });
      if (!res.ok) {
        cache.delete(githubToken);
        const err = new Error(res.status === 401 || res.status === 403
          ? `GitHub refused the sign-in (${res.status}): sign in to Copilot again`
          : `the Copilot token exchange failed (HTTP ${res.status})`);
        err.status = res.status;
        throw err;
      }
      const j = await res.json();
      if (!j || typeof j.token !== 'string') throw new Error('the Copilot token exchange returned no token');
      let host = defaultHost;
      const api = j.endpoints && typeof j.endpoints.api === 'string' ? j.endpoints.api.replace(/\/+$/, '') : null;
      if (api && allowHost(api)) host = new URL(api).origin;
      const expiresAt = Number.isFinite(j.expires_at) ? j.expires_at * 1000 : now() + 25 * 60_000;
      const v = { token: j.token, host, expiresAt };
      cache.set(githubToken, v);
      return v;
    },
    invalidate(githubToken) { cache.delete(githubToken); },
  };
}

/** GitHub's device flow, step 1: a code for the person to enter at github.com/login/device. */
export async function startDeviceFlow({ fetchImpl = globalThis.fetch, baseUrl = GITHUB_BASE } = {}) {
  const res = await fetchImpl(`${baseUrl}/login/device/code`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: GITHUB_SCOPES }),
  });
  if (!res.ok) throw new Error(`GitHub device sign-in failed (HTTP ${res.status})`);
  const j = await res.json();
  if (!j.device_code || !j.user_code) throw new Error('GitHub returned no device code');
  return { deviceCode: j.device_code, userCode: j.user_code, verificationUri: j.verification_uri || 'https://github.com/login/device', interval: Number(j.interval) || 5, expiresIn: Number(j.expires_in) || 900 };
}

/** Step 2, polled: {token} once the person approved, {pending:true} before, {error} when it failed. */
export async function pollDeviceFlow(deviceCode, { fetchImpl = globalThis.fetch, baseUrl = GITHUB_BASE } = {}) {
  const res = await fetchImpl(`${baseUrl}/login/oauth/access_token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
  });
  const j = await res.json().catch(() => ({}));
  if (j.access_token) return { token: j.access_token };
  if (j.error === 'authorization_pending' || j.error === 'slow_down') return { pending: true, slowDown: j.error === 'slow_down' };
  return { error: j.error_description || j.error || `HTTP ${res.status}` };
}
