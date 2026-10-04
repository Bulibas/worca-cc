// src/core/terminal/same-dir.mjs — a dependency-free leaf (#574): the manager and the Ask command service both
// import it (context.mjs would drag artifacts/db into the service's unit test).
import { realpathSync } from 'node:fs';

/** Same folder, through symlinks: $PWD may be logical (/tmp/x) or physical (/private/tmp/x on macOS). */
export function sameDir(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  try { return realpathSync.native(a) === realpathSync.native(b); } catch { return false; }
}
