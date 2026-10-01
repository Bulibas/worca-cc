// src/core/json-atomic.mjs
// Atomic JSON write shared by plugin config (plugin-config.mjs) and the MCP registry store
// (mcp/store.mjs): temp file + chmod + rename, so a reader never sees a half-written file.

import { writeFileSync, renameSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export function writeJsonAtomic(file, obj, { mode } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', mode !== undefined ? { mode } : { encoding: 'utf8' });
  if (mode !== undefined) chmodSync(tmp, mode); // umask-proof: mode is exact
  renameSync(tmp, file);
}
