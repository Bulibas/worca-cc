// Heartbeat to a control plane (W3, docs/remote-access.md "Heartbeat to a control plane"). A
// platform that hosts worca (suspends idle instances, wakes them before a scheduled run, upgrades
// them) needs to know, once a minute, whether this instance is healthy, which version it runs,
// how many pipelines are in which state, when the next scheduled run is due and whether stopping
// the container now would interrupt anything.
//
// Opt-in: nothing runs unless BOTH WORCA_HEARTBEAT_URL and WORCA_HEARTBEAT_TOKEN are set, so a
// self-hosted deployment that sets neither (worca-01) sends nothing. worca knows nothing about the
// platform beyond that URL.
//
// The body holds counts, the version and booleans only — never titles, projects, people or
// reasons: platform staff see this (worca-run D15). `today` (B5) is extra; a receiver that does
// not know it ignores it.
import { statfs } from 'node:fs/promises';
import { prepare, getDb } from './db.mjs';
import { AFTER_RUN_AT } from './scheduler.mjs';

export const HEARTBEAT_INTERVAL_MS = 60_000;
export const FIRST_BEAT_DELAY_MS = 5_000;
export const POST_TIMEOUT_MS = 10_000;
/** Below this share of free disk on the data dir the instance reports `degraded`. */
export const MIN_FREE_DISK_RATIO = 0.05;

export const PIPELINE_KEYS = Object.freeze(['running', 'waiting', 'done', 'failed', 'stopped']);
const TODAY_KEYS = Object.freeze(['done', 'failed', 'stopped']);

const ACTIVE = new Set(['created', 'starting', 'running', 'pausing']);
// Live-list kinds that are not pipelines: they block suspension but are not counted.
const NOT_PIPELINES = new Set(['agentgen', 'scriptbench', 'action']);
// A pause worca can't get out of without someone (or more budget): it waits. A pause by hand
// (pauseReason null) or by a drain before a stop is a stop.
const STOP_PAUSES = new Set(['drain', 'user']);

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** { url, token } from the environment, or null (off). `error` when set but unusable. */
export function heartbeatConfig(env = process.env) {
  const url = String(env.WORCA_HEARTBEAT_URL || '').trim();
  const token = String(env.WORCA_HEARTBEAT_TOKEN || '').trim();
  if (!url || !token) return null;
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname))) return { url: u.href, token };
  } catch { /* fall through */ }
  return { error: 'WORCA_HEARTBEAT_URL must be an https URL (http only for localhost): no heartbeat is sent' };
}

/**
 * Which bucket a live-run entry (summarizeRuns() shape, or a runs-Map entry) counts in, or null
 * for entries that aren't active pipelines (finished entries still in the Map, benches, actions).
 */
export function classifyLiveRun(r) {
  if (!r || NOT_PIPELINES.has(r.kind)) return null;
  const s = String(r.status || '').toLowerCase();
  if (ACTIVE.has(s)) return r.pendingQuestion ? 'waiting' : 'running';
  if (s === 'paused') {
    if (r.pendingQuestion) return 'waiting';
    return r.pauseReason && !STOP_PAUSES.has(r.pauseReason) ? 'waiting' : 'stopped';
  }
  return null;
}

/** The pipelines row status -> heartbeat bucket for runs no live entry holds. */
function dbBucket(status) {
  switch (status) {
    case 'done': return 'done';
    case 'error': return 'failed';
    // Paused or interrupted with nothing live behind it: it waits for a Resume, by hand or by B3.
    // A stale `running` row (the process that owned it is gone) becomes `interrupted` on the next
    // boot, so it counts the same.
    case 'stopped': case 'paused': case 'interrupted':
    case 'created': case 'starting': case 'running': case 'pausing':
      return 'stopped';
    default: return null;
  }
}

/**
 * Counts per status over the pipelines table, without archived rows and without the runs a live
 * entry already counts. Source split: active and waiting states come from the live list (a pending
 * question exists only in memory), finished ones from the DB (the live Map forgets them).
 */
export function dbPipelineCounts({ excludeIds = [] } = {}) {
  const ex = [...new Set(excludeIds.filter(Boolean).map(String))];
  const ph = ex.map(() => '?').join(',');
  const rows = prepare(`SELECT status, COUNT(*) AS n FROM pipelines WHERE archived_at IS NULL
    ${ex.length ? `AND id NOT IN (${ph})` : ''} GROUP BY status`).all(...ex);
  const out = Object.fromEntries(PIPELINE_KEYS.map((k) => [k, 0]));
  for (const { status, n } of rows) {
    const b = dbBucket(status);
    if (b) out[b] += Number(n) || 0;
  }
  return out;
}

/** Runs that finished today (B5): terminal status written since local midnight (TZ=UTC in the image). */
export function todayCounts({ now = Date.now() } = {}) {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
  const rows = prepare(`SELECT status, COUNT(*) AS n FROM pipelines
    WHERE status IN ('done','error','stopped') AND COALESCE(updated_at, started_at) >= ? GROUP BY status`).all(start);
  const out = { done: 0, failed: 0, stopped: 0 };
  for (const { status, n } of rows) out[status === 'error' ? 'failed' : status] += Number(n) || 0;
  return out;
}

