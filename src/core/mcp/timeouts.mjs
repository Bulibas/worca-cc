// src/core/mcp/timeouts.mjs
// How long a registry server may take to start (docs/mcp-servers.md "Limits and costs"), per surface.
// A first `npx -y` download of a large package must fit — firebase-tools took 33.5 s (287 MB) on an
// empty npm cache (measured 2026-09-30). Test is as generous as a pipeline, so "Save and test" is also
// the download that warms the npx cache for later spawns. Ask is shorter: a user is waiting.
export const MCP_STARTUP_MS = Object.freeze({ ask: 60_000, pipeline: 120_000, test: 120_000 });

const MAX_TIMER_MS = 2_147_483_647;   // Node's largest setTimeout delay; a larger one fires at once

/** A surface's startup limit; worca's own MCP_TIMEOUT wins when it is an integer ≥ 1000 ms (the rule the
 *  resolver applies to the MCP_TIMEOUT it hands a spawn), capped at MAX_TIMER_MS. */
export function mcpStartupMs(surface, env = process.env) {
  const mine = env.MCP_TIMEOUT;
  return /^\d+$/.test(mine ?? '') && Number(mine) >= 1000 ? Math.min(Number(mine), MAX_TIMER_MS) : MCP_STARTUP_MS[surface];
}
