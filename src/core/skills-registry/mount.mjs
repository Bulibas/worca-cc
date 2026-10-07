// src/core/skills-registry/mount.mjs
// Skills registry §4.1: the mount — one generated Claude Code plugin per set under `<base>/<pluginName>/`, each
// carrying a dereferenced copy of its skills, delivered with one `--plugin-dir` per plugin. Nothing is written into a
// checkout. `<base>` is rebuilt from scratch on every call (idempotent on resume). Synchronous: callers may await it.
// Modes are set explicitly, whatever the umask and whatever the source had (the library keeps 0600/0700): folders 0750,
// files 0640, 0750 when the source is executable. Relayed agent users read the mount through its group, as everything
// worca shares with them (agent-user.mjs#shareWithAgent; the setgid worca-share dirs of docker/entrypoint.sh): a folder
// keeps the setgid bit it inherited, so files below it keep that group.
import { chmodSync, copyFileSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PLUGIN_NAME_RE, RESERVED_SKILL_NAMES, SKILL_NAME_MAX, SKILL_NAME_RE } from './ids.mjs';
import { SKILL_LIMITS } from './inspect.mjs';
import { skillsDir } from './library.mjs';

/** The generated plugin's manifest (§4.1; `claude plugin validate` accepts it — its one warning is the missing author). */
export const PLUGIN_MANIFEST = (name, setName) => ({ name, version: '1.0.0', description: `Worca set ${setName}` });

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const validSkillName = (n) => typeof n === 'string' && n.length <= SKILL_NAME_MAX && SKILL_NAME_RE.test(n) && !RESERVED_SKILL_NAMES.includes(n);
/** A folder of the mount: 0750 whatever the umask, keeping a setgid bit it inherited (Linux: new files then keep the
 *  shared group). */
const mkdirShared = (p) => { mkdirSync(p, { recursive: true }); chmodSync(p, 0o750 | (statSync(p).mode & 0o2000)); };

/** Folders a mount must never replace, because `<base>` is removed recursively first (§5 isolation): anything with a
 *  `.claude` segment (personal, project and skills-dir plugins), the `skills` and `plugins` folders of a relocated
 *  CLAUDE_CONFIG_DIR (only those: a deployment may put the Worca home inside that dir), and Worca's own skill library —
 *  inside one of them, or holding one. Case-folded off Linux (APFS / NTFS ignore case). Best-effort: a Worca home that
 *  cannot be resolved (node:test without WORCA_HOME) protects nothing more. */
function protectedBase(base, env = process.env) {
  if (base.split(/[\\/]/).some((seg) => seg.toLowerCase() === '.claude')) return true;
  const fold = (p) => (process.platform === 'linux' ? p : p.toLowerCase());
  const within = (p, root) => {
    const r = relative(fold(root), fold(p));
    return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
  };
  const roots = [];
  if (typeof env?.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR.trim()) {
    const cfg = resolve(env.CLAUDE_CONFIG_DIR);
    roots.push(join(cfg, 'skills'), join(cfg, 'plugins'));
  }
  try { roots.push(resolve(skillsDir())); } catch { /* no Worca home: nothing more to protect */ }
  return roots.some((root) => within(base, root) || within(root, base));
}

/** Copy one skill folder with explicit dereferencing (never fs.cpSync, which can leave nested links pointing into the
 *  source): every entry is resolved with realpath, a link may not leave the folder, only regular files are copied,
 *  modes 0640 / 0750 (exec bit kept), SKILL_LIMITS enforced again (a linked plugin is live). `.git` is never part of a
 *  skill, as in P1's inspect and catalog: never copied (its config can hold a credential), never counted. */
