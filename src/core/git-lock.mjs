// A git killed while it holds the index lock (SIGKILL — a timeout, an OOM kill, a crashed
// agent tool — skips git's own cleanup) leaves `index.lock` behind, and every later index
// write in that checkout fails with "File exists" until someone removes it. Left alone, one
// such leftover silently breaks the per-step staging for the rest of a run and then the
// teardown commit (pipeline 25d78e23).
import { stat, unlink } from 'node:fs/promises';

const INDEX_LOCK_HELD = /Unable to create '([^']*[\\/]index\.lock)': File exists/;

// No index write worca or an agent runs holds the lock anywhere near this long (the harness
// git timeout is 2 minutes); a lock this old has no live owner.
export const STALE_INDEX_LOCK_MS = 10 * 60_000;

/**
 * Given the stderr of a failed git command, remove the `index.lock` it names when that lock
 * is stale. Returns `{ path, ageMs }` when the caller should retry (removed, or already gone:
 * `ageMs: null`), else `null` (not a lock failure, or a lock young enough to be live).
 * @param {string} stderr
 * @param {{maxAgeMs?:number}} [opts]
 * @returns {Promise<{path:string, ageMs:number|null}|null>}
 */
export async function clearStaleIndexLock(stderr, { maxAgeMs = STALE_INDEX_LOCK_MS } = {}) {
  const m = INDEX_LOCK_HELD.exec(String(stderr || ''));
  if (!m) return null;
  const path = m[1];
  let st;
  try { st = await stat(path); } catch { return { path, ageMs: null }; }
  const ageMs = Date.now() - st.mtimeMs;
  if (ageMs < maxAgeMs) return null;
  try { await unlink(path); } catch (err) { if (err.code !== 'ENOENT') return null; }
  return { path, ageMs };
}
