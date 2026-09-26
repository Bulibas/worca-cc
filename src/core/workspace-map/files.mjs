// src/core/workspace-map/files.mjs
// The file layer every workspace-map stage reads through (spec D12, §8): list a member's files
// (git ls-files, else a bounded walk), keep every path inside the member root, read text safely
// (size cap, binary sniff, no symlinks — not even a symlinked directory on the way), and run git
// without a shell and without the caller's GIT_DIR.

import { execFile } from 'node:child_process';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { LIMITS } from '../../shared/workspace-map/limits.mjs';

export const SKIP_DIRS = Object.freeze(['.git', 'node_modules', 'vendor', 'dist', 'build', 'target', 'out',
  '.next', '.nuxt', 'coverage', 'graphify-out', '.venv', 'venv', '__pycache__', '.gradle', '.idea', '.vscode',
  'bin', 'obj', 'Pods', 'DerivedData', '.terraform', '.worca-cc']);

/** Case-insensitive file systems (win32, darwin): `Node_Modules/` and `Bin/` are the skipped dirs too. */
const FOLD = process.platform === 'win32' || process.platform === 'darwin';
const fold = (s) => (FOLD ? s.toLowerCase() : s);
const SKIP = new Set(SKIP_DIRS.map(fold));
const TEST_DIR_RE = /(^|\/)(test|tests|__tests__|e2e|fixtures?|testdata|androidtest|[^/]+\.tests?)\//i;
const TEST_FILE_RE = /(\.test\.[^/]+$)|(_test\.go$)|(Tests?\.(java|kt)$)|(Tests\.cs$)|((^|\/)test_[^/]+\.py$)|((^|\/)tests?\.py$)|(_test\.py$)|(_spec\.rb$)/;
/** `spec/` / `specs/` directories and the `.spec.` infix mark test CODE only: an API contract kept
 *  there (`specs/openapi.yaml`, `api.spec.yaml`, `spec/schema.graphql`, a `.proto`) is what a member
 *  provides, not a test. */
const SPEC_TEST_RE = /(^|\/)specs?\/|\.spec\.[^/]+$/i;
const CONTRACT_RE = /\.(ya?ml|json|graphqls?|gql|proto)$/i;
const SNIFF_BYTES = 8192;
/** git's location variables beat its cwd: a worca started from a git hook (GIT_DIR set) would
 *  otherwise list — and read the HEAD and the remote of — the hook's repository. */
const GIT_ENV_DROP = Object.freeze(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_PREFIX']);

/** posix rel → true for test code (never creates an edge; counted). Test directory names match in
 *  any case (`Tests/`, `Spec/`), .NET test projects (`Billing.Tests/`) and Django's `tests.py` too.
 *  `spec/`, `specs/` and `*.spec.*` count only for code: a YAML / JSON / GraphQL / proto contract
 *  there is not a test (`test/`, `e2e/`, `fixtures/` … still cover every file). */
export function isTestPath(rel) {
  if (typeof rel !== 'string') return false;
  if (TEST_DIR_RE.test(rel) || TEST_FILE_RE.test(rel)) return true;
  return SPEC_TEST_RE.test(rel) && !CONTRACT_RE.test(rel);
}

const skipped = (rel) => rel.split('/').some((seg) => SKIP.has(fold(seg)));

/** true when absolute `abs` lies strictly inside absolute `root` (a name such as `..env` is inside). */
const inside = (root, abs) => {
  const back = relative(root, abs);
  return !!back && back !== '..' && !back.startsWith(`..${sep}`) && !isAbsolute(back);
};

/** Runs git (no shell; GIT_DIR & co. dropped from its env) in `dir` → git's stdout as printed
 *  (untrimmed: callers trim), or null on any failure — and for a missing / non-string `dir`
 *  (never the process cwd). */
export function gitOutput(dir, args, { timeoutMs = 30000, maxBuffer = 256 * 1024 * 1024 } = {}) {
  if (typeof dir !== 'string' || !dir || !Array.isArray(args)) return Promise.resolve(null);
  const env = { ...process.env };
  for (const k of GIT_ENV_DROP) delete env[k];
  return new Promise((done) => {
    try {
      execFile('git', args, { cwd: dir, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer, windowsHide: true },
        (err, stdout) => done(err ? null : String(stdout)));
    } catch {
      done(null);
    }
  });
}

async function walk(dir, maxFiles) {
  const files = [];
  const queue = [''];
  let truncated = false;
  let visited = 0;
  while (queue.length) {
    const relDir = queue.shift();
    let entries;
    try {
      entries = await readdir(relDir ? join(dir, ...relDir.split('/')) : dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      visited += 1;
      if (visited > maxFiles * 4) return { files, truncated: true };
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP.has(fold(e.name))) queue.push(rel); continue; }
      if (!e.isFile()) continue;
      if (files.length >= maxFiles) { truncated = true; continue; }
      files.push(rel);
    }
  }
  return { files, truncated };
}

