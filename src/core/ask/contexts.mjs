// src/core/ask/contexts.mjs — the Ask chat's context chips: which project / run / workspace /
// named page a chat was asked in, accumulated across turns (origin first, deduplicated).
// Pure: the route resolves names (resolveAskContext) and the store persists (addThreadContexts).

export const MAX_CONTEXTS = 20;
const LABEL_MAX = 80;

/** Named pages that earn a chip; every other view (lists, `new`, detail kinds) produces none. */
export const PAGE_LABELS = Object.freeze({
  settings: 'Settings',
  'team-metrics': 'Team metrics',
  'team-policy': 'Team policy',
});

const KINDS = new Set(['project', 'run', 'workspace', 'page']);
const clip = (s) => String(s ?? '').slice(0, LABEL_MAX);
const nonEmpty = (s) => typeof s === 'string' && s.length > 0;

/** Chip entries for one turn, from the validated client context (`ctx`, for the pin verdict)
 *  and the SERVER-RESOLVED header context (`header`: names only for rows that exist). */
export function contextEntries(ctx, header) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const h = header && typeof header === 'object' ? header : {};
  const out = [];
  const pinned = c.pinned === true;
  if (h.project && nonEmpty(h.project.key)) {
    const e = { kind: 'project', id: h.project.key, label: clip(h.project.name || h.project.key) };
    if (pinned && c.projectKey === h.project.key) e.pinned = true;
    out.push(e);
  }
  if (h.workspace && nonEmpty(h.workspace.id)) {
    const e = { kind: 'workspace', id: h.workspace.id, label: clip(h.workspace.name || h.workspace.id) };
    if (pinned && c.workspaceId === h.workspace.id) e.pinned = true;
    out.push(e);
  }
  // A run without a home is a live run before its pipeline id: its header id is a run-id prefix,
  // not the id a later turn resolves, so a chip for it would duplicate. The home also makes it a link.
  if (h.run && nonEmpty(h.run.id) && nonEmpty(h.run.home)) {
    out.push({ kind: 'run', id: h.run.id, label: clip(h.run.title || h.run.id), home: h.run.home });
  }
  if (nonEmpty(h.view) && Object.hasOwn(PAGE_LABELS, h.view)) {
    out.push({ kind: 'page', id: h.view, label: PAGE_LABELS[h.view] });
  }
  return out;
}

const valid = (e) => e && typeof e === 'object' && KINDS.has(e.kind) && nonEmpty(e.id) && typeof e.label === 'string';

/** Accumulate: existing order kept (origin first), new kind:id appended, label refreshed
 *  (an id-only fallback label never replaces a real one), pinned sticky (OR). A corrupt stored value degrades to []. Over the cap: origin + newest. */
export function mergeContexts(existing, incoming) {
  const list = (Array.isArray(existing) ? existing : []).filter(valid).map((e) => ({ ...e }));
  const at = new Map(list.map((e, i) => [`${e.kind}:${e.id}`, i]));
  for (const e of Array.isArray(incoming) ? incoming : []) {
    if (!valid(e)) continue;
    const k = `${e.kind}:${e.id}`;
    if (at.has(k)) {
      const cur = list[at.get(k)];
      if (e.label !== e.id || !cur.label) cur.label = e.label;
      if (e.kind === 'run' && nonEmpty(e.home)) cur.home = e.home;
      if (e.pinned === true) cur.pinned = true;
    } else {
      at.set(k, list.length);
      list.push({ ...e });
    }
  }
  return list.length > MAX_CONTEXTS ? [list[0], ...list.slice(-(MAX_CONTEXTS - 1))] : list;
}
