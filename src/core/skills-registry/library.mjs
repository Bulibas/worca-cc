// src/core/skills-registry/library.mjs
// The skill library (skills registry design §3.2): <WORCA_HOME>/skills/library.json (schema 1, 0600) and one folder
// per imported skill, <WORCA_HOME>/skills/<name>/ (folders 0700, files 0600, executables 0700). Reads take no lock
// and never throw. Every write runs under skills/.lock inside one in-process queue and never nests. Memberships of
// library skills live in mcp/sets.json: removal goes memberships first (removeSkillEverywhere under the mcp lock,
// the caller's `beforeRemove`), then the folder and the entry here — the two locks are never held together.
// Imports arrive as stages, <WORCA_HOME>/tmp/skills/<stage>/ plus <stage>.json ({ origin, update? }; origin null for
// a pasted SKILL.md), written by import.mjs; a commit copies the stage in, an update swaps the folder.

import { readFileSync, existsSync, rmSync, renameSync, readdirSync, chmodSync, mkdirSync, copyFileSync, lstatSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { worcaHome } from '../projects.mjs';
import { withLock } from '../metrics/lock.mjs';
import { writeJsonAtomic } from '../json-atomic.mjs';
import { inspectSkillDir, skillNameProblem } from './inspect.mjs';

export class SkillLibraryError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.name = 'SkillLibraryError';
    this.status = status;
    if (extra) Object.assign(this, extra);
  }
}
const fail = (status, message, extra) => { throw new SkillLibraryError(status, message, extra); };

export function skillsDir() { return join(worcaHome(), 'skills'); }
const libraryFile = () => join(skillsDir(), 'library.json');

/** Import stages: <WORCA_HOME>/tmp/skills/<16 hex>/ (the skill's files) and <16 hex>.json (its origin). */
export const STAGE_RE = /^[0-9a-f]{16}$/;
export function stagesDir() { return join(worcaHome(), 'tmp', 'skills'); }
export function stageDirOf(stage) {
  if (typeof stage !== 'string' || !STAGE_RE.test(stage)) fail(400, 'not an import stage');
  return join(stagesDir(), stage);
}

const map = () => Object.create(null);
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

const NEWER = 'the skill library needs a newer Worca';
const DAMAGED = 'the skill library file skills/library.json is damaged — fix it or remove it';
const present = (p) => { try { return !!lstatSync(p, { throwIfNoEntry: false }); } catch { return false; } };

