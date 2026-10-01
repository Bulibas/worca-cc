// src/core/mcp/deny.mjs
// Guardrail deny rules and registry copies (MCP registry design §6.4). A registry server runs
// under per-set copy names (`linear_billing`, `jira_w`), so a rule written against the server
// (`mcp__linear__delete_issue`) would miss every copy. Each `mcp__<s>` / `mcp__<s>__<tool>` rule
// whose segment is a catalog server's base or declared name gains one rule per copy of that
// server in the run; a rule naming a copy follows its `_w` rename. The original rule stays (it
// still matches a project or user server of that name). Pure.

const MCP_RULE_RE = /^mcp__(.+?)(__.+)?$/;   // server names never contain `__` (§4.4)

/**
 * @param {string[]} rules  the run's deny rules
 * @param {{catalog: Array<{id:string, name:string, base:string}>, copies: Array<{name:string, copy:string, serverId:string}>}} layer
 * @returns {string[]} `rules` followed by the added rules, de-duplicated
 */
export function expandMcpDenyRules(rules, { catalog = [], copies = [] } = {}) {
  const out = [...rules];
  const seen = new Set(out);
  for (const rule of rules) {
    const m = MCP_RULE_RE.exec(rule);
    if (!m) continue;
    const [, seg, tail = ''] = m;
    const ids = new Set(catalog.filter((e) => e.base === seg || e.name === seg).map((e) => e.id));
    for (const c of copies) {
      if (!ids.has(c.serverId) && c.copy !== seg) continue;
      const r = `mcp__${c.name}${tail}`;
      if (!seen.has(r)) { seen.add(r); out.push(r); }
    }
  }
  return out;
}
