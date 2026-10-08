// src/core/skills-registry/resolve.mjs
// The skills half of a set (skills registry §4.2): which skills one spawn mounts, under which generated plugin
// (one per set, so every skill is `/<plugin>:<skill>`), and why the rest are skipped. resolveSkillSets is pure —
// every disk and host fact is an argument, like mcp/registry.mjs#resolveMcpServers — and resolveSkillRegistry is its
// IO shell.
import { RESERVED_SKILL_NAMES, SKILL_NAME_MAX, SKILL_NAME_RE, parseSkillId } from './ids.mjs';
import { loadSkillCatalog } from './catalog.mjs';
import { skillHostFacts } from './host.mjs';
import { collectSets, pluginNameFor, teamSkillMembers } from '../mcp/sets.mjs';
import { readMcpStore } from '../mcp/store.mjs';
import { cachedTeamFor, requiredSkillsOf } from '../mcp/registry.mjs';

// The §8.1 contract names these here; P2 owns them (one rule for views, previews and spawns).
export { pluginNameFor, requiredSkillsOf, teamSkillMembers };

/** Mounted skills per spawn (§2b-5): the cap counts mounts, so a skill reached through two sets counts twice. */
export const SKILL_CAP = Object.freeze({ pipeline: 24, ask: 12 });

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byKeys = (...keys) => (a, b) => { for (const k of keys) { const d = cmp(k(a), k(b)); if (d) return d; } return 0; };
const validSkillName = (n) => typeof n === 'string' && n.length <= SKILL_NAME_MAX && SKILL_NAME_RE.test(n) && !RESERVED_SKILL_NAMES.includes(n);
const isSkillRef = (r) => !!r && typeof r === 'object' && typeof r.skill === 'string';

/** collectSets' Team input. The pinned shape is `{ home, required, requiredSkills? }` — P2's cachedTeamFor /
 *  cachedTeams output (and cachedSkillTeamFor below), passed through unchanged. The §4.2 short form `{ home, required }`
 *  with `{ plugin, skill }` entries is read too: without `requiredSkills`, `required` is split by entry shape. */
function teamsInput(teams) {
  const out = Object.create(null);
  for (const [key, t] of Object.entries(teams ?? {})) {
    if (!t || typeof t !== 'object' || typeof t.home !== 'string') continue;
    const all = Array.isArray(t.required) ? t.required : [];
    const split = !Array.isArray(t.requiredSkills);
    out[key] = { home: t.home, required: split ? all.filter((r) => !isSkillRef(r)) : all,
      requiredSkills: split ? all.filter(isSkillRef) : t.requiredSkills };
  }
  return out;
}

/**
 * The generated plugin name of every set in `sets` (§4.1). Two `--plugin-dir` plugins with one name MERGE (Task 0
 * probe 4), so no two sets share one. Every persisted set (a `store.sets` row, a `store.teams` record, General) is named
 * first, over the whole store, so its name never depends on which sets a call brings: Settings (every set) and a spawn
 * (its own sets) agree. A set keeps pluginNameFor(set, installed) unless a set earlier in id order holds that name (only
 * a hand edit gives two sets one slug); a set that must rename takes the first `-set` name that no installed plugin, no
 * persisted set or Team slug and no name already given holds. A provisional Team set (no record yet, so never consented
 * and never mounted) is named after them; its slug depends on which homes the caller sees, so it is never reserved.
 * `renamed` is true for an installed clash and for a hand-edited duplicate slug alike.
 * @param {Array<{ id: string, slug?: string|null }>} sets
 * @param {{ sets?: object, teams?: object }} [store]  snapshot maps
 * @param {string[]} [takenPluginNames]  skillHostFacts().installedPluginNames
 * @returns {Map<string, { pluginName: string, renamed: boolean }>}  one entry per set in `sets`
 */
export function pluginNamesFor(sets, store = {}, takenPluginNames = []) {
  const installed = [...new Set((Array.isArray(takenPluginNames) ? takenPluginNames : []).filter((n) => typeof n === 'string'))];
  const storeSets = store?.sets ?? {};
  const storeTeams = store?.teams ?? {};
  const persisted = new Map([['general', { id: 'general', slug: null }]]);
  for (const [id, s] of Object.entries(storeSets)) if (id !== 'general') persisted.set(id, { id, slug: s?.slug ?? null });
  for (const t of Object.values(storeTeams)) if (typeof t?.id === 'string') persisted.set(t.id, { id: t.id, slug: t.slug ?? null });
  const slugs = [...Object.values(storeSets), ...Object.values(storeTeams)].map((s) => s?.slug).filter((s) => typeof s === 'string');
  const names = new Map();
  const given = new Set();
  for (const group of [[...persisted.values()], sets.filter((s) => !persisted.has(s.id))]) {
    const later = [];
    for (const set of [...group].sort(byKeys((s) => s.id))) {
      const r = pluginNameFor(set, installed);
      if (!r.renamed && !given.has(r.pluginName)) { names.set(set.id, r); given.add(r.pluginName); } else later.push(set);
    }
    for (const set of later) {
      const { pluginName } = pluginNameFor(set, [...installed, ...slugs, ...given]);
      names.set(set.id, { pluginName, renamed: true });
      given.add(pluginName);
    }
  }
  return new Map(sets.map((s) => [s.id, names.get(s.id)]));
}

