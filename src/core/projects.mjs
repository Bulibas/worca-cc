// src/core/projects.mjs
// Named project registry: a small persistent list of { name, path } entries the
// web UI uses to populate its project dropdown.
//
// node:sqlite migration: now persisted in the `projects` table; path helpers vestigial.
//
// Reads never throw: a fresh/empty DB yields an empty list. Writes validate then
// persist inside a single db.mjs tx(). Each row is keyed by projectKey(path)
// (store.mjs), so every worktree of a repo maps to one row.

import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getWorcaRoot, defaultRoot } from './settings.mjs';
import { getDb, prepare, tx } from './db.mjs';
import { projectKey } from './store.mjs';

/**
 * Absolute path to the .worca-cc data directory. Base resolution precedence:
 *   1. WORCA_HOME env (non-empty)  — tests/smoke isolation + CLI override
 *   2. persisted Settings root        — the user-chosen "Worca CC root folder"
 *   3. defaultRoot()                  — the OS home
 * Read fresh every call, so a saved root applies to new operations w/o restart.
 */
export function worcaHome() {
  const env = process.env.WORCA_HOME;
  if (!(env && env.trim()) && process.env.NODE_TEST_CONTEXT &&
      !process.env.WORCA_TEST_ALLOW_HOME_FALLBACK) {
    // Under the node:test runner the real ~/.worca-cc must be unreachable: a test
    // (or a fire-and-forget write outliving its teardown) that resolves the home
    // with no WORCA_HOME set would silently pollute the user's real store.
    // WORCA_TEST_ALLOW_HOME_FALLBACK opts out for tests that exercise the
    // settings/home fallback tiers and sandbox HOME/USERPROFILE themselves.
    throw new Error(
      'worcaHome(): WORCA_HOME is unset under the node:test runner — ' +
      'tests must never touch the real ~/.worca-cc (use test/helpers/temp-home.mjs#useTempHome)'
    );
  }
  const base = env && env.trim() ? env : (getWorcaRoot() || defaultRoot());
  return join(resolve(base), '.worca-cc');
}

/**
 * Absolute path to the (legacy) registry file.
 *
 * VESTIGIAL (node:sqlite migration §0.6): the registry now lives in the `projects`
 * table, not this JSON file. This export is retained only for backward
 * import-compatibility (test imports); it no longer describes where data lives.
 */
export function projectsFile() {
  return join(worcaHome(), 'projects.json');
}

/**
 * Expand a leading ~ and resolve to an absolute path. Mirrors the web server's
 * historical resolveProjectDir so the registry and runs agree on a path.
 * @param {string} input
 * @returns {string|null} absolute path, or null for empty/non-string input
 */
export function normalizeProjectPath(input) {
  if (!input || typeof input !== 'string' || !input.trim()) return null;
  let p = input.trim();
  if (p.startsWith('~')) p = join(process.env.HOME || process.env.USERPROFILE || '', p.slice(1));
  return resolve(p);
}

/** True when the path exists and is a directory. */
function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read the raw registry rows from the DB, ordered by creation then name for a
 * stable list. Never throws (a fresh DB simply has no rows). The DB call is
 * synchronous (node:sqlite); we return the plain array.
 * @returns {Array<{key:string, name:string, path:string}>}
 */
function readRows() {
  getDb(); // ensure the singleton is open + migrated before preparing
  return prepare(
    'SELECT key, name, path FROM projects ORDER BY created_at, name'
  ).all();
}

/**
 * List saved projects, each annotated with a runtime `exists` flag (true when the
 * path is an existing directory). The flag is computed, never persisted. `key` is
 * the registry key (store.mjs#projectKey at registration) — the id the Ask Worca
 * catalog and propose_run use, so callers never re-derive it from the path.
 * Reads from the projects table; never throws.
 * @returns {Promise<Array<{key:string, name:string, path:string, exists:boolean}>>}
 */
export async function listProjects() {
  return readRows().map((e) => ({ key: e.key, name: e.name, path: e.path, exists: isDir(e.path) }));
}

/**
 * Number of registered projects (missing-on-disk rows included, matching the
 * Projects list + its sidebar count). Cheap COUNT(*); never throws.
 * Uses the bare `prepare` already imported at projects.mjs:14.
 * @returns {number}
 */
export function countProjects() {
  getDb(); // ensure the singleton is open + migrated before preparing
  const row = prepare('SELECT COUNT(*) AS n FROM projects').get();
  return row ? Number(row.n) : 0;
}

/**
 * Validate one {name, path} and insert it in its own tx(). Synchronous (node:sqlite).
 * @returns {{key:string, name:string, path:string}} the stored row
 * @throws {Error} on empty name/path, a path that exists but is not a directory,
 *   a duplicate name (case-insensitive), or a duplicate path/key.
 */
function insertProject(input) {
  const name = (input && typeof input.name === 'string' ? input.name : '').trim();
  if (!name) throw new Error('project name is required');
  const path = normalizeProjectPath(input && input.path);
  if (!path) throw new Error('project path is required');
  // A path that exists must be a directory; a non-existent path is allowed (the run
  // creates it), matching the orchestrator's mkdir-on-run behavior.
  if (existsSync(path) && !isDir(path)) throw new Error('path is not a directory');

  const key = projectKey(path);
  const createdAt = new Date().toISOString();
  tx(() => {
    // Case-insensitive duplicate-name guard (matches the legacy check + the index).
    const clash = prepare('SELECT 1 FROM projects WHERE name = ? COLLATE NOCASE').get(name);
    if (clash) throw new Error(`a project named "${name}" already exists`);
    // Same path -> same key -> PK collision; report it cleanly rather than crashing.
    const samePath = prepare('SELECT 1 FROM projects WHERE key = ?').get(key);
    if (samePath) throw new Error('this project path is already registered');
    prepare(
      'INSERT INTO projects (key, name, path, created_at) VALUES (?, ?, ?, ?)'
    ).run(key, name, path, createdAt);
  });
  return { key, name, path };
}

