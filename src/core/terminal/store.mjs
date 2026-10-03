// src/core/terminal/store.mjs — the terminal's rows in worca's DB (schema v50, issue #573): sessions,
// blocks (one per recorded command: what ran, where, its output tail, exit, duration, who), the audit
// log and the branch worktrees. Blocks and audit rows are kept; `source` is 'person' today and leaves
// room for agent-run commands. Ask Worca's follow-up reads listBlocks / getBlock / listAudit.
import { prepare } from '../db.mjs';

const iso = (ms) => new Date(ms).toISOString();
const limitOf = (n, dflt) => Math.min(Math.max(Number(n) || dflt, 1), 1000);

// ── sessions ─────────────────────────────────────────────────────────────────────────────────────
export function insertSession(s) {
  prepare(`INSERT INTO terminal_sessions (id, scope, label, run_id, member, project_key, branch, cwd, shell, shell_kind, mode,
      integration, status, pid, owner_pid, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(s.id, s.scope, s.label ?? null, s.runId ?? null, s.member ?? null, s.projectKey ?? null, s.branch ?? null, s.cwd,
      s.shell, s.shellKind, s.mode, s.integration ? 1 : 0, s.status, s.pid ?? null, process.pid, s.createdBy ?? null, s.createdAt);
}
export function setSessionIntegration(id) {
  prepare('UPDATE terminal_sessions SET integration = 1 WHERE id = ?').run(id);
}
export function endSession(id, { status, exitCode = null, closedBy = null, now = Date.now() }) {
  prepare('UPDATE terminal_sessions SET status = ?, exit_code = ?, closed_by = ?, ended_at = ? WHERE id = ?')
    .run(status, exitCode, closedBy, iso(now), id);
}
const sessionOf = (r) => (r ? {
  id: r.id, scope: r.scope, label: r.label, runId: r.run_id, member: r.member, projectKey: r.project_key, branch: r.branch,
  cwd: r.cwd, shell: r.shell, shellKind: r.shell_kind, mode: r.mode, integration: !!r.integration, status: r.status,
  exitCode: r.exit_code, pid: r.pid, createdBy: r.created_by, createdAt: r.created_at, endedAt: r.ended_at, closedBy: r.closed_by,
} : null);
export const getSession = (id) => sessionOf(prepare('SELECT * FROM terminal_sessions WHERE id = ?').get(id));
export function listSessions({ runId = null, limit = 50 } = {}) {
  const rows = runId
    ? prepare('SELECT * FROM terminal_sessions WHERE run_id = ? ORDER BY created_at DESC LIMIT ?').all(runId, limitOf(limit, 50))
    : prepare('SELECT * FROM terminal_sessions ORDER BY created_at DESC LIMIT ?').all(limitOf(limit, 50));
  return rows.map(sessionOf);
}

/**
 * Boot: a session still 'running' that is not live in this server, and whose owner is not another live
 * worca server, was killed with its server. A row stamped with THIS pid is stale too: after a container
 * restart the new server usually gets the old one's pid (often 1). `liveIds` = this server's live sessions.
 */
export function markInterruptedSessions({ isAlive, liveIds = new Set(), now = Date.now() }) {
  const rows = prepare("SELECT id, run_id, owner_pid FROM terminal_sessions WHERE status = 'running'").all();
  let n = 0;
  for (const r of rows) {
    if (liveIds.has(r.id)) continue;                                                    // running here
    if (r.owner_pid && r.owner_pid !== process.pid && isAlive(r.owner_pid)) continue;   // another live worca's
    endSession(r.id, { status: 'interrupted', now });
    prepare("UPDATE terminal_blocks SET status = 'interrupted', ended_at = ? WHERE session_id = ? AND status = 'running'").run(iso(now), r.id);
    recordAudit({ sessionId: r.id, runId: r.run_id, action: 'interrupted', detail: 'worca stopped while this terminal was open', now });
    n++;
  }
  return n;
}

// ── blocks ───────────────────────────────────────────────────────────────────────────────────────
const blockOf = (r, withOutput) => (r ? {
  sessionId: r.session_id, seq: r.seq, source: r.source, runId: r.run_id, member: r.member, command: r.command, cwd: r.cwd,
  status: r.status, exitCode: r.exit_code, startedAt: r.started_at, endedAt: r.ended_at, durationMs: r.duration_ms,
  outputBytes: r.output_bytes, truncated: !!r.output_truncated, runBy: r.run_by, stoppedBy: r.stopped_by,
  ...(withOutput ? { output: r.output } : {}),
} : null);

export function getBlock(sessionId, seq, { output = true } = {}) {
  return blockOf(prepare('SELECT * FROM terminal_blocks WHERE session_id = ? AND seq = ?').get(sessionId, Number(seq)), output);
}
export function startBlock({ sessionId, seq, command, cwd = null, runId = null, member = null, runBy = null, source = 'person', now = Date.now() }) {
  prepare(`INSERT INTO terminal_blocks (session_id, seq, source, run_id, member, command, cwd, status, started_at, run_by)
      VALUES (?,?,?,?,?,?,?,'running',?,?)`).run(sessionId, seq, source, runId, member, command, cwd, iso(now), runBy);
  return getBlock(sessionId, seq, { output: false });
}
export function finishBlock({ sessionId, seq, status, exitCode = null, output = '', outputBytes = 0, truncated = false, stoppedBy = null, now = Date.now() }) {
  const row = prepare('SELECT started_at FROM terminal_blocks WHERE session_id = ? AND seq = ?').get(sessionId, seq);
  const durationMs = row ? Math.max(0, now - Date.parse(row.started_at)) : null;
  prepare(`UPDATE terminal_blocks SET status = ?, exit_code = ?, ended_at = ?, duration_ms = ?, output = ?, output_bytes = ?,
      output_truncated = ?, stopped_by = ? WHERE session_id = ? AND seq = ?`)
    .run(status, exitCode, iso(now), durationMs, output, outputBytes, truncated ? 1 : 0, stoppedBy, sessionId, seq);
  return getBlock(sessionId, seq, { output: false });
}
/**
 * Blocks of one session (oldest first, after `afterSeq`) or of one run (newest first). Never the output.
 * `newest`: a session's LAST `limit` blocks, still oldest first (the pane shows the recent end).
 */
export function listBlocks({ sessionId = null, runId = null, afterSeq = 0, limit = 200, newest = false } = {}) {
  if (sessionId) {
    const sql = newest
      ? 'SELECT * FROM (SELECT * FROM terminal_blocks WHERE session_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?) ORDER BY seq'
      : 'SELECT * FROM terminal_blocks WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?';
    return prepare(sql).all(sessionId, Number(afterSeq) || 0, limitOf(limit, 200)).map((r) => blockOf(r, false));
  }
  if (runId) {
    return prepare('SELECT * FROM terminal_blocks WHERE run_id = ? ORDER BY started_at DESC, id DESC LIMIT ?')
      .all(runId, limitOf(limit, 200)).map((r) => blockOf(r, false));
  }
  return [];
}
export const countBlocks = (sessionId, afterSeq = 0) =>
  prepare('SELECT COUNT(*) AS n FROM terminal_blocks WHERE session_id = ? AND seq > ?').get(sessionId, Number(afterSeq) || 0).n;

// ── audit ────────────────────────────────────────────────────────────────────────────────────────
/** One audit row. Never throws into the terminal: a failed write is a [worca] warning. */
export function recordAudit({ sessionId, blockSeq = null, runId = null, actor = null, action, detail = null, now = Date.now() }) {
  try {
    prepare('INSERT INTO terminal_audit (ts, session_id, block_seq, run_id, actor, action, detail) VALUES (?,?,?,?,?,?,?)')
      .run(iso(now), sessionId, blockSeq, runId, actor, action, detail == null ? null : String(detail).slice(0, 4000));
  } catch (e) {
    console.warn(`[worca] terminal audit write failed (${action}): ${e?.message || e}`);
  }
}
const auditOf = (r) => ({ ts: r.ts, sessionId: r.session_id, blockSeq: r.block_seq, runId: r.run_id, actor: r.actor, action: r.action, detail: r.detail });
export function listAudit({ sessionId = null, runId = null, limit = 200 } = {}) {
  if (sessionId) return prepare('SELECT * FROM terminal_audit WHERE session_id = ? ORDER BY ts, id LIMIT ?').all(sessionId, limitOf(limit, 200)).map(auditOf);
  if (runId) return prepare('SELECT * FROM terminal_audit WHERE run_id = ? ORDER BY ts, id LIMIT ?').all(runId, limitOf(limit, 200)).map(auditOf);
  return prepare('SELECT * FROM terminal_audit ORDER BY ts DESC, id DESC LIMIT ?').all(limitOf(limit, 200)).map(auditOf);
}

// ── branch worktrees ─────────────────────────────────────────────────────────────────────────────
const wtOf = (r) => (r ? { dir: r.dir, projectKey: r.project_key, branch: r.branch, detached: !!r.detached,
  createdBy: r.created_by, createdAt: r.created_at, lastUsedAt: r.last_used_at } : null);
export function insertBranchWorktree({ dir, projectKey, branch, detached = false, by = null, now = Date.now() }) {
  prepare(`INSERT OR REPLACE INTO terminal_worktrees (dir, project_key, branch, detached, created_by, created_at, last_used_at)
      VALUES (?,?,?,?,?,?,?)`).run(dir, projectKey, branch, detached ? 1 : 0, by, iso(now), iso(now));
}
export const getBranchWorktree = (dir) => wtOf(prepare('SELECT * FROM terminal_worktrees WHERE dir = ?').get(dir));
export const findBranchWorktree = (projectKey, branch) =>
  wtOf(prepare('SELECT * FROM terminal_worktrees WHERE project_key = ? AND branch = ? ORDER BY last_used_at DESC LIMIT 1').get(projectKey, branch));
/** Least recently used first (the cap evicts from the front). */
export const listBranchWorktrees = (projectKey = null) => (projectKey
  ? prepare('SELECT * FROM terminal_worktrees WHERE project_key = ? ORDER BY last_used_at').all(projectKey)
  : prepare('SELECT * FROM terminal_worktrees ORDER BY last_used_at').all()).map(wtOf);
export const touchBranchWorktree = (dir, now = Date.now()) => { prepare('UPDATE terminal_worktrees SET last_used_at = ? WHERE dir = ?').run(iso(now), dir); };
export const deleteBranchWorktree = (dir) => { prepare('DELETE FROM terminal_worktrees WHERE dir = ?').run(dir); };