/**
 * The pure resolver (§4.2): the skills one spawn mounts. Every output array is sorted, so the same inputs in any
 * order give byte-identical output.
 * @param {object} o
 * @param {'pipeline'|'ask'} o.surface
 * @param {object[]} [o.targets]   exactly as mcp/registry.mjs#resolveMcpServers takes them
 * @param {Record<string, {home:string, required?:object[], requiredSkills?:object[]}|null>} [o.teams]
 * @param {{ catalog: object[], sets: object, teams: object, projects: object }} o.store  catalog = SkillCatalogEntry[]
 * @param {string[]} [o.optOut]    pipeline: `<setId>|<skillId>` keys the run turned off
 * @param {{ sets?: string[], members?: string[] }} [o.off]  Ask: the chat's turned-off sets and keys
 * @param {string[]} [o.takenPluginNames]  skillHostFacts().installedPluginNames
 * @param {number} [o.skillCap]
 */
export function resolveSkillSets({
  surface, targets = [], teams = {}, store, optOut = [], off = { sets: [], members: [] }, takenPluginNames = [],
  skillCap = SKILL_CAP[surface],
}) {
  const ask = surface === 'ask';
  const cap = Number.isSafeInteger(skillCap) && skillCap >= 0 ? skillCap : (ask ? SKILL_CAP.ask : SKILL_CAP.pipeline);
  const catalogList = Array.isArray(store?.catalog) ? store.catalog : [];
  const catalog = new Map(catalogList.map((e) => [e.id, e]));
  const snap = { sets: {}, teams: {}, projects: {}, ...store, catalog: catalogList, skillCatalog: catalogList };
  const sets = collectSets({ ask, targets, teams: teamsInput(teams), store: snap });
  const names = pluginNamesFor([...sets.values()], snap, takenPluginNames);
  const opted = new Set(ask ? [] : optOut);
  const offSets = new Set(ask ? off?.sets ?? [] : []);
  const offMembers = new Set(ask ? off?.members ?? [] : []);
  const nameOf = (skillId) => catalog.get(skillId)?.name ?? parseSkillId(skillId)?.name ?? skillId;

  const memberships = [];
  for (const set of sets.values()) {
    const seen = new Set();   // a skill id at most once per set — a hand-edited repeat reads once
    for (const k of Array.isArray(set.skills) ? set.skills : []) {
      if (!k || typeof k.skillId !== 'string' || seen.has(k.skillId)) continue;
      seen.add(k.skillId);
      memberships.push({ set, skillId: k.skillId, team: k.team === true, consent: k.consent ?? null, enabled: k.enabled === true });
    }
  }
  // Keep order (MCP §5.6): project sets by best target rank, then Team, then General; by set name, set id, skill name.
  const keepGroup = (set) => (set.group === 'set' ? 0 : set.group === 'team' ? 1 : 2);
  memberships.sort(byKeys((m) => keepGroup(m.set), (m) => (m.set.group === 'set' ? m.set.rank : 0), (m) => m.set.name,
    (m) => m.set.id, (m) => nameOf(m.skillId), (m) => m.skillId));

  const skipped = [];
  // A skipped row names its set's plugin and the name the skill would load as (P6/P7 show `<plugin>:<skill>` even for a
  // never-consented Team skill).
  const skip = (m, reason) => {
    const { pluginName } = names.get(m.set.id);
    const name = nameOf(m.skillId);
    skipped.push({ setId: m.set.id, setName: m.set.name, pluginName, qualifiedName: `${pluginName}:${name}`, skillId: m.skillId, name, reason });
  };
  const kept = [];
  const namesBySet = new Map();
  for (const m of memberships) {
    const entry = catalog.get(m.skillId);
    const key = `${m.set.id}|${m.skillId}`;
    const reason = !entry ? 'missing-skill'
      : entry.pluginEnabled === false ? 'plugin-disabled'
      : entry.valid === false || !validSkillName(entry.name) || typeof entry.dir !== 'string' ? 'invalid-skill'
      : m.team && !m.consent ? 'needs-consent'
      : !m.enabled ? 'off'
      : opted.has(key) ? 'opted-out'
      : offSets.has(m.set.id) || offMembers.has(key) ? 'chat-off' : null;
    if (reason) { skip(m, reason); continue; }
    // One folder per name inside a plugin: a second skill of the same name in one set (a hand edit) never mounts.
    const taken = namesBySet.get(m.set.id) ?? new Set();
    if (taken.has(entry.name)) { skip(m, 'name-taken'); continue; }
    namesBySet.set(m.set.id, taken.add(entry.name));
    kept.push({ m, entry });
  }
  for (const k of kept.slice(cap)) skip(k.m, 'cap');

  const mounted = kept.slice(0, cap).map(({ m, entry }) => {
    const { pluginName } = names.get(m.set.id);
    return {
      id: m.skillId, name: entry.name, qualifiedName: `${pluginName}:${entry.name}`, pluginName,
      setId: m.set.id, setName: m.set.name, setSlug: m.set.slug ?? null, dir: entry.dir,
      projects: [...m.set.projects].sort(), description: entry.description ?? '', plugin: entry.plugin ?? null,
    };
  }).sort(byKeys((x) => x.qualifiedName, (x) => x.setId));
  const plugins = [];
  for (const x of mounted) {
    let p = plugins.find((q) => q.setId === x.setId);
    if (!p) plugins.push((p = { setId: x.setId, setName: x.setName, pluginName: x.pluginName, renamedPlugin: names.get(x.setId).renamed, skills: [] }));
    p.skills.push(x.name);
  }
  const pickerGroup = (set) => (set.group === 'general' ? 0 : set.group === 'set' ? 1 : 2);
  return {
    mounted,
    plugins: plugins.sort(byKeys((p) => p.pluginName)),
    skipped: skipped.sort(byKeys((x) => x.setId, (x) => x.skillId)),
    sets: [...sets.values()]
      .sort(byKeys(pickerGroup, (x) => (x.group === 'set' ? x.rank : 0), (x) => x.name, (x) => x.id))
      .map((x) => ({
        id: x.id, name: x.name, group: x.group,
        routes: [...x.routes].sort(byKeys(([, r]) => r.rank, ([p]) => p)).map(([project, r]) => ({ project, route: r.route })),
        skills: memberships.filter((m) => m.set === x).length,
        started: mounted.filter((s) => s.setId === x.id).length,
        pluginName: names.get(x.id).pluginName, renamedPlugin: names.get(x.id).renamed,
      })),
  };
}

