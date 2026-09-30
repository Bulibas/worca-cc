// src/core/ask/mcp.mjs
// Ask Worca's side of the MCP registry (docs/superpowers/specs/2026-09-29-mcp-registry-design-v2.md §9):
// the per-chat picker's choices (`mcpOff`), the targets in play, one resolve per turn or preview, the
// prompt section's input and the turn-end worktree notice. The resolver itself is src/core/mcp/registry.mjs.
import { SET_ID_RE, MEMBERSHIP_KEY_RE } from '../mcp/definitions.mjs';
import { listProjects } from '../projects.mjs';
import { readWorkspace } from '../workspaces.mjs';
import { listAskWorktrees } from './worktrees.mjs';
import { resolveRegistry, cachedTeamFor, toolNameLimitFor, skipReasonText } from '../mcp/registry.mjs';
import { readMcpStore } from '../mcp/store.mjs';
import { loadCatalog } from '../mcp/catalog.mjs';

export const ASK_MCP_COPY_CAP = 12;
const ASK_MCP_TIMEOUT_MS = 15000;   // §5.6; the resolver lets worca's own MCP_TIMEOUT win
const DEFAULT_DEPS = { listProjects, readWorkspace, listWorktrees: listAskWorktrees, resolveRegistry, cachedTeamFor, readMcpStore, loadCatalog };
const EMPTY_RESULT = () => ({ servers: {}, env: {}, secretValues: [], grants: [], disallowedTools: [], copies: [], skipped: [], skippedTools: [], sets: [] });

export const MCP_OFF_MAX = 100;

/** The `mcpOff` body field (§9.4, §12): null clears; else `{ sets: [setId], members: ['<setId>|<serverId>'] }`,
 *  ≤100 each, duplicates dropped. Unknown entries are kept: the resolver ignores them (§5.2). */
export function validateMcpOff(raw) {
  if (raw === null) return { ok: true, value: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'mcpOff must be an object or null' };
  const sets = raw.sets ?? [];
  const members = raw.members ?? [];
  if (!Array.isArray(sets) || sets.length > MCP_OFF_MAX || !sets.every((s) => typeof s === 'string' && SET_ID_RE.test(s))) {
    return { ok: false, error: `mcpOff.sets must be an array of at most ${MCP_OFF_MAX} set ids` };
  }
  if (!Array.isArray(members) || members.length > MCP_OFF_MAX || !members.every((m) => typeof m === 'string' && MEMBERSHIP_KEY_RE.test(m))) {
    return { ok: false, error: `mcpOff.members must be an array of at most ${MCP_OFF_MAX} "<setId>|<serverId>" entries` };
  }
  return { ok: true, value: { sets: [...new Set(sets)], members: [...new Set(members)] } };
}

/**
 * §9.1 — the targets in play for one turn or preview: the pin, else the page (never the fallback-tagged dropdown
 * projectDir), then every open worktree of the thread (rank 1 + creation index). A project already in play keeps its
 * first route and rank — and every member of a workspace in play is in play (D13 "a workspace ⇒ all members"), so a
 * worktree on a member adds no target and never brings that member's own Team set (§5.1). An unregistered project or
 * a missing workspace is no target.
 * @returns {Promise<Array<{kind:'project', key, name, route, rank}|{kind:'workspace', id, name, members:{key,name}[], route, rank}>>}
 */
export async function askTargetsInPlay({ ctx = {}, threadId = null } = {}, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const projects = await d.listProjects();
  const byKey = new Map(projects.map((p) => [p.key, p]));
  const targets = [];
  const inPlay = new Set();   // project keys already in play: project targets and the members of a workspace target
  const project = (p, route, rank) => {
    if (!p || inPlay.has(p.key)) return;
    inPlay.add(p.key);
    targets.push({ kind: 'project', key: p.key, name: p.name, route, rank });
  };
  const workspace = async (id, route) => {
    const ws = await d.readWorkspace(id);
    if (!ws) return;
    const keys = ws.projectKeys || [];
    for (const key of keys) inPlay.add(key);
    targets.push({ kind: 'workspace', id: ws.id, name: ws.name, route, rank: 0,
      members: keys.map((key) => ({ key, name: byKey.get(key)?.name ?? key })) });
  };
  if (ctx.pinned === true) {
    if (ctx.projectKey) project(byKey.get(ctx.projectKey), 'pinned', 0);
    else if (ctx.workspaceId) await workspace(ctx.workspaceId, 'pinned');
  } else {
    // The fallback tag names only the dropdown's projectDir (§9.1) — like resolveAskContext and contextProjectKey.
    const byDir = ctx.projectSource === 'fallback' ? null : projects.find((p) => ctx.projectDir && p.path === ctx.projectDir);
    project(ctx.projectKey ? byKey.get(ctx.projectKey) : byDir, 'page', 0);
    if (ctx.workspaceId) await workspace(ctx.workspaceId, 'page');
  }
  if (threadId) (await d.listWorktrees(threadId)).forEach((w, i) => project(byKey.get(w.projectKey), 'worktree', 1 + i));
  return targets;
}