/**
 * Add a project. Validates and persists to the projects table. Returns the
 * updated annotated list. Keyed by projectKey(path) (store.mjs), so every worktree
 * of a repo maps to one row. Name uniqueness is case-insensitive (checked here AND
 * backed by the NOCASE unique index).
 * @param {{name:string, path:string}} input
 * @throws {Error} on empty name/path, a path that exists but is not a directory,
 *   a duplicate name (case-insensitive), or a duplicate path/key.
 */
export async function addProject(input) {
  insertProject(input);
  return listProjects();
}

/**
 * Add several projects in one call (the multi-folder "Add projects" review).
 * Each item is validated and inserted in its OWN transaction (tx() cannot nest),
 * so one bad row never rolls back the others; a later row sees the rows committed
 * before it, so a duplicate name or repo WITHIN the batch is skipped too. Unlike
 * addProject, a bulk row's folder must exist: every row came from a folder picker,
 * so a missing folder vanished since it was picked. Never throws for a bad row.
 * @param {Array<{name:string, path:string}>} items
 * @returns {Promise<{results: Array<{index:number, status:'added'|'skipped', name:string,
 *   path:string, key?:string, reason?:string}>, projects: Array<{key,name,path,exists}>}>}
 */
export async function addProjects(items) {
  const list = Array.isArray(items) ? items : [];
  const results = list.map((item, index) => {
    const name = item && typeof item.name === 'string' ? item.name.trim() : '';
    const rawPath = item && typeof item.path === 'string' ? item.path : '';
    const path = normalizeProjectPath(rawPath);
    try {
      if (path && !existsSync(path)) throw new Error('folder does not exist');
      const row = insertProject({ name, path: rawPath });
      return { index, status: 'added', key: row.key, name: row.name, path: row.path };
    } catch (err) {
      return { index, status: 'skipped', name, path: path || rawPath, reason: err && err.message ? err.message : String(err) };
    }
  });
  return { results, projects: await listProjects() };
}

/** How long removeProject waits for the metrics-worktree prune before answering. A test passes a
 *  small `pruneWaitMs`; WORCA_PRUNE_WAIT_MS (1 .. 600000) overrides the 10 s default. */
export function pruneWaitMsFrom(env = process.env) {
  const n = Number(env.WORCA_PRUNE_WAIT_MS);
  return Number.isFinite(n) && n > 0 && n <= 600_000 ? n : 10_000;
}

/**
 * Remove a project by name (case-insensitive). Absent name is a no-op. Also prunes any metrics
 * worktree that belonged to this project's repository, waiting up to ~10s for it: the wait is
 * best-effort — a worktree still held by a running flush is skipped and swept on the next start.
 * @param {string} name
 * @returns {Promise<Array<{key:string, name:string, path:string, exists:boolean}>>}
 */
export async function removeProject(name, { pruneWaitMs = pruneWaitMsFrom() } = {}) {
  const key = (typeof name === 'string' ? name : '').trim();
  let removedPath = null;
  if (key) {
    tx(() => {
      const row = prepare('SELECT key, path FROM projects WHERE name = ? COLLATE NOCASE').get(key);
      removedPath = row ? row.path : null;
      prepare('DELETE FROM projects WHERE name = ? COLLATE NOCASE').run(key);
      // Its team-policy discovery cache goes with it: the home stops being followed here, so its Team set greys with
      // Forget (MCP registry spec §11.2), and a later add of the same path discovers afresh.
      // …unless a workspace still has this repo as a member (its policy and metrics homes are members too): Worca still
      // reaches it there (discoverAllPolicies; findLocalRepoBySlug finds the home a workspace's policy project follows
      // among its members), so the home it carries is still followed and its Team set must not grey.
      const inWorkspace = !!row && prepare('SELECT project_key AS path FROM workspace_projects').all()
        .some((w) => { try { return projectKey(w.path) === row.key; } catch { return false; } });
      const pc = row && !inWorkspace ? prepare('SELECT extra FROM project_config WHERE project_key = ?').get(row.key) : null;
      let extra = null;
      try { extra = pc ? JSON.parse(pc.extra) : null; } catch { /* not JSON: left as it is */ }
      if (extra && typeof extra === 'object' && Object.hasOwn(extra, 'teamPolicy')) {
        // The total-cap acknowledgements stay (policy/state.mjs): a project added again is not asked twice in one window.
        const acks = extra.teamPolicy?.acks;
        if (acks && typeof acks === 'object') extra.teamPolicy = { acks }; else delete extra.teamPolicy;
        prepare('UPDATE project_config SET extra = ? WHERE project_key = ?').run(JSON.stringify(extra), row.key);
      }
    });
  }
  if (removedPath) {
    // Dynamic import: metrics/sync.mjs imports this module (worcaHome, listProjects).
    try {
      const { pruneMetricsWorktreesFor } = await import('./metrics/sync.mjs');
      // Bounded: each removal waits for the slug lock, and a running flush can hold it for minutes.
      // The DELETE request must not hang on that; the prune finishes in the background.
      const prune = pruneMetricsWorktreesFor(removedPath).catch(() => []);
      await Promise.race([prune, new Promise((r) => setTimeout(r, pruneWaitMs).unref?.())]);
    } catch { /* best-effort: a leftover worktree is harmless and re-pruned by git */ }
  }
  return listProjects();
}