const emptySkills = (extra) => ({ mounted: [], plugins: [], skipped: [], sets: [], ...extra });
const storeOf = (snap, catalog) => ({ catalog, sets: snap.sets, teams: snap.teams, projects: snap.projects });
const blockedBy = (facts) => (facts.sideloadDisabled ? 'sideload-disabled' : null);

/**
 * The IO shell (§4.2): the MCP store snapshot (memberships live in `mcp/sets.json`), the skill catalog and this
 * host's facts into resolveSkillSets. `opts` is the resolveSkillSets input minus `store` and `takenPluginNames`.
 * Adds `newer` (a registry file written by a newer Worca: nothing resolves) and `blocked` ('sideload-disabled' when
 * the managed settings forbid --plugin-dir; the caller adds 'cli-no-plugin-dir' from probeClaudeCapabilities).
 * `deps` are test seams.
 */
export async function resolveSkillRegistry(opts = {}, { readStore = readMcpStore, loadSkills = loadSkillCatalog, hostFacts = skillHostFacts } = {}) {
  const snap = await readStore();
  if (snap.newer) return emptySkills({ newer: true, blocked: null });
  const facts = hostFacts();
  const catalog = await loadSkills();
  return { ...resolveSkillSets({ ...opts, store: storeOf(snap, catalog), takenPluginNames: facts.installedPluginNames }),
    newer: false, blocked: blockedBy(facts) };
}

/**
 * The Team input of one Ask / preview target for both halves of a set (§4.2, §4.5): P2's cachedTeamFor unchanged —
 * `{ home, required, requiredSkills? } | null` (null: no cached policy, or it requires neither a server nor a skill;
 * `requiredSkills` only when it requires a skill). One object feeds resolveMcpServers and resolveSkillSets, so a Team
 * set gets one name on both; pass it as `teams[key]` as is. `deps` are cachedTeamFor's test seams.
 * @param {{ projectKey?: string, workspaceId?: string }} target
 * @returns {Promise<{ home: string, required: object[], requiredSkills?: object[] } | null>}
 */
export function cachedSkillTeamFor(target, deps = {}) {
  return cachedTeamFor(target, deps);
}
