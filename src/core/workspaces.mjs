// src/core/workspaces.mjs
// Workspace registry: a small persistent list of named project sets (2+ onboarded
// git repos sharing one editable interconnection description). Persisted in SQLite
// (db.mjs) across two tables: workspaces (id, name, description, created/updated)
// and workspace_projects (the ordered member set). The member's absolute PATH is
// stored in the workspace_projects.project_key column (ordinal-ordered) — NOT a
// projectKey: a projectKey is a one-way sha1 hash, so the path could not be
// reconstructed from it. The real projectKey is recomputed on read via
// store.projectKey(path) in annotate().
//
// A workspace is a thin record plus a derived store namespace at
// store/workspaces/<workspaceKey>/. The key is derived ONCE at creation from the
// name slug + a sorted-canonical-roots hash, then frozen: rename never recomputes it
// (D1). projectKeys / exists[] are derived at read time and never persisted.
//
// Reads never throw: a missing row yields []/null. Writes run inside one tx() and
// keep their validation throws (err(message, code), mirrors pipeline-delete.mjs) so
// the server can map codes -> HTTP (BAD_REQUEST->400, DUPLICATE_*->409,
// NOT_FOUND->404). workspacesFile() is retained (vestigial) for import-compat.

import { statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { worcaHome, normalizeProjectPath } from './projects.mjs';
import { canonicalProjectRoot, projectKey, workspaceStorePath } from './store.mjs';
import { slugify, retainedWorkFor } from './artifacts.mjs';
import { getDb, prepare, tx } from './db.mjs';

/** Object-shaped error carrying a machine code (mirrors pipeline-delete.mjs). */
function err(message, code) { return Object.assign(new Error(message), { code }); }

/**
 * Validate a metricsProject candidate against a workspace's member paths.
 * null/'' means "no home" and returns null. Anything else must resolve (by exact
 * match or by canonical git root) to one of `paths`; the member's OWN stored path
 * is returned (workspace_projects convention), not the normalized candidate.
 * @param {string[]} paths
 * @param {string|null|undefined} candidate
 * @returns {string|null}
 * @throws err(code: BAD_REQUEST)
 */
function memberPathFor(paths, candidate, field = 'metricsProject') {
  if (candidate == null || candidate === '') return null;
  if (typeof candidate !== 'string') throw err(`${field} must be a project path or null`, 'BAD_REQUEST');
  const want = normalizeProjectPath(candidate);
  // normalizeProjectPath('   ') -> null; canonicalProjectRoot(null) would throw ERR_INVALID_ARG_TYPE -> 500.
  if (!want) throw err(`${field} must be a project path or null`, 'BAD_REQUEST');
  const hit = paths.find((p) => p === want || canonicalProjectRoot(p) === canonicalProjectRoot(want));
  if (!hit) throw err(`${field} must be one of the workspace projects`, 'BAD_REQUEST');
  return hit;
}

/**
 * The workspace-key shape: "wks-<slug>-<sha1[:8]>". The server imports this as
 * its single source of truth (M2 route validation), so core + route agree on one
 * invariant. Validating an id against it also forecloses any path-traversal: a
 * key matching this regex can never contain "/" or "..", so workspaceStorePath(id)
 * cannot escape the store namespace even before a registry-membership check.
 */
export const WORKSPACE_KEY_RE = /^wks-[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$/;

/** Absolute path to the workspace registry file. Sibling of projects.json. */
export function workspacesFile() {
  return join(worcaHome(), 'workspaces.json');
}

/** True when the path exists and is a directory. */
function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/**
 * True when `p` is inside a git work tree (and a directory). Never throws.
 * Exported so the server's run-target loop can reject a member that exists but is
 * no longer a git repo (§2.6 step 3) using the SAME check createWorkspace applies.
 */
export function isGitRepo(p) {
  if (!isDir(p)) return false;
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'],
      { cwd: p, stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch { return false; }
}

/**
 * Roots-only dedupe hash (D1): sha1 of the sorted canonical roots, joined by "\n",
 * sliced to 8 hex. Name-independent and order-independent, so it identifies a
 * project SET regardless of the workspace's name or the input ordering.
 * @param {string[]} projectPaths
 * @returns {string} 8 hex chars
 */
export function rootsHash(projectPaths) {
  const roots = (Array.isArray(projectPaths) ? projectPaths : [])
    .map((p) => canonicalProjectRoot(p))
    .sort();
  return createHash('sha1').update(roots.join('\n')).digest('hex').slice(0, 8);
}

/**
 * Stable workspace key == id: "wks-" + slugify(name) + "-" + rootsHash(paths).
 * The wks- prefix guarantees no collision with any projectKey in the same store.
 * @param {{name:string, projectPaths:string[]}} ws
 * @returns {string}
 */
export function workspaceKey(ws) {
  const name = ws && typeof ws.name === 'string' ? ws.name : '';
  const paths = ws && Array.isArray(ws.projectPaths) ? ws.projectPaths : [];
  return `wks-${slugify(name)}-${rootsHash(paths)}`;
}

/**
 * Annotate a persisted entry with read-time derived fields:
 *   projectKeys (sorted ascending, index-aligned with the returned projectPaths)
 *   exists[]    (per-path on-disk presence)
 * Neither is ever persisted. projectPaths is re-ordered to align with the sorted
 * projectKeys so callers get the canonical member ordering used everywhere.
 */
function annotate(entry) {
  const pairs = entry.projectPaths.map((p) => ({ path: p, key: projectKey(p) }));
  pairs.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    projectPaths: pairs.map((x) => x.path),
    projectKeys: pairs.map((x) => x.key),
    exists: pairs.map((x) => isDir(x.path)),
    metricsProject: entry.metricsProject ?? null,
    policyProject: entry.policyProject ?? null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

/** Load the ordered member PATHS for a workspace (stored in the project_key column). */
function memberPaths(id) {
  return prepare(
    'SELECT project_key AS path FROM workspace_projects WHERE workspace_id = ? ORDER BY ordinal'
  ).all(id).map((r) => r.path);
}

/** Map a workspaces row (+ its member rows) to the persisted entry shape. */
function rowToEntry(r) {
  return {
    id: r.id,
    name: r.name,
    description: typeof r.description === 'string' ? r.description : '',
    projectPaths: memberPaths(r.id),
    metricsProject: r.metrics_project ?? null,
    policyProject: r.policy_project ?? null,
    createdAt: typeof r.created_at === 'string' ? r.created_at : '',
    updatedAt: typeof r.updated_at === 'string' ? r.updated_at : '',
  };
}

/** Read one workspace entry by id (persisted shape, pre-annotate). null when absent. */
function readEntry(id) {
  getDb();
  const r = prepare(
    'SELECT id, name, description, metrics_project, policy_project, created_at, updated_at FROM workspaces WHERE id = ?'
  ).get(id);
  return r ? rowToEntry(r) : null;
}

/**
 * List saved workspaces, each annotated with derived projectKeys/exists.
 * @returns {Promise<Array<{id,name,description,projectPaths,projectKeys,exists:boolean[],createdAt,updatedAt}>>}
 */
export async function listWorkspaces() {
  getDb();
  const rows = prepare(
    'SELECT id, name, description, metrics_project, policy_project, created_at, updated_at FROM workspaces ORDER BY created_at, name'
  ).all();
  return rows.map(rowToEntry).map(annotate);
}

/**
 * Number of saved workspaces (matches listWorkspaces().length). Cheap COUNT(*).
 * Uses the bare `prepare` already imported at workspaces.mjs:30.
 * @returns {number}
 */
export function countWorkspaces() {
  getDb();
  const row = prepare('SELECT COUNT(*) AS n FROM workspaces').get();
  return row ? Number(row.n) : 0;
}

/**
 * Read one workspace by id, annotated. Returns null when absent.
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function readWorkspace(id) {
  if (!id || typeof id !== 'string') return null;
  const entry = readEntry(id);
  return entry ? annotate(entry) : null;
}

/**
 * Normalize + de-dupe member paths by canonical root. Returns the normalized
 * absolute paths in input order, with later paths that resolve to an
 * already-seen canonical root dropped.
 */
function normalizeMembers(projectPaths) {
  const out = [];
  const seenRoots = new Set();
  for (const raw of Array.isArray(projectPaths) ? projectPaths : []) {
    const norm = normalizeProjectPath(raw);
    if (!norm) continue;
    const root = canonicalProjectRoot(norm);
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);
    out.push(norm);
  }
  return out;
}

/** Throw DUPLICATE_SET when a workspace other than `selfId` (null: any) already spans exactly `paths`. */
function assertUniqueSet(paths, selfId) {
  const hash = rootsHash(paths);
  for (const row of prepare('SELECT id FROM workspaces').all()) {
    if (row.id !== selfId && rootsHash(memberPaths(row.id)) === hash) {
      throw err('a workspace over this exact project set already exists', 'DUPLICATE_SET');
    }
  }
}

/** A trimmed, non-empty name no OTHER workspace holds (case-insensitive). */
function checkName(raw, selfId) {
  const name = (typeof raw === 'string' ? raw : '').trim();
  if (!name) throw err('workspace name is required', 'BAD_REQUEST');
  if (prepare('SELECT 1 FROM workspaces WHERE name = ? COLLATE NOCASE AND id <> ?').get(name, selfId ?? '')) {
    throw err(`a workspace named "${name}" already exists`, 'DUPLICATE_NAME');
  }
  return name;
}

/** Each NEW member must be an existing directory inside a git work tree. */
function checkNewMembers(paths) {
  for (const p of paths) {
    if (!isDir(p)) throw err(`member path does not exist or is not a directory: ${p}`, 'BAD_REQUEST');
    if (!isGitRepo(p)) throw err(`member path is not a git repository: ${p}`, 'BAD_REQUEST');
  }
}

/** The persisted entry, or NOT_FOUND. */
function entryOrThrow(id) {
  getDb();
  const entry = typeof id === 'string' && id ? readEntry(id) : null;
  if (!entry) throw err(`workspace not found: ${id}`, 'NOT_FOUND');
  return entry;
}

/**
 * Validate a new workspace without writing anything (createWorkspace runs it inside
 * its tx; Ask's workspace card runs it to propose). Name non-empty + unique
 * case-insensitive, a 2+ distinct-git-repo member set (de-duped by canonical root), a
 * unique project set (D1, by rootsHash), homes that are members, and a free key.
 * @returns {{id, name, description, members:string[], metricsProject, policyProject}}
 * @throws err(code: BAD_REQUEST | DUPLICATE_NAME | DUPLICATE_SET)
 */
export function planWorkspaceCreate(input = {}) {
  getDb();
  const inp = input && typeof input === 'object' ? input : {};
  const name = checkName(inp.name, null);
  const members = normalizeMembers(inp.projectPaths);
  if (members.length < 2) throw err('a workspace needs at least 2 distinct member projects', 'BAD_REQUEST');
  checkNewMembers(members);
  const metricsProject = memberPathFor(members, inp.metricsProject ?? null);
  const policyProject = memberPathFor(members, inp.policyProject ?? null, 'policyProject');
  assertUniqueSet(members, null);
  const id = workspaceKey({ name, projectPaths: members });
  // The key is frozen at create, so a workspace whose member set changed since still holds
  // the key of its ORIGINAL set: a same-slug name over that set would collide on the id.
  if (prepare('SELECT 1 FROM workspaces WHERE id = ?').get(id)) {
    throw err(`a workspace with a name like "${name}" once spanned this project set; choose another name`, 'DUPLICATE_NAME');
  }
  const description = typeof inp.description === 'string' ? inp.description : '';
  return { id, name, description, members, metricsProject, policyProject };
}

/**
 * Create a workspace (rules: planWorkspaceCreate). Persists the workspaces row +
 * ordered workspace_projects member rows (member PATH stored in the project_key
 * column) in ONE tx(). id is the frozen workspaceKey, computed once. Returns the
 * annotated entry.
 * @param {{name:string, projectPaths:string[], description?:string}} input
 * @throws err(code: BAD_REQUEST | DUPLICATE_NAME | DUPLICATE_SET)
 */
export async function createWorkspace(input = {}) {
  const now = new Date().toISOString();
  getDb();
  const plan = tx(() => {
    const p = planWorkspaceCreate(input);
    prepare(
      'INSERT INTO workspaces (id, name, description, metrics_project, policy_project, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(p.id, p.name, p.description, p.metricsProject, p.policyProject, now, now);
    const insMember = prepare(
      'INSERT INTO workspace_projects (workspace_id, project_key, ordinal) VALUES (?, ?, ?)'
    );
    // projectPaths persisted in input order (ordinal = index); annotate() re-sorts by key.
    p.members.forEach((m, i) => insMember.run(p.id, m, i));
    return p;
  });

  // Return the annotated entry (derived fields recomputed from the persisted paths).
  const { id, name, description, members, metricsProject, policyProject } = plan;
  return annotate({
    id, name, description, projectPaths: members, metricsProject, policyProject, createdAt: now, updatedAt: now,
  });
}

/**
 * Update a workspace's name and/or description. NEVER touches projectPaths (the
 * member set changes only through addWorkspaceMembers / removeWorkspaceMember) and
 * NEVER recomputes the id (D1). Re-validates a new name for case-insensitive
 * uniqueness. Stamps updatedAt.
 * @param {string} id
 * @param {{name?:string, description?:string}} patch
 * @throws err(code: NOT_FOUND | BAD_REQUEST | DUPLICATE_NAME)
 */
export async function updateWorkspace(id, patch = {}) {
  const entry = entryOrThrow(id);

  let { description } = entry;
  if (patch && typeof patch.description === 'string') {
    description = patch.description; // cap-on-freeze, not cap-on-store: persisted whole
  }
  const metricsProject = Object.prototype.hasOwnProperty.call(patch || {}, 'metricsProject')
    ? memberPathFor(entry.projectPaths, patch.metricsProject)
    : entry.metricsProject ?? null;
  const policyProject = Object.prototype.hasOwnProperty.call(patch || {}, 'policyProject')
    ? memberPathFor(entry.projectPaths, patch.policyProject, 'policyProject')
    : entry.policyProject ?? null;
  const now = new Date().toISOString();

  const name = tx(() => {
    // Re-check NOCASE name clash against OTHER rows (exclude self).
    const n = patch && typeof patch.name === 'string' ? checkName(patch.name, id) : entry.name;
    prepare(
      'UPDATE workspaces SET name = ?, description = ?, metrics_project = ?, policy_project = ?, updated_at = ? WHERE id = ?'
    ).run(n, description, metricsProject, policyProject, now, id);
    return n;
  });

  return annotate({ ...entry, name, description, metricsProject, policyProject, updatedAt: now });
}

/**
 * Validate a rename without writing (Ask's workspace card; updateWorkspace applies it).
 * @returns {{entry, name:string}}
 * @throws err(code: NOT_FOUND | BAD_REQUEST | DUPLICATE_NAME)
 */
export function planWorkspaceRename(id, name) {
  const entry = entryOrThrow(id);
  const next = checkName(name, id);
  if (next === entry.name) throw err(`the workspace is already named "${next}"`, 'BAD_REQUEST');
  return { entry, name: next };
}

/**
 * Validate adding member projects without writing. Same rules as create: each new
 * path must be an existing git repo (de-duped by canonical root, and not already a
 * member), and the resulting set must be unique among the OTHER workspaces.
 * @returns {{entry, added:string[], next:string[]}}
 * @throws err(code: NOT_FOUND | BAD_REQUEST | DUPLICATE_SET)
 */
export function planMembersAdd(id, projectPaths) {
  const entry = entryOrThrow(id);
  const current = new Set(entry.projectPaths.map((p) => canonicalProjectRoot(p)));
  const added = normalizeMembers(projectPaths);
  if (!added.length) throw err('name at least one project to add', 'BAD_REQUEST');
  for (const p of added) {
    if (current.has(canonicalProjectRoot(p))) throw err(`already a member of this workspace: ${p}`, 'BAD_REQUEST');
  }
  checkNewMembers(added);
  const next = [...entry.projectPaths, ...added];
  assertUniqueSet(next, id);
  return { entry, added, next };
}

/**
 * Validate removing one member without writing. The path must be a member (exact or
 * same canonical root; a member that vanished from disk can still be removed), at
 * least 2 members must remain, and the remaining set must be unique among the OTHER
 * workspaces. A removed metricsProject / policyProject home comes back null: the home
 * is CLEARED, never silently moved to another member (the user picks a new one).
 * @returns {{entry, removed:string, next:string[], metricsProject, policyProject}}
 * @throws err(code: NOT_FOUND | BAD_REQUEST | DUPLICATE_SET)
 */
export function planMemberRemove(id, projectPath) {
  const entry = entryOrThrow(id);
  const want = typeof projectPath === 'string' ? normalizeProjectPath(projectPath) : null;
  if (!want) throw err('name the member project to remove', 'BAD_REQUEST');
  const removed = entry.projectPaths.find((p) => p === want || canonicalProjectRoot(p) === canonicalProjectRoot(want));
  if (!removed) throw err(`not a member of this workspace: ${want}`, 'BAD_REQUEST');
  const next = entry.projectPaths.filter((p) => p !== removed);
  if (next.length < 2) throw err('a workspace needs at least 2 distinct member projects', 'BAD_REQUEST');
  assertUniqueSet(next, id);
  return {
    entry, removed, next,
    metricsProject: entry.metricsProject === removed ? null : entry.metricsProject ?? null,
    policyProject: entry.policyProject === removed ? null : entry.policyProject ?? null,
  };
}

/**
 * Add member projects to an existing workspace (rules: planMembersAdd). New rows are
 * appended after the current ordinals in ONE tx(); the id is NOT recomputed (D1: the
 * store dir, runs, schedules, metrics and policy all hang off it). Runs already started
 * keep the member set frozen in their own pipeline row (workspace_meta). The live-run
 * 409 guard lives in the server route.
 * @throws err(code: NOT_FOUND | BAD_REQUEST | DUPLICATE_SET)
 */
export async function addWorkspaceMembers(id, projectPaths) {
  const now = new Date().toISOString();
  const { entry, next } = tx(() => {
    const plan = planMembersAdd(id, projectPaths);
    const base = prepare('SELECT COALESCE(MAX(ordinal), -1) AS m FROM workspace_projects WHERE workspace_id = ?').get(id).m;
    const ins = prepare('INSERT INTO workspace_projects (workspace_id, project_key, ordinal) VALUES (?, ?, ?)');
    plan.added.forEach((p, i) => ins.run(id, p, base + 1 + i));
    prepare('UPDATE workspaces SET updated_at = ? WHERE id = ?').run(now, id);
    return plan;
  });
  return annotate({ ...entry, projectPaths: next, updatedAt: now });
}

/**
 * Remove one member project from an existing workspace (rules: planMemberRemove —
 * a removed metrics / policy home is cleared). One tx(); the id is NOT recomputed.
 * @throws err(code: NOT_FOUND | BAD_REQUEST | DUPLICATE_SET)
 */
export async function removeWorkspaceMember(id, projectPath) {
  const now = new Date().toISOString();
  const plan = tx(() => {
    const p = planMemberRemove(id, projectPath);
    prepare('DELETE FROM workspace_projects WHERE workspace_id = ? AND project_key = ?').run(id, p.removed);
    prepare('UPDATE workspaces SET metrics_project = ?, policy_project = ?, updated_at = ? WHERE id = ?')
      .run(p.metricsProject, p.policyProject, now, id);
    return p;
  });
  const { entry, next, metricsProject, policyProject } = plan;
  return annotate({ ...entry, projectPaths: next, metricsProject, policyProject, updatedAt: now });
}

/** Thin setter: edit only the description. */
export async function updateWorkspaceDescription(id, text) {
  return updateWorkspace(id, { description: typeof text === 'string' ? text : '' });
}

/** Thin setter: rename only. Never recomputes the id (D1). */
export async function renameWorkspace(id, name) {
  return updateWorkspace(id, { name: typeof name === 'string' ? name : '' });
}

/**
 * Delete a workspace: remove the store/workspaces/<id>/ directory (best-effort) and
 * the registry row. The workspace_projects children are removed by the FK
 * ON DELETE CASCADE (foreign_keys=ON, set on open). The module has no runs map —
 * the live-run 409 guard lives in the server route.
 *
 * Self-guarded: id MUST match the workspace-key shape AND the row MUST exist before
 * anything is removed; a crafted id (e.g. "../..") never reaches the rm — it throws
 * NOT_FOUND. (store_meta cleanup is owned by Phase 3 — see the cross-phase note.)
 * @param {string} id
 * @returns {Promise<{ok:true, warnings:string[]}>}
 * @throws err(code: NOT_FOUND) for a malformed or unknown id
 */
export async function deleteWorkspace(id) {
  if (!id || typeof id !== 'string' || !WORKSPACE_KEY_RE.test(id)) {
    throw err(`workspace not found: ${id}`, 'NOT_FOUND');
  }
  getDb();
  // Membership-first: only act on an id actually present.
  if (!prepare('SELECT 1 FROM workspaces WHERE id = ?').get(id)) {
    throw err(`workspace not found: ${id}`, 'NOT_FOUND');
  }

  // Never orphan retained uncommitted work: deleting the store removes the
  // pipeline dir the discard flow needs for its recovery patch, wedging the run.
  const memberRows = prepare(
    'SELECT * FROM pipelines WHERE workspace_key = ? AND archived_at IS NULL',
  ).all(id);
  for (const memberRow of memberRows) {
    if (retainedWorkFor(memberRow)) {
      throw err(
        `workspace has retained uncommitted work (pipeline ${memberRow.id}); recover or discard it first — ` +
        'and copy any retained-work*.patch out of the workspace store before deleting, deletion removes it',
        'RETAINED_WORKTREE',
      );
    }
  }

  const warnings = [];
  try {
    await rm(workspaceStorePath(id), { recursive: true, force: true });
  } catch (e) {
    warnings.push(`store cleanup failed: ${e && e.message ? e.message : 'error'}`);
  }
  try {
    tx(() => {
      // Children cascade via the workspace_projects FK (ON DELETE CASCADE).
      prepare('DELETE FROM workspaces WHERE id = ?').run(id);
    });
  } catch (e) {
    warnings.push(`registry write failed: ${e && e.message ? e.message : 'error'}`);
  }

  return { ok: true, warnings };
}
