// src/core/env-proxy.mjs
// Node's built-in fetch() ignores HTTP_PROXY / HTTPS_PROXY / NO_PROXY unless the process
// opts in (--use-env-proxy or NODE_USE_ENV_PROXY=1, both read only at startup). On a
// network whose only way out is a proxy (a corporate LAN), every outbound call then died
// with "fetch failed" (ENOTFOUND github.com: Copilot sign-in) while curl and git, which
// honor the variables, worked. Each process entry point (ui/server.mjs, the CLI) calls
// useEnvProxy() once at boot, through http.setGlobalProxyFromEnv (newer Node).
//
// Loopback always bypasses the proxy: the app calls itself (the model bridge, the UI
// probe, the broker on this host), and a machine with HTTP_PROXY but no NO_PROXY would
// otherwise send those calls to the proxy. Nothing here throws: no proxy set, an older
// Node, or a malformed proxy URL leaves fetch exactly as it was.

import http from 'node:http';

const LOOPBACK = ['localhost', '127.0.0.1', '::1'];

/**
 * Route this process's fetch() and http(s) global agents through the proxy named by the
 * environment, with loopback always direct.
 * @param {{env?: Record<string, string|undefined>, api?: {setGlobalProxyFromEnv?: Function}}} [opts]
 * @returns {{status: 'off'|'on'|'unsupported'|'invalid', error?: string, restore: () => void}}
 */
export function useEnvProxy({ env = process.env, api = http } = {}) {
  const none = () => {};
  const proxied = env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY;
  if (!proxied) return { status: 'off', restore: none };
  if (typeof api.setGlobalProxyFromEnv !== 'function') return { status: 'unsupported', restore: none };
  // Node reads no_proxy before NO_PROXY; set both so the merged list wins either way.
  const listed = String(env.no_proxy || env.NO_PROXY || '').split(',').map((s) => s.trim()).filter(Boolean);
  const noProxy = [...listed, ...LOOPBACK.filter((h) => !listed.includes(h))].join(',');
  try {
    const restore = api.setGlobalProxyFromEnv({ ...env, no_proxy: noProxy, NO_PROXY: noProxy });
    return { status: 'on', restore: typeof restore === 'function' ? restore : none };
  } catch (err) {
    // Node's message for a bad URL is the URL itself, and proxy URLs often carry user:password.
    const error = err && err.code === 'ERR_PROXY_INVALID_CONFIG'
      ? 'HTTP_PROXY / HTTPS_PROXY is not a valid proxy URL'
      : (err && err.message) || String(err);
    return { status: 'invalid', error, restore: none };
  }
}
