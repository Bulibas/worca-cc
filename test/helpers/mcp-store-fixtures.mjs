// test/helpers/mcp-store-fixtures.mjs — shared by the MCP store tests: a fresh home per test, raw file
// fixtures, and a recorder of the store's atomic writes (file order + the content each rename published).
import fs, { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { beforeEach } from 'node:test';
import { useTempHome } from './temp-home.mjs';
import { mcpDir } from '../../src/core/mcp/store.mjs';

export function freshHomes(after) {
  const root = useTempHome(after);
  beforeEach(() => { process.env.WORCA_HOME = mkdtempSync(join(root, 'h-')); });
}
export const plain = (v) => JSON.parse(JSON.stringify(v));
export const file = (n) => join(mcpDir(), `${n}.json`);
export const put = (n, obj) => { mkdirSync(mcpDir(), { recursive: true }); writeFileSync(file(n), JSON.stringify({ schema: 1, ...obj })); };
export const disk = (n) => JSON.parse(readFileSync(file(n), 'utf8'));

/** Run `fn` and return every JSON file it published, in order: [{ file: 'sets', json }]. */
export async function recordWrites(fn) {
  const seen = [];
  const orig = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to.endsWith('.json')) seen.push({ file: basename(to, '.json'), json: JSON.parse(readFileSync(from, 'utf8')) });
    return orig(from, to);
  };
  syncBuiltinESMExports();
  try { await fn(); } finally { fs.renameSync = orig; syncBuiltinESMExports(); }
  return seen;
}
