// ui/public/mcp-run-picker.mjs
// New Pipeline › Advanced › MCP servers (MCP registry design §6.2, D16): the registry copies a run
// on the selected target starts, from POST /api/mcp/preview, grouped by set and opted out per
// membership ('<setId>|<serverId>'). A skipped membership is a disabled row with its reason, never
// a checkbox, and never counted. Pure DOM; app.js owns the fetch and the opt-out state.

const keyOf = (m) => `${m.setId}|${m.serverId}`;
const CHOICES = new Set(['off', 'needs-consent', 'opted-out', 'chat-off']);   // §5.7: the other skips read as problems

/** How a skipped membership reads in every MCP preview (this picker and Ask's, §5.7): its name — a
 *  `missing-server` skip has no copy name (its server left the catalog), so its id stands in — its reason,
 *  and whether it is a problem rather than a choice. A never-consented Team server reads "off — turn it
 *  on in the team checklist" (Appendix B 4). */
export function mcpSkipView(s) {
  return {
    name: s.copy ?? s.serverId,
    why: s.reason === 'needs-consent' && s.why ? `off — ${s.why}` : (s.why || s.reason),
    problem: !CHOICES.has(s.reason),
  };
}

/** A startable copy's note — §4.4 provisional name, §5.6 withheld tools (it starts either way); '' when none. */
export function mcpCopyNote(preview, c) {
  const tools = (preview.skippedTools || []).filter((t) => t.name === c.name).map((t) => t.reason);
  return [c.provisional && 'name provisional', ...tools].filter(Boolean).join(' · ');
}

/** "N of M MCP servers": M = memberships that would start, N = those not opted out. */
export function mcpRunsLabel(preview, optOut) {
  const off = new Set(optOut);
  const m = preview.copies.length;
  const n = preview.copies.filter((c) => !off.has(keyOf(c))).length;
  return `${n} of ${m} MCP server${m === 1 ? '' : 's'}`;
}

/**
 * The popover body. `onToggle(keys, on)` gets the membership keys a click switched on or off.
 * `projectName(key)` (workspace targets) names the member projects that bring each set.
 */
export function renderMcpRunsPop(preview, optOut, { doc = globalThis.document, projectName = null, onToggle }) {
  const off = new Set(optOut);
  const root = doc.createElement('div');
  root.className = 'mcp-runs-pop';
  const box = (checked, keys, kind) => {
    const input = doc.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    // app.js puts the focus back on this box after a re-render, found by keys and kind: a set with
    // one startable membership has a set box and a row box with the same keys.
    input.dataset.keys = keys.join(' ');
    input.dataset.kind = kind;
    input.addEventListener('change', () => onToggle(keys, input.checked));
    return input;
  };
  const row = (name, lead, why, cls = '') => {
    const r = doc.createElement('label');
    r.className = `mcp-runs-row${cls}`;
    const n = doc.createElement('span');
    n.className = 'mono';
    n.textContent = name;
    r.append(...(lead ? [lead, n] : [n]));
    if (why) {
      const h = doc.createElement('span');
      h.className = 'hint';
      h.textContent = why;
      r.append(h);
    }
    root.append(r);
  };
  for (const set of preview.sets) {
    const startable = preview.copies.filter((c) => c.setId === set.id);
    const skipped = preview.skipped.filter((s) => s.setId === set.id && s.reason !== 'opted-out');
    if (!startable.length && !skipped.length) continue;
    const on = startable.filter((c) => !off.has(keyOf(c))).length;
    const head = doc.createElement('label');
    head.className = 'mcp-runs-set';
    const setBox = box(startable.length > 0 && on === startable.length, startable.map(keyOf), 'set');
    setBox.indeterminate = on > 0 && on < startable.length;
    setBox.disabled = !startable.length;
    const projects = projectName ? set.routes.map((r) => projectName(r.project)) : [];
    head.append(setBox, doc.createTextNode(projects.length ? `${set.name} · ${projects.join(', ')}` : set.name));
    root.append(head);
    for (const c of startable) row(c.copy, box(!off.has(keyOf(c)), [keyOf(c)], 'row'), mcpCopyNote(preview, c));
    for (const s of skipped) {
      const v = mcpSkipView(s);
      row(v.name, null, v.why, ` is-skipped${v.problem ? ' is-problem' : ''}`);
    }
  }
  return root;
}
