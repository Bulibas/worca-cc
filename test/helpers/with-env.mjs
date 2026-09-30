// test/helpers/with-env.mjs — env-var sandboxes for the MCP registry tests.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addGlobalModel } from '../../src/core/settings.mjs';
import { bridgedModelInfo } from '../../src/core/config.mjs';

/** Run `fn` with the given env vars set (undefined deletes), restoring them after. */
export async function withEnv(vars, fn) {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

let gwHome = null;
/** Run `fn` with HOME sandboxed to a global model catalog holding `gw-gpt`: a bridge-translated
 *  model (§5.6: tool-name limit 64) on a loopback endpoint, so it needs no provider key. */
export function withGw(fn) {
  gwHome ||= mkdtempSync(join(tmpdir(), 'worca-cc-mcp-gw-'));
  return withEnv({ HOME: gwHome, USERPROFILE: gwHome, WORCA_TEST_ALLOW_HOME_FALLBACK: '1' }, async () => {
    if (!bridgedModelInfo('gw-gpt')) await addGlobalModel({ id: 'gw-gpt', upstream: { provider: 'openai', api: 'openai-chat', model: 'gpt-x', baseUrl: 'http://127.0.0.1:9/v1' } });
    return fn();
  });
}
