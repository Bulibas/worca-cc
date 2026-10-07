// src/core/skills-registry/ids.mjs
// Skill identity (skills registry design §3.1). Pure.
//   skill:plugin:<plugin>/<name>   a skill an installed Worca plugin ships in skills/<name>/
//   skill:library:<name>           a skill imported into <WORCA_HOME>/skills/<name>/
// SKILL_ID_SRC is copied as a literal into src/core/mcp/definitions.mjs (membership keys `<setId>|<memberId>`);
// a test there asserts the two are equal. PLUGIN_NAME_RE names the plugin Worca generates per set.

export const SKILL_NAME_RE  = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;   // + length ≤ 64, not in RESERVED_SKILL_NAMES
export const SKILL_NAME_MAX = 64;
export const RESERVED_SKILL_NAMES = ['synced', 'anthropic-skills'];
export const SKILL_ID_SRC = '(?:skill:plugin:[a-z][a-z0-9]*(?:-[a-z0-9]+)*/[a-z0-9]+(?:-[a-z0-9]+)*|skill:library:[a-z0-9]+(?:-[a-z0-9]+)*)';
export const SKILL_ID_RE  = new RegExp('^(?=.{1,1024}$)' + SKILL_ID_SRC + '$');
export const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;  // generated-plugin names (set slugs fit)

/** 'plugin' → skill:plugin:<plugin>/<name>; 'library' → skill:library:<name>; any other source → null.
 *  Formats only: an id built from a bad name fails SKILL_ID_RE (the catalog lists such a skill as invalid). */
export function skillIdOf({ source, plugin, name } = {}) {
  if (source === 'plugin') return `skill:plugin:${plugin}/${name}`;
  if (source === 'library') return `skill:library:${name}`;
  return null;
}

/** → { source: 'plugin'|'library', plugin: string|null, name } | null (null for anything SKILL_ID_RE refuses). */
export function parseSkillId(id) {
  if (typeof id !== 'string' || !SKILL_ID_RE.test(id)) return null;
  if (id.startsWith('skill:library:')) return { source: 'library', plugin: null, name: id.slice('skill:library:'.length) };
  const rest = id.slice('skill:plugin:'.length);
  const i = rest.indexOf('/');
  return { source: 'plugin', plugin: rest.slice(0, i), name: rest.slice(i + 1) };
}