/** Unix seconds of the next planned start (resume tickets included, "after another run" placeholders not), or null. */
export function nextScheduledAt() {
  const row = prepare(`SELECT MIN(run_at) AS at FROM scheduled_runs WHERE status = 'scheduled' AND run_at < ?`).get(AFTER_RUN_AT);
  const ms = row?.at ? Date.parse(row.at) : NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** True when the DB takes a write lock: BEGIN IMMEDIATE fails on a read-only, locked-out or broken file. */
export function dbWritable(db = getDb()) {
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec('ROLLBACK');
    return true;
  } catch {
    try { db.exec('ROLLBACK'); } catch { /* no transaction open */ }
    return false;
  }
}

/** True when less than MIN_FREE_DISK_RATIO of `dir`'s filesystem is free; false when it can't be read. */
export async function diskNearlyFull(dir, statfsImpl = statfs) {
  try {
    const s = await statfsImpl(dir);
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    return total > 0 && free / total < MIN_FREE_DISK_RATIO;
  } catch {
    return false;
  }
}

/**
 * The body, from plain inputs (pure).
 * @param {object} o
 * @param {Array} o.liveRuns           summarizeRuns()-shaped entries
 * @param {object} [o.dbCounts]        dbPipelineCounts() for runs no live entry holds
 * @param {string} o.version
 * @param {number|null} [o.nextScheduledAt]
 * @param {object} [o.signals]         { brokerDown, dbWriteFailed, diskFull, bootFailed, schedulerStale }
 * @param {object} [o.busy]            { askTurns, terminals, actions, setupJobs, otherJobs } (counts or booleans)
 * @param {object} [o.today]           todayCounts()
 */
export function buildHeartbeatBody({ liveRuns = [], dbCounts = null, version, nextScheduledAt: next = null, signals = {}, busy = {}, today = null }) {
  const pipelines = Object.fromEntries(PIPELINE_KEYS.map((k) => [k, Number(dbCounts?.[k]) || 0]));
  let active = false;
  for (const r of liveRuns) {
    const b = classifyLiveRun(r);
    if (b) pipelines[b] += 1;
    // Anything live and not settled blocks suspension, pipeline or not (an agent generation, a
    // bench). A run waiting on a question is still `running`, so it blocks too: Away mode may
    // answer it. A paused run holds no process and doesn't.
    if (ACTIVE.has(String(r?.status || '').toLowerCase())) active = true;
  }
  const health = Object.values(signals).some(Boolean) ? 'degraded' : 'ok';
  const suspendable = !active && !Object.values(busy).some((v) => (typeof v === 'number' ? v > 0 : !!v));
  return {
    health,
    version: String(version || 'unknown').slice(0, 64),
    pipelines,
    nextScheduledAt: Number.isInteger(next) && next >= 0 ? next : null,
    suspendable,
    today: Object.fromEntries(TODAY_KEYS.map((k) => [k, Number(today?.[k]) || 0])),
  };
}

/**
 * Start sending. `collect()` returns the body (or a promise of it). Returns `{ stop, beat }`, or
 * null when the heartbeat is off. Never throws; a failed post is logged at most once per streak.
 */
export function startPlatformHeartbeat({ env = process.env, collect, fetchImpl = fetch, log = console.warn,
  intervalMs = HEARTBEAT_INTERVAL_MS, firstDelayMs = FIRST_BEAT_DELAY_MS, timeoutMs = POST_TIMEOUT_MS } = {}) {
  const cfg = heartbeatConfig(env);
  if (!cfg) return null;
  if (cfg.error) { log(`[worca-ui] heartbeat: ${cfg.error}`); return null; }
  let failing = false;
  let inflight = null;

  async function send() {
    let body;
    try { body = await collect(); } catch (err) {
      if (!failing) log(`[worca-ui] heartbeat: could not collect the state: ${err?.message || err}`);
      failing = true;
      return false;
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(cfg.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      try { await res.body?.cancel?.(); } catch { /* nothing to drain */ }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (failing) log('[worca-ui] heartbeat: delivered again');
      failing = false;
      return true;
    } catch (err) {
      if (!failing) log(`[worca-ui] heartbeat: not delivered (${err?.name === 'AbortError' ? 'timed out' : err?.message || err}); retrying every ${Math.round(intervalMs / 1000)} s`);
      failing = true;
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
  // One post at a time: a slow control plane never piles up requests.
  const beat = () => (inflight ||= send().finally(() => { inflight = null; }));

  const first = setTimeout(beat, firstDelayMs);
  const every = setInterval(beat, intervalMs);
  first.unref?.();
  every.unref?.();
  return {
    beat,
    stop() { clearTimeout(first); clearInterval(every); },
  };
}