// A missing file reads as empty. A file that cannot be trusted — unreadable, not JSON, not an object, `skills` not an
// object, or a dangling link (ENOENT, yet there) — reads as empty and `damaged` without the lock; inside the lock it
// throws (a read error as itself, the rest as 409 DAMAGED): a write built from that empty read would drop every
// entry (mcp/store.mjs readJson's rule). A leading BOM (some Windows editors write one) is no damage, and `schema`
// compares only as a number or text. Entries with a bad name or a non-object value read as absent.
function load(strict) {
  const empty = (damaged) => ({ newer: false, damaged, skills: map() });
  const damaged = () => (strict ? fail(409, DAMAGED) : empty(true));
  let text;
  try { text = readFileSync(libraryFile(), 'utf8'); } catch (e) {
    if (e.code === 'ENOENT' && !present(libraryFile())) return empty(false);
    if (strict && e.code !== 'ENOENT') throw e;
    return damaged();
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let doc = null;
  try { doc = JSON.parse(text); } catch { /* damaged: below */ }
  if (!isMap(doc)) return damaged();
  if (['number', 'string'].includes(typeof doc.schema) && Number(doc.schema) > 1) return { newer: true, damaged: false, skills: map() };
  if (doc.skills !== undefined && !isMap(doc.skills)) return damaged();
  const skills = map();
  for (const [name, entry] of Object.entries(doc.skills ?? {})) {
    if (skillNameProblem(name) === null && isMap(entry)) skills[name] = entry;
  }
  return { newer: false, damaged: false, skills };
}

/** { newer, damaged, skills: { [name]: LibraryEntry } } (null-prototype). No lock; never writes; never throws.
 *  `newer` (schema > 1) or `damaged` (a file that cannot be trusted): no entry is read, and every write refuses (409). */
export function readSkillLibrary() { return load(false); }

// .incoming-<hex> (a copy on its way in), .outgoing-<hex> (a replaced folder) and library.json.<hex>.tmp
// (writeJsonAtomic's temp file): left only by a crash, swept by the next locked write.
const TEMP_RE = /^(?:\.(?:incoming|outgoing)-[0-9a-f]{8}|library\.json\.[0-9a-f]{8}\.tmp)$/;
function sweep() {
  let names;
  try { names = readdirSync(skillsDir()); } catch { return; }
  for (const n of names) if (TEMP_RE.test(n)) rmSync(join(skillsDir(), n), { recursive: true, force: true });
}

let queue = Promise.resolve();
const holding = new AsyncLocalStorage();
const nested = () => holding.getStore()?.active === true;
const NESTED = 'withSkillsLock: skill library operations never nest';

/**
 * Run `fn(tx)` under the library lock. `tx.library` is read inside the lock; `tx.write()` writes library.json
 * from it (0600, atomic). Never nest: a library operation inside `fn` rejects. Busy → 503; newer → 409.
 */
export function withSkillsLock(fn, lockOpts) {
  if (nested()) return Promise.reject(new Error(NESTED));
  const run = queue.then(() => {
    mkdirSync(skillsDir(), { recursive: true, mode: 0o700 });
    return withLock(join(skillsDir(), '.lock'), () => {
      const hold = { active: true };
      return holding.run(hold, async () => {
        try {
          const library = load(true);
          if (library.newer) fail(409, NEWER);
          sweep();
          const tx = {
            library,
            write: () => {
              if (!hold.active) throw new Error('withSkillsLock: tx.write after the lock was released');
              writeJsonAtomic(libraryFile(), { schema: 1, skills: library.skills }, { mode: 0o600 });
            },
          };
          return await fn(tx);
        } finally { hold.active = false; }
      });
    }, lockOpts);
  });
  queue = run.catch(() => {});
  return run.catch((e) => { throw e?.code === 'LOCK_TIMEOUT' ? new SkillLibraryError(503, 'the skill library is busy') : e; });
}

/** The stage at `stageDir` — only a real folder (never a link) directly under stagesDir() named by a stage id, with
 *  its origin file. */
function readStage(stageDir) {
  if (typeof stageDir !== 'string') fail(400, 'not an import stage');
  const dir = resolve(stageDir);
  if (dirname(dir) !== resolve(stagesDir()) || !STAGE_RE.test(basename(dir))) fail(400, 'not an import stage');
  const st = lstatSync(dir, { throwIfNoEntry: false });
  if (st && !st.isDirectory()) fail(400, 'not an import stage');
  let meta = null;
  try { meta = JSON.parse(readFileSync(`${dir}.json`, 'utf8')); } catch { /* gone */ }
  if (!st || !isMap(meta) || !(meta.origin === null || isMap(meta.origin))) fail(404, 'this import is no longer staged — start it again');
  return { dir, meta };
}

function dropStage(dir) {
  rmSync(dir, { recursive: true, force: true });
  rmSync(`${dir}.json`, { force: true });
}
// After a commit or an update the library holds the skill: a stage that cannot be removed now is left to
// discardStage and the day-old sweep, and the operation still reports its success.
function dropStageAfter(dir) {
  try { dropStage(dir); } catch { /* see above */ }
}

function checked(dir, name) {
  const nameProblem = skillNameProblem(name);
  if (nameProblem) fail(400, nameProblem);
  const inspection = inspectSkillDir(dir, { name });
  if (inspection.problems.length) fail(400, inspection.problems.join('; '), { problems: inspection.problems });
  return inspection;
}

// Folders 0700, files 0600, a file with any exec bit 0700 (POSIX; Windows has neither).
function lockDown(dir) {
  if (process.platform === 'win32') return;
  chmodSync(dir, 0o700);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) lockDown(p);
    else chmodSync(p, lstatSync(p).mode & 0o111 ? 0o700 : 0o600);
  }
}

/** Copy a checked stage to skills/.incoming-<hex> with every link replaced by a copy of its file (the inspection
 *  refused each link that leaves the folder, points at a folder or dangles; fs.cpSync would keep links, made
 *  absolute into the stage), then lock the modes down. copyFileSync keeps the source mode, so exec bits survive. */
