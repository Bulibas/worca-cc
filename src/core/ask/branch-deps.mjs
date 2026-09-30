// src/core/ask/branch-deps.mjs
// The branch reader bundle for list_branches / list_projects.sync / get_run.baseMoved (#527).
// Separate from tool-deps.mjs (whose source is scanned as write-free and fs-minimal). A fetch
// here updates ONLY remote-tracking refs + FETCH_HEAD; nothing in this file fast-forwards,
// creates a branch or touches a working tree — test/ask-branch-tools.test.mjs pins that.
import { existsSync } from 'node:fs';
import { listBranches, syncStatus, commitsBetween, lastFetchedAt, isSafeBranchName, isSafeRemoteName } from '../git-sync.mjs';
import { effectiveSyncSettings, chipBase } from '../project-sync.mjs';
import { listProjects } from '../projects.mjs';
import { readWorkspace } from '../workspaces.mjs';
import { mapWithCap, fanoutCap } from '../fanout.mjs';

const MISSING = 'project folder is missing on disk';

/** null = not a registered key; { missing:true } = registered but its folder is gone. */
async function projectOf(key) {
  const p = (await listProjects()).find((x) => x.key === key);
  if (!p) return null;
  return p.exists ? p : { key, missing: true };
}

// D15: in classic mode this runs in the MCP child, which has no worca GitHub credential
// (scrubbed env), so a private github.com fetch can fail with `auth`. Say so plainly; the
// server's background refresh keeps the same refs / FETCH_HEAD fresh, which fetchedAt shows.
// Only for git's "no credential at all" wording: in relay mode (server process, credentialed)
// a real rejection reads "Authentication failed" / 403 and is passed through unchanged.
const CHILD_AUTH_NOTE = 'could not sign in to the remote from the Ask tool process; showing the last fetch (see fetchedAt)';
const NO_CREDENTIAL = /could not read (?:Username|Password)|terminal prompts disabled/i;
const withNote = (r) => (r && r.fetchError && r.fetchError.kind === 'auth' && NO_CREDENTIAL.test(String(r.fetchError.message || ''))
  ? { ...r, fetchError: { kind: 'auth', message: CHILD_AUTH_NOTE } } : r);

export function defaultBranchDeps() {
  return {
    branches: {
      async list(projectKey, opts) {
        const p = await projectOf(projectKey);
        if (!p) return null;
        if (p.missing) return { projectKey, ok: false, error: MISSING };
        return withNote({ projectKey, ...(await listBranches(p.path, { ...opts, remote: effectiveSyncSettings(p.key).remote })) });
      },
      /** One result per member. The row budget is SHARED: opts.limit is the workspace total
       *  (tools.mjs clamps it), split evenly so 40 members can never return 40 × 200 rows. */
      async listWorkspace(workspaceId, opts) {
        const ws = await readWorkspace(workspaceId);
        if (!ws) return null;
        const members = ws.projectPaths.map((dir, i) => ({ dir, key: ws.projectKeys[i], gone: ws.exists && ws.exists[i] === false }));
        const per = Math.max(1, Math.ceil((opts.limit || 100) / Math.max(1, members.length)));
        return mapWithCap(members, fanoutCap(), async (m) => (m.gone
          ? { projectKey: m.key, ok: false, error: MISSING }                       // no git in a dead cwd
          : withNote({ projectKey: m.key,
            ...(await listBranches(m.dir, { ...opts, limit: per, remote: effectiveSyncSettings(m.key).remote })) })));
      },
      /** No network: { base, ahead, behind, dirty, fetchedAt } per EXISTING project key. */
      async status(projects) {
        // Catalog rows are {key, name, path} with NO `exists` (catalog.mjs): check the disk.
        const live = projects.filter((p) => p && p.path && existsSync(p.path));
        const rows = await mapWithCap(live, fanoutCap(), async (p) => {
          const base = await chipBase(p.path);
          if (!base) return null;
          const s = await syncStatus(p.path, { base, remote: effectiveSyncSettings(p.key).remote });
          return s.ok && s.hasRemote ? { base, ahead: s.ahead, behind: s.behind, dirty: s.dirty, fetchedAt: s.fetchedAt } : null;
        });
        return new Map(live.map((p, i) => [p.key, rows[i]]));
      },
      /** No network at all (get_run must stay cheap): commits on the last-fetched <remote>/<source>
       *  since baseSha; commits null = unknown (a missing ref never reads as "not moved"). */
      async baseMoved({ projectDir, projectKey, source, baseSha, remote: recorded = null }) {
        if (!projectDir || !source || !baseSha || !isSafeBranchName(source)) return null;
        const remote = isSafeRemoteName(recorded) ? recorded : effectiveSyncSettings(projectKey).remote;
        if (!isSafeRemoteName(remote)) return null;
        // Two cheap reads — never a full syncStatus (no `git status` on the user's checkout per get_run).
        const [commits, fetchedAt] = await Promise.all([
          commitsBetween(projectDir, baseSha, `refs/remotes/${remote}/${source}`),
          lastFetchedAt(projectDir, { remote }),
        ]);
        return { commits, fetchedAt };
      },
    },
  };
}
