// test/helpers/skill-sets.mjs — skills registry fixtures for the pipeline tests (design §4.3):
// library skills imported through the real stage/commit API and set memberships through the
// real store API, under the caller's temp WORCA_HOME (test/helpers/temp-home.mjs).
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitDir } from './git-dir.mjs';
import { projectKey } from '../../src/core/store.mjs';
import { createSet, setProjectAssignment, putSkillMember } from '../../src/core/mcp/store.mjs';
import { stageImport } from '../../src/core/skills-registry/import.mjs';
import { commitImport } from '../../src/core/skills-registry/library.mjs';
import { loadSkillCatalog } from '../../src/core/skills-registry/catalog.mjs';

const rand = () => Math.random().toString(36).slice(2, 7);

const made = [];   // every scratch folder this test process made, removed when it exits
process.on('exit', () => {
  for (const d of made) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});
/** A scratch folder under the OS tmpdir, removed when the test process exits. */
export function scratchDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** A throwaway git repo with one empty commit (git-dir.mjs `gitDir`), removed when the test process exits. */
export function scratchGitDir(tag) {
  const dir = gitDir(tag);
  made.push(dir);
  return dir;
}

// P3 reads this machine's managed settings unless pointed elsewhere: under `npm test` on a host whose managed
// settings disable sideloading, every layer these fixtures build would be blocked (each Run line of the plan sets it too).
if (process.env.WORCA_CLAUDE_MANAGED_SETTINGS === undefined) process.env.WORCA_CLAUDE_MANAGED_SETTINGS = '/nonexistent/managed.json';

/** A skill folder: SKILL.md whose frontmatter name is the folder name. */
export function skillFolder(name) {
  const dir = join(scratchDir('worca-skill-src-'), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} steps\n---\n# ${name}\n`);
  return dir;
}

const imported = new Map();   // per WORCA_HOME: a library name is imported once
/** The catalog entry of library skill `name`, imported on first use. */
export function librarySkill(name) {
  const key = `${process.env.WORCA_HOME}|${name}`;
  if (!imported.has(key)) {
    imported.set(key, (async () => {
      const st = await stageImport({ kind: 'dir', path: skillFolder(name) }, {});
      await commitImport(st.dir, st.name);
      return (await loadSkillCatalog()).find((e) => e.id === `skill:library:${name}`);
    })());
  }
  return imported.get(key);
}

/** Add library skills to a set (on), in order. */
export async function addSkills(setId, names, { enabled = true } = {}) {
  const added = [];
  for (const n of names) {
    const entry = await librarySkill(n);
    await putSkillMember(setId, entry.id, { enabled }, { entry, siblingNames: [...added] });
    added.push(entry.name);
  }
}

/** A git project whose own new set holds `names` (on), General left out. `dir` may be given. */
export async function skillSetFixture(names = ['deploy-checklist', 'release-notes'], { dir = scratchGitDir('skills-run') } = {}) {
  const set = await createSet(`Billing ${rand()}`);
  await addSkills(set.id, names);
  await setProjectAssignment(projectKey(dir), { sets: [set.id], includeGeneral: false });
  return { dir, set };
}

/** What a dispatch carried, recorded at spawn time: its plugin dirs, whether each is on disk, its skills. */
export function spawnRecord(ctx) {
  const dirs = ctx.skillPluginDirs;
  return {
    ctx, dirs,
    present: (dirs || []).every((d) => existsSync(join(d, '.claude-plugin', 'plugin.json'))),
    skills: (dirs || []).map((d) => (existsSync(join(d, 'skills')) ? readdirSync(join(d, 'skills')).sort() : [])),
  };
}
