// src/core/terminal/same-dir.mjs — a dependency-free leaf (#574): the manager and the Ask command service both
// import it (context.mjs would drag artifacts/db into the service's unit test).
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/** Same folder, through symlinks: $PWD may be logical (/tmp/x) or physical (/private/tmp/x on macOS). */
export function sameDir(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  try { return realpathSync.native(a) === realpathSync.native(b); } catch { return false; }
}

/** `dir` is `root` or a folder under it, through symlinks (a link inside the root that points out is outside).
 *  Paths that do not resolve compare as written, normalised; a path that resolves only on one side is outside. */
export function insideDir(dir, root) {
  if (!dir || !root) return false;
  const real = (p) => { try { return realpathSync.native(p); } catch { return resolve(p); } };
  const d = real(dir);
  const r = real(root);
  return d === r || d.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
}