function copySkillTree(src, dst) {
  const root = realpathSync(src);
  if (!statSync(root).isDirectory()) throw new Error('not a folder');
  const totals = { files: 0, bytes: 0 };
  const open = new Set();
  const walk = (dir, out) => {
    if (open.has(dir)) throw new Error(`${relative(root, dir) || '.'}: a link loops back into the skill`);
    open.add(dir);
    mkdirShared(out);
    for (const name of readdirSync(dir).sort(cmp)) {
      if (name === '.git') continue;
      const from = join(dir, name);
      let real;
      try { real = realpathSync(from); } catch { throw new Error(`${relative(root, from)}: a broken link`); }
      const rel = relative(root, real);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${relative(root, from)}: a link out of the skill folder`);
      const st = statSync(real);
      if (st.isDirectory()) { walk(real, join(out, name)); continue; }
      if (!st.isFile()) continue;   // sockets, fifos
      totals.files += 1;
      totals.bytes += st.size;
      if (totals.files > SKILL_LIMITS.files || st.size > SKILL_LIMITS.fileBytes || totals.bytes > SKILL_LIMITS.totalBytes) {
        throw new Error('over the skill size limits');
      }
      const to = join(out, name);
      copyFileSync(real, to);
      chmodSync(to, st.mode & 0o111 ? 0o750 : 0o640);
    }
    open.delete(dir);
  };
  walk(root, dst);
}

/**
 * Materialize a resolveSkillSets result as generated plugins under `base` (§4.1 layout):
 *   <base>/<pluginName>/.claude-plugin/plugin.json   PLUGIN_MANIFEST(pluginName, setName)
 *   <base>/<pluginName>/skills/<skillName>/…         a dereferenced copy of the catalog entry's folder
 * `base` must be an absolute, normalized path that is, or sits right under, a folder named `skills` (pipeline:
 * `<pipeline.dir>/skills`; Ask, per message: `<home>/ask/<thread>/skills/<message>`), outside every `.claude` folder, the
 * `skills` / `plugins` folders of CLAUDE_CONFIG_DIR and the Worca skill library — it is removed first. Plugin and skill names are re-validated before
 * they become path segments; a skill that cannot be copied is left out (`failed`), a plugin left with no skill is not
 * written. A plugin refused as a whole yields one `failed` row per skill it would have carried (one `name: null` row
 * when it carried none), so a caller drops exactly the skills that `failed` names.
 * @param {{ result: { plugins: object[], mounted: object[] }, base: string }} o
 * @returns {{ base: string, pluginDirs: string[], plugins: Array<{ setId, pluginName, dir, skills: string[] }>,
 *   failed: Array<{ setId, pluginName, name, error }> }}
 */
export function materializeSkillMount({ result, base }) {
  if (typeof base !== 'string' || !isAbsolute(base) || resolve(base) !== base
    || (basename(base) !== 'skills' && basename(dirname(base)) !== 'skills') || protectedBase(base)) {
    throw new Error('materializeSkillMount: base must be an absolute path that is or sits right under a "skills" folder '
      + `(normalized; never in a .claude folder, the Claude config dir's skills or plugins, or the Worca skill library), got ${JSON.stringify(base)}`);
  }
  rmSync(base, { recursive: true, force: true });
  const out = { base, pluginDirs: [], plugins: [], failed: [] };
  const mounted = Array.isArray(result?.mounted) ? result.mounted : [];
  const plugins = (Array.isArray(result?.plugins) ? [...result.plugins] : []).sort((a, b) => cmp(a?.pluginName, b?.pluginName));
  const seen = new Set();
  // A plugin's skills are the mounted rows of its set under its name (the resolver never gives two sets one name).
  const skillsOf = (p) => mounted.filter((x) => x?.pluginName === p?.pluginName && x?.setId === p?.setId);
  for (const p of plugins) {
    if (typeof p?.pluginName !== 'string' || !PLUGIN_NAME_RE.test(p.pluginName) || seen.has(p.pluginName)) {
      const lost = [...new Set(skillsOf(p).map((m) => m.name ?? null))].sort(cmp);
      for (const name of lost.length ? lost : [null]) {
        out.failed.push({ setId: p?.setId ?? null, pluginName: p?.pluginName ?? null, name, error: 'not a usable plugin name' });
      }
      continue;
    }
    seen.add(p.pluginName);
    const dir = join(base, p.pluginName);
    mkdirShared(base);
    mkdirShared(dir);
    mkdirShared(join(dir, 'skills'));
    const skills = [];
    for (const m of skillsOf(p).sort((a, b) => cmp(a.name, b.name))) {
      const fail = (error) => out.failed.push({ setId: p.setId, pluginName: p.pluginName, name: m.name ?? null, error });
      if (!validSkillName(m.name) || skills.includes(m.name)) { fail('not a usable skill name'); continue; }
      if (typeof m.dir !== 'string' || !isAbsolute(m.dir)) { fail('no skill folder'); continue; }
      const to = join(dir, 'skills', m.name);
      try { copySkillTree(m.dir, to); skills.push(m.name); }
      catch (err) { rmSync(to, { recursive: true, force: true }); fail(err?.message ?? String(err)); }
    }
    if (!skills.length) { rmSync(dir, { recursive: true, force: true }); continue; }
    mkdirShared(join(dir, '.claude-plugin'));
    const manifest = join(dir, '.claude-plugin', 'plugin.json');
    writeFileSync(manifest, `${JSON.stringify(PLUGIN_MANIFEST(p.pluginName, p.setName), null, 2)}\n`);
    chmodSync(manifest, 0o640);
    out.plugins.push({ setId: p.setId, pluginName: p.pluginName, dir, skills });
    out.pluginDirs.push(dir);
  }
  return out;
}