/** git ls-files -z (cwd dir; falls back to a bounded fs walk when git fails); drops SKIP_DIRS
 *  paths; sorted posix rel paths. A missing / non-string dir lists nothing.
 *  → { files, truncated, via: 'git'|'walk' } */
export async function listMemberFiles(dir, { maxFiles = LIMITS.MAX_FILES_PER_MEMBER } = {}) {
  if (typeof dir !== 'string' || !dir) return { files: [], truncated: false, via: 'walk' };
  const out = await gitOutput(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (out !== null) {
    const all = [...new Set(out.split('\0').filter((p) => p && !skipped(p)))].sort();
    // Over the cap the shallowest files win, as in the walk: a monorepo keeps its root manifests, not only `apps/**`.
    const kept = all.length > maxFiles
      ? all.map((p) => [p.split('/').length, p]).sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).slice(0, maxFiles).map((x) => x[1]).sort()
      : all;
    return { files: kept, truncated: all.length > maxFiles, via: 'git' };
  }
  const w = await walk(dir, maxFiles);
  return { files: w.files.sort(), truncated: w.truncated, via: 'walk' };
}

/** lexical containment: not absolute, no '..' segment and no drive-letter segment anywhere
 *  (`a/C:/x` switches drives on Windows), and the result strictly inside the root; returns the
 *  absolute path or null */
export function resolveInside(dir, rel) {
  if (typeof dir !== 'string' || !dir || typeof rel !== 'string' || !rel.trim() || rel.includes('\0')) return null;
  if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || /^[\\/]/.test(rel)) return null;
  if (rel.split(/[\\/]/).some((seg) => seg === '..' || /^[A-Za-z]:/.test(seg))) return null;
  const root = resolve(dir);
  // One joined argument, never a spread: an agent-written `file` of ~130 000 segments overflowed the
  // call stack (RangeError), and the catalog's catch-all then dropped every entry.
  const abs = resolve(root, rel.split(/[\\/]/).filter(Boolean).join('/'));
  return inside(root, abs) ? abs : null;
}

/** utf8 text or null (missing, a symlink, a real path outside the member — a symlinked directory on
 *  the way —, > maxBytes, NUL byte in the first 8 KiB). `realRoot`: realpath(dir), resolved ONCE by a
 *  caller that reads a whole member (extract, the candidate scan), so a read does not resolve the root
 *  again; the containment check is the same. */
export async function readText(dir, rel, { maxBytes = LIMITS.MAX_FILE_BYTES, realRoot = null } = {}) {
  const abs = resolveInside(dir, rel);
  if (!abs) return null;
  return readAbsText(abs, { maxBytes, root: dir, realRoot });
}

/** readText for an already-contained absolute path (the verifier's cache reads through it). With
 *  `root` (or its precomputed `realRoot`), the file's REAL path must lie inside root's real path. */
export async function readAbsText(abs, { maxBytes = LIMITS.MAX_FILE_BYTES, root = null, realRoot = null } = {}) {
  try {
    const st = await lstat(abs);
    if (!st.isFile() || st.size > maxBytes) return null;
    if (root !== null || realRoot !== null) {
      const top = realRoot ?? await realpath(root);
      if (!inside(top, await realpath(abs))) return null;
    }
    const buf = await readFile(abs);
    if (buf.subarray(0, SNIFF_BYTES).includes(0)) return null;
    const text = buf.toString('utf8');
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return null;
  }
}
