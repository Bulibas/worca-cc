// test/helpers/skills-registry-fixtures.mjs — shared by the skills registry tests: the committed skill fixtures
// copied into a scratch dir (modes are set there, so a checkout without exec bits still tests them), hand-built
// skill folders, and installed or linked plugins that ship skills.
import { cpSync, mkdirSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginDir, readPluginsLock, writePluginsLock } from '../../src/core/plugins-lock.mjs';

export const SKILL_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'skills');
export const POSIX = process.platform !== 'win32';

/** Copy test/fixtures/skills/<name> to <destRoot>/<as>; beta-scripts' scripts/run.sh gets 0755 (POSIX). */
export function copyFixture(name, destRoot, as = name) {
  const dest = join(destRoot, as);
  cpSync(join(SKILL_FIXTURES, name), dest, { recursive: true });
  if (POSIX && name === 'beta-scripts') chmodSync(join(dest, 'scripts', 'run.sh'), 0o755);
  return dest;
}

/** A skill folder from { 'rel/path': text }; returns the folder. */
export function writeSkill(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

/** A minimal SKILL.md. */
export const skillMd = (name, description = `The ${name} skill.`, body = 'Do the thing.\n') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;

/** An installed plugin (lock entry + current → versions/<sha7>) or, with `linkedDir`, a linked one (current → that
 *  dir), shipping `skills` ({ name: { 'SKILL.md': text, … } }). Returns the dir `current` points at. */
export function installSkillPlugin(name, { skills = {}, enabled = true, linkedDir = null, sha = 'abcdef0123456789abcdef0123456789abcdef01' } = {}) {
  const root = linkedDir ?? join(pluginDir(name), 'versions', sha.slice(0, 7));
  mkdirSync(root, { recursive: true });
  for (const [skill, files] of Object.entries(skills)) writeSkill(join(root, 'skills', skill), files);
  mkdirSync(pluginDir(name), { recursive: true });
  symlinkSync(root, join(pluginDir(name), 'current'), 'junction');
  const entry = linkedDir
    ? { repo: null, subdir: '', linked: true, enabled, installedAt: '2026-10-06T00:00:00.000Z' }
    : { repo: '/x', subdir: '', pinnedSha: sha, version: '1', enabled, installedAt: '2026-10-06T00:00:00.000Z' };
  writePluginsLock({ ...readPluginsLock(), [name]: entry });
  return root;
}