/** §9.2 — one resolve for an Ask turn or preview: General ∪ the targets' sets, minus the chat's choices. Teams come
 *  from the policy cache only (no git, no network). Never throws: a failure reads as no MCP servers. */
export async function resolveAskMcp({ ctx = {}, threadId = null, off = null, model = null } = {}, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  try {
    const targets = await askTargetsInPlay({ ctx, threadId }, d);
    const teams = Object.create(null);
    for (const t of targets) {
      if (t.kind === 'project') teams[t.key] = await d.cachedTeamFor({ projectKey: t.key });
      else teams[`ws:${t.id}`] = await d.cachedTeamFor({ workspaceId: t.id });
    }
    const result = await d.resolveRegistry({
      surface: 'ask', targets, teams, off: off || { sets: [], members: [] },
      toolNameLimit: toolNameLimitFor(model ? [model] : []), copyCap: ASK_MCP_COPY_CAP, taken: [], mcpTimeoutMs: ASK_MCP_TIMEOUT_MS,
    });
    return { targets, result };
  } catch (err) {
    console.warn(`[worca-ask] MCP registry resolve failed (${err?.message || err}) — no MCP servers this turn`);
    return { targets: [], result: EMPTY_RESULT() };
  }
}

/** The snapshot + catalog the texts need; empty when unreadable (a missing text never fails a turn). */
async function storeAndCatalog(d) {
  try {
    const snapshot = await d.readMcpStore();
    return { projects: snapshot.projects, catalog: await d.loadCatalog(snapshot) };
  } catch { return { projects: Object.create(null), catalog: [] }; }
}

/** §9.3 — renderMcpSection's input (prompt.mjs), or null without copies. */
export async function askMcpPromptInput({ targets, result }, deps = {}) {
  if (!result.copies.length) return null;
  const { projects, catalog } = await storeAndCatalog({ ...DEFAULT_DEPS, ...deps });
  const names = new Map();
  for (const t of targets) for (const p of t.kind === 'project' ? [t] : t.members) if (!names.has(p.key)) names.set(p.key, p.name);
  const noGeneral = (key) => Object.hasOwn(projects, key) && projects[key].includeGeneral === false;
  const general = result.copies.filter((c) => c.setId === 'general').map((c) => c.name);
  return {
    targets: targets.map((t) => ({ name: t.name, route: t.route })),
    copies: result.copies.map((c) => ({ name: c.name, description: c.description, setName: c.setName, projects: c.projects.map((k) => names.get(k) ?? k) })),
    skipped: result.skipped.map((x) => ({ copy: x.copy ?? x.serverId, setName: x.setName, reason: skipReasonText(x, catalog) })),   // missing-server has no copy
    // A workspace run includes General when any member does (§5.1), so a workspace excludes it only when all do.
    noGeneral: general.length ? targets.filter((t) => (t.kind === 'project' ? noGeneral(t.key) : t.members.length > 0 && t.members.every((m) => noGeneral(m.key)))).map((t) => t.name) : [],
    generalCopies: general,
  };
}

/** §9.4 — POST /api/ask/mcp-preview's body: the same resolve as the turn, reduced to what the picker shows.
 *  Never the servers, the env or a secret value. */
export async function askMcpPreview({ ctx, threadId = null, off = null, model = null }, deps = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const { result } = await resolveAskMcp({ ctx, threadId, off, model }, d);
  const { catalog } = result.skipped.length ? await storeAndCatalog(d) : { catalog: [] };
  return {
    sets: result.sets, copies: result.copies, started: result.copies.length,
    skipped: result.skipped.map((x) => ({ ...x, copy: x.copy ?? x.serverId, why: skipReasonText(x, catalog) })),
    // §5.6: tools withheld from a copy that still starts; §4.5: registry files from a newer worca (nothing resolves).
    skippedTools: result.skippedTools, newer: result.newer === true,
  };
}

/** §9.1 (D17) — at turn end: re-run the targets in play and name, per project a new worktree brought in, the copies
 *  that join from the next message. null when no worktree target joined or it brings no copy. */
export async function askMcpJoinNotice({ before, ctx, threadId, off = null, model = null }, deps = {}) {
  const next = await resolveAskMcp({ ctx, threadId, off, model }, deps);
  const had = new Set(before.targets.filter((t) => t.kind === 'project').map((t) => t.key));
  const old = new Set(before.result.copies.map((c) => c.name));
  const parts = [];
  for (const t of next.targets) {
    if (t.kind !== 'project' || t.route !== 'worktree' || had.has(t.key)) continue;   // §9.1: only an open worktree joins mid-turn
    const joined = next.result.copies.filter((c) => !old.has(c.name) && c.projects.includes(t.key)).map((c) => c.name);
    if (joined.length) parts.push(`${t.name}'s MCP servers (${joined.join(', ')}) join from the next message`);
  }
  return parts.length ? parts.join('; ') : null;
}
