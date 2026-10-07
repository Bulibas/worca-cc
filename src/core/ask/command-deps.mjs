// src/core/ask/command-deps.mjs
// Ask agent mode (#574): the MCP child's half of the command tools. The terminals live in the worca
// server, so the classic child forwards each call to POST /api/ask/commands (loopback only). The URL
// rides mcpServers.env (WORCA_ASK_COMMANDS, not secret); the per-turn token rides the claude process
// env (ASK_COMMAND_TOKEN, buildAskSpawnOptions spawnEnv) and never touches disk. There is no relay-mode
// path: under agent isolation agent mode is off (the terminal refuses agent callers).
export function defaultCommandDeps({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  let cfg = null;
  try { cfg = JSON.parse(env.WORCA_ASK_COMMANDS || 'null'); } catch { cfg = null; }
  const token = typeof env.ASK_COMMAND_TOKEN === 'string' ? env.ASK_COMMAND_TOKEN : '';
  if (!cfg || typeof cfg.url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\//.test(cfg.url) || !token) return {};
  const call = (op) => async (input) => {
    const res = await fetchImpl(cfg.url, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-worca-ask-command': token },
      body: JSON.stringify({ op, input }) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `worca answered HTTP ${res.status}`);
    return j.result;
  };
  return { commands: { run: call('run'), read: call('read'), wait: call('wait'), stop: call('stop'), list: call('list') } };
}
