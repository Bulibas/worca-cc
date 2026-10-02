// src/shared/mcp-tool-name.mjs
// The one parser for Claude Code's MCP tool names (`mcp__<server>__<tool>`), shared by the Ask
// event reducer (src/core/ask/events.mjs) and the Ask panel (ui/public/ask-panel.mjs). Browser-safe:
// no imports. Server names never contain `__` (MCP registry §4.4: copies are `<base>`, `<base>_<slug>`
// or `<copy>_w`), so the first `__` after the server name ends it.
const MCP_TOOL_RE = /^mcp__(.+?)__(.+)$/;

/** `{ server, tool }` for an MCP tool name, else null. */
export function parseMcpToolName(name) {
  const m = MCP_TOOL_RE.exec(String(name ?? ''));
  return m ? { server: m[1], tool: m[2] } : null;
}

// MCP registry §10: the first-party API's 400 on a tool name over the model's limit (§5.6, §16.1 #5), and the
// warning (pipelines) / muted line (Ask) it maps to. Bounded quantifiers: it runs in the server process on every
// failed turn's error text, which the caller clips.
export const MCP_TOOL_NAME_400_RE = /tools\.\d{1,6}\.(?:[A-Za-z_]{1,40}\.)?name\b.{0,120}?at most (64|128)/;
export const MCP_TOOL_NAME_TOO_LONG = 'an MCP tool name is too long for this model';
