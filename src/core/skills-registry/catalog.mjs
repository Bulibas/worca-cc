// src/core/skills-registry/catalog.mjs
// The skill catalog (skills registry design §3.3): every skill an installed Worca plugin ships in
// realpath(<plugin>/current)/skills/<name>/SKILL.md (disabled plugins included, pluginEnabled:false) and every
// library skill, each inspected. An invalid skill (bad name, no frontmatter, limits, a link out of its folder,
// .claude-plugin/) is listed with valid:false and its problems, and never mounted. Built like mcp/catalog.mjs
// loadCatalog: it reads the plugin lock directly, so the resolver and every Sets route can call it. Sync; read-only;
// no network, no git. A skill folder whose stat fingerprint is unchanged since the last call is not re-read.

import { readdirSync, realpathSync, existsSync, lstatSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readPluginsLock, pluginCurrentDir } from '../plugins-lock.mjs';
import { skillIdOf, SKILL_ID_RE } from './ids.mjs';
import { SKILL_LIMITS, SKILL_LINKS_AND_FOLDERS_MAX, inspectSkillDir, isValidSkillFolderName } from './inspect.mjs';
import { readSkillLibrary, skillsDir } from './library.mjs';

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// Every entry's path, mode, size, mtime and ctime (a link adds what it resolves to), walked like the inspection
// (sorted, `.git` skipped, `.claude-plugin/` not entered): stats only, no reads. It never stops before the walk does:
// links and folders count as the walk counts them, and only regular files count as files (the walk also counts a link
// to a file inside the folder), so it stops after SKILL_LIMITS.files + 1 files or SKILL_LINKS_AND_FOLDERS_MAX + 1
// links and folders. Equal fingerprints ⇒ the inspection is reused. A folder's own mtime catches added and removed
// entries.
function fingerprint(dir) {
  const parts = [];
  let files = 0;
  let others = 0;
  const visit = (d, rel) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { parts.push(`!${rel}`); return; }
    for (const e of entries.sort(byName)) {
      if (files > SKILL_LIMITS.files || others > SKILL_LINKS_AND_FOLDERS_MAX) return;
      if (e.name === '.git') continue; // the walk skips it too: never part of a skill, never counted
      const p = join(d, e.name);
      const r = `${rel}/${e.name}`;
      let st;
      try { st = lstatSync(p); } catch { parts.push(`?${r}`); continue; }
      parts.push(`${r}\0${st.mode}\0${st.size}\0${st.mtimeMs}\0${st.ctimeMs}`);
      if (e.isSymbolicLink()) {
        others++;
        try { const t = statSync(p); parts.push(`>${realpathSync(p)}\0${t.mode}\0${t.size}\0${t.mtimeMs}\0${t.ctimeMs}`); } catch { parts.push('>?'); }
      } else if (e.isDirectory()) {
        others++;
        if (e.name !== '.claude-plugin') visit(p, r);
      } else if (e.isFile()) {
        files++; // a FIFO or socket is no file of the skill
      }
    }
  };
  try { const st = statSync(dir); parts.push(`${realpathSync(dir)}\0${st.mtimeMs}\0${st.ctimeMs}`); } catch { return '!'; }
  visit(dir, '');
  return parts.join('\n');
}

// `<name> NUL <dir>` → { fp, result }; rebuilt on every call, so skills no longer listed are dropped.
let cache = new Map();

function entry({ source, plugin, name, dir, code, pluginEnabled }, next) {
  const id = skillIdOf({ source, plugin, name });
  const key = `${name}\0${dir}`;
  const fp = fingerprint(dir);
  const hit = cache.get(key);
  const r = hit && hit.fp === fp ? hit.result : inspectSkillDir(dir, { name });
  next.set(key, { fp, result: r });
  const problems = [...r.problems];
  if (!problems.length && !SKILL_ID_RE.test(id)) problems.push(`${id} is not a valid skill id`);
  return {
    id, source, plugin, name, dir, description: r.description, whenToUse: r.whenToUse, frontmatter: { ...r.frontmatter },
    files: r.files.length, bytes: r.bytes, scripts: [...r.scripts], shellBlocks: r.shellBlocks, hash: r.hash, code, pluginEnabled,
    valid: problems.length === 0, problems,
  };
}

/** `dir` = realpath(<plugin>/current)/skills/<name>: versions/<sha7> for an install, the working dir when linked. */
function pluginSkills(next) {
  const lock = readPluginsLock();
  const out = [];
  for (const plugin of Object.keys(lock)) {
    const e = lock[plugin] && typeof lock[plugin] === 'object' ? lock[plugin] : {};
    let root;
    try { root = realpathSync(pluginCurrentDir(plugin)); } catch { continue; } // dangling current / bad name: ships nothing
    let dirs;
    try { dirs = readdirSync(join(root, 'skills'), { withFileTypes: true }); } catch { continue; }
    const code = e.linked === true ? 'linked' : typeof e.pinnedSha === 'string' ? e.pinnedSha.slice(0, 7) : null;
    for (const d of dirs) {
      const dir = join(root, 'skills', d.name);
      if (!d.isDirectory() || !existsSync(join(dir, 'SKILL.md'))) continue;
      out.push(entry({ source: 'plugin', plugin, name: d.name, dir, code, pluginEnabled: e.enabled !== false }, next));
    }
  }
  return out;
}

/**
 * @param {{ newer:boolean, skills:object }} [librarySnapshot]  readSkillLibrary() result; read when omitted
 * @returns {Array<{ id, source:'plugin'|'library', plugin:string|null, name, dir, description, whenToUse:string|null,
 *   frontmatter:{ allowedTools, hooks, shell, disableModelInvocation, pluginRootRefs }, files:number, bytes:number,
 *   scripts:string[], shellBlocks:number, hash, code:string|null, pluginEnabled:boolean, valid:boolean, problems:string[] }>}
 *   sorted by id. A newer library.json lists no library skills (plugin skills stay).
 */
export function loadSkillCatalog(librarySnapshot) {
  const lib = librarySnapshot ?? readSkillLibrary();
  const next = new Map();
  const out = pluginSkills(next);
  if (!lib.newer) {
    for (const name of Object.keys(lib.skills)) {
      if (!isValidSkillFolderName(name)) continue; // a hand-built snapshot: never a path out of the library
      out.push(entry({ source: 'library', plugin: null, name, dir: join(skillsDir(), name), code: null, pluginEnabled: true }, next));
    }
  }
  cache = next;
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