function copyIn(stageDir) {
  const tmp = join(skillsDir(), `.incoming-${randomBytes(4).toString('hex')}`);
  const copy = (from, to) => {
    mkdirSync(to, { recursive: true });
    for (const e of readdirSync(from, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      if (e.isDirectory()) copy(join(from, e.name), join(to, e.name));
      else if (e.isFile() || e.isSymbolicLink()) copyFileSync(join(from, e.name), join(to, e.name));
    }
  };
  copy(stageDir, tmp);
  lockDown(tmp);
  return tmp;
}

/**
 * Commit an import stage as library skill `name` → its library.json entry. 400 bad name / problems (`problems`) /
 * an update stage; 404 stage gone; 409 name in use or a newer library. The stage is removed after the commit.
 */
export async function commitImport(stageDir, name) {
  const stage = readStage(stageDir);
  if (stage.meta.update) fail(400, 'this stage holds an update — apply it with Update');
  const inspection = checked(stage.dir, name);
  const entry = await withSkillsLock(async (tx) => {
    readStage(stage.dir); // a discard or another commit may have removed it while this one waited: 404, not ENOENT
    if (Object.hasOwn(tx.library.skills, name)) fail(409, `a skill named "${name}" is already in the library`);
    const tmp = copyIn(stage.dir);
    const dest = join(skillsDir(), name);
    rmSync(dest, { recursive: true, force: true }); // a folder no entry names: a crash before the entry was written
    renameSync(tmp, dest);
    const now = new Date().toISOString();
    const e = {
      origin: stage.meta.origin, hash: inspection.hash, importedAt: now, updatedAt: now,
      files: inspection.files.length, bytes: inspection.bytes, scripts: inspection.scripts, shellBlocks: inspection.shellBlocks,
    };
    tx.library.skills[name] = e;
    tx.write();
    return e;
  });
  dropStageAfter(stage.dir);
  return entry;
}

/**
 * Remove library skill `name` → its former entry. `beforeRemove` (async) runs first and outside the library lock:
 * the caller removes the skill's memberships and Team state there (removeSkillEverywhere, mcp lock); when it
 * throws, nothing is removed. Then the folder, then the entry: a crash in between leaves a listed skill with no
 * files (invalid, removable again), never a folder nothing lists. 400 bad name, 404 unknown, 409 a newer or damaged
 * library.json. Nested in withSkillsLock it rejects before `beforeRemove` runs.
 */
export async function removeLibrarySkill(name, { beforeRemove } = {}) {
  if (nested()) throw new Error(NESTED);
  const nameProblem = skillNameProblem(name);
  if (nameProblem) fail(400, nameProblem);
  const missing = () => fail(404, `no skill named "${name}" in the library`);
  const lib = readSkillLibrary();
  if (lib.newer) fail(409, NEWER);
  if (lib.damaged) fail(409, DAMAGED);
  if (!Object.hasOwn(lib.skills, name)) missing();
  if (beforeRemove) await beforeRemove();
  return withSkillsLock(async (tx) => {
    if (!Object.hasOwn(tx.library.skills, name)) missing();
    const entry = tx.library.skills[name];
    rmSync(join(skillsDir(), name), { recursive: true, force: true });
    delete tx.library.skills[name];
    tx.write();
    return entry;
  });
}

/**
 * Replace library skill `name` with an update stage (import.mjs updatePreview) → the new entry (origin, hash and
 * counts from the stage; importedAt kept). 400 bad name / not an update of `name` / problems; 404 stage gone or
 * unknown name.
 */
export async function applyUpdate(name, stageDir) {
  const nameProblem = skillNameProblem(name);
  if (nameProblem) fail(400, nameProblem);
  const stage = readStage(stageDir);
  if (stage.meta.update !== name) fail(400, `this stage is not an update of "${name}"`);
  const inspection = checked(stage.dir, name);
  const entry = await withSkillsLock(async (tx) => {
    readStage(stage.dir); // a second Update of the same preview may have used it while this one waited
    if (!Object.hasOwn(tx.library.skills, name)) fail(404, `no skill named "${name}" in the library`);
    const tmp = copyIn(stage.dir);
    const dest = join(skillsDir(), name);
    const old = join(skillsDir(), `.outgoing-${randomBytes(4).toString('hex')}`);
    if (existsSync(dest)) renameSync(dest, old);
    renameSync(tmp, dest);
    const e = {
      ...tx.library.skills[name], origin: stage.meta.origin, hash: inspection.hash, updatedAt: new Date().toISOString(),
      files: inspection.files.length, bytes: inspection.bytes, scripts: inspection.scripts, shellBlocks: inspection.shellBlocks,
    };
    tx.library.skills[name] = e;
    tx.write();
    try { rmSync(old, { recursive: true, force: true }); } catch { /* the next locked write sweeps .outgoing-* */ }
    return e;
  });
  dropStageAfter(stage.dir);
  return entry;
}
