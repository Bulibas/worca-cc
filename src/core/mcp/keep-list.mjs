// src/core/mcp/keep-list.mjs
// The environment a registry stdio server may inherit (MCP registry §5.5.1): the MCP SDK's default
// stdio list extended with the locale, temp and Windows shell names, plus the proxy and CA names.
// Everything else — model and GitHub credentials, SSH_AUTH_SOCK, worca's own variables, every
// MCPSECRET_* — stays out. Shared by the launcher, Test, and scrubbed spawns' envAllowlist.

const POSIX_NAMES = ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER', 'TMPDIR', 'LANG'];   // + every LC_*
const WIN32_NAMES = ['APPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'COMSPEC',
  'PROCESSOR_ARCHITECTURE', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERNAME', 'USERPROFILE', 'PROGRAMFILES'];
const NET_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE'];

/** The keep-list names present in `env`, in the casing `env` enumerates them (compared case-insensitively
 *  on win32, where env names are), sorted. On POSIX every LC_* counts. */
export function keepListNames(env = process.env, platform = process.platform) {
  const win = platform === 'win32';
  const fold = (k) => (win ? k.toUpperCase() : k);
  const wanted = new Set([...(win ? WIN32_NAMES : POSIX_NAMES), ...NET_NAMES].map(fold));
  return Object.keys(env)
    .filter((k) => typeof env[k] === 'string' && (wanted.has(fold(k)) || (!win && k.startsWith('LC_'))))
    .sort();
}

/** { name: value } for keepListNames(env, platform). */
export function keepListEnv(env = process.env, platform = process.platform) {
  const out = {};
  for (const k of keepListNames(env, platform)) out[k] = env[k];
  return out;
}
