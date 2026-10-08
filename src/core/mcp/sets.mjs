// src/core/mcp/sets.mjs
// Which sets a spawn's targets bring and each set's members — MCP servers and skills (MCP registry §5.1, skills registry
// §4.2) — shared by the MCP resolver (registry.mjs) and the skills resolver; and the name a set's skills load under.
// Pure: the store snapshot, the catalog and the Team inputs come in. A Team set's members derive from its policy's
// required lists; a workspace target brings its member projects' sets and the workspace policy's Team set — workspaces
// attach no sets of their own (F7).
import { teamRecordsFor } from './identity.mjs';
import { canonicalJson, sha256Hex } from './definitions.mjs';

const own = (map, key) => (map && Object.hasOwn(map, key) ? map[key] : undefined);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byKeys = (...keys) => (a, b) => { for (const k of keys) { const d = cmp(k(a), k(b)); if (d) return d; } return 0; };
const nonEmpty = (v) => Array.isArray(v) && v.length > 0;

/**
 * A Team set's members, derived from the policy's `mcp.required` entries (§11.2): a plugin reference maps to
 * `plugin:<p>/<s>`, an inline entry to `policy:<home>/<name>`; an entry whose server is not in the catalog is no
 * member (a checklist row). A member's state is `state[serverId]`, else off and never consented.
 * @returns {Array<{ serverId: string, state: { enabled: boolean, values: object, seeded: object, consent: string|null } }>}
 */
export function teamMembers(home, required, catalog, state) {
  const ids = new Set(catalog.map((e) => e.id));
  const out = [];
  for (const r of Array.isArray(required) ? required : []) {
    if (typeof r?.plugin === 'string' ? typeof r.server !== 'string' : typeof r?.name !== 'string') continue;   // not an entry
    const serverId = typeof r.plugin === 'string' ? `plugin:${r.plugin}/${r.server}` : `policy:${home}/${r.name}`;
    if (!ids.has(serverId) || out.some((m) => m.serverId === serverId)) continue;
    out.push({ serverId, state: own(state, serverId) ?? { enabled: false, values: {}, seeded: {}, consent: null } });
  }
  return out;
}

/**
 * A Team set's skills (skills registry §4.2, F8), derived from the policy's `skills.required` entries `{ plugin, skill }`
 * as teamMembers derives servers: the id is `skill:plugin:<plugin>/<skill>`; an entry that is not one or whose skill is
 * not in the catalog is no member (a checklist row); a repeated skill name keeps the first entry (one name per set,
 * §3.2). A member's state is `state[skillId]`, else off and never consented. Its `consent` counts only when it is the
 * entry's consent hash (§2b-10: sha256 of canonical `{ plugin, skill }`, what the Team checklist's Turn on writes); any
 * other value reads as null, so the resolver and the checklist agree on who consented.
 * @returns {Array<{ skillId: string, state: { enabled: boolean, consent: string|null, pending?: boolean } }>}
 */
export function teamSkillMembers(home, required, catalog, state) {
  const ids = new Set(catalog.map((e) => e.id));
  const names = new Set();
  const out = [];
  for (const r of Array.isArray(required) ? required : []) {
    if (typeof r?.plugin !== 'string' || typeof r.skill !== 'string') continue;   // not an entry
    const skillId = `skill:plugin:${r.plugin}/${r.skill}`;
    if (!ids.has(skillId) || names.has(r.skill)) continue;
    names.add(r.skill);
    const st = own(state, skillId) ?? { enabled: false, consent: null };
    const hash = sha256Hex(canonicalJson({ plugin: r.plugin, skill: r.skill }));
    out.push({ skillId, state: { ...st, consent: st.consent === hash ? hash : null } });
  }
  return out;
}

/**
 * §5.1: every set the targets bring, with the projects and routes that bring it, its best rank, its MCP members and its
 * skills. `teams[key] = { home, required, requiredSkills? } | null` (key: a project key, or `ws:<id>` for a workspace);
 * a Team set comes when either list holds an entry. `store = { catalog, sets, teams, projects }`: Team members and Team
 * skills derive over `store.catalog` — the MCP resolver passes the MCP catalog (its Team skills come out empty), the
 * skills resolver the skill catalog (its Team servers come out empty). A `pending` member or skill reads as off; a Team
 * skill's consent is teamSkillMembers'.
 * @returns {Map<string, { id, name, slug, group, provisional, rank, projects: Set<string>, routes: Map,
 *   members: object[], skills: Array<{ skillId: string, team: boolean, consent: string|null, enabled: boolean }> }>}
 */
export function collectSets({ ask, targets, teams, store }) {
  const sets = new Map();
  const takenSlugs = [...Object.values(store.sets), ...Object.values(store.teams)].map((s) => s.slug).filter(Boolean);
  const requires = (t) => nonEmpty(t?.required) || nonEmpty(t?.requiredSkills);
  // §4.4: a Team set with no record is named for reads the way a write would persist it (homes ascending).
  const homes = Object.values(teams).filter(requires).map((t) => t.home);
  const provisional = teamRecordsFor(store.teams, homes, takenSlugs);
  const teamRec = (home) => own(store.teams, home) ?? own(provisional, home);
  const bring = (id, make, target, projects) => {
    let s = sets.get(id);
    if (!s) sets.set(id, (s = { ...make(), rank: Infinity, projects: new Set(), routes: new Map() }));
    s.rank = Math.min(s.rank, target.rank ?? 0);
    for (const p of projects) {
      s.projects.add(p);
      const r = s.routes.get(p);
      if (!r || (target.rank ?? 0) < r.rank) s.routes.set(p, { route: target.route ?? null, rank: target.rank ?? 0 });
    }
  };
  const userSet = (id) => () => {
    const s = own(store.sets, id) ?? { members: [] };
    return { id, name: id === 'general' ? 'General' : s.name, slug: id === 'general' ? null : s.slug ?? null,
      group: id === 'general' ? 'general' : 'set', provisional: false,
      members: (s.members ?? []).map((m) => ({ serverId: m.server, team: false, enabled: m.enabled === true && !m.pending, values: m.values ?? {} })),
      skills: (Array.isArray(s.skills) ? s.skills : []).map((k) => ({ skillId: k.skill, team: false, consent: null, enabled: k.enabled === true && !k.pending })) };
  };
  const teamSet = (home, team) => () => {
    const rec = teamRec(home);
    const state = own(store.teams, home);
    return { id: rec.id, name: rec.name, slug: rec.slug, group: 'team', provisional: !state,
      members: teamMembers(home, team.required, store.catalog, state?.members).map(({ serverId, state: st }) => ({
        serverId, team: true, consent: st.consent ?? null, enabled: st.enabled === true && !st.pending, values: st.values ?? {} })),
      skills: teamSkillMembers(home, team.requiredSkills, store.catalog, state?.skills).map(({ skillId, state: st }) => ({
        skillId, team: true, consent: st.consent, enabled: st.enabled === true && !st.pending })) };
  };
  const ownSets = (key) => {
    const a = own(store.projects, key) ?? {};
    return [...(a.includeGeneral !== false ? ['general'] : []), ...(Array.isArray(a.sets) ? a.sets : [])].filter((id) => own(store.sets, id));
  };
  if (ask) bring('general', userSet('general'), { rank: 0 }, []);   // D12: always, and nobody's
  for (const t of [...targets].sort(byKeys((x) => x.rank ?? 0, (x) => x.kind, (x) => x.key ?? x.id, (x) => x.route ?? ''))) {
    const projects = t.kind === 'workspace' ? (t.members ?? []).map((m) => m.key) : [t.key];
    for (const p of projects) for (const id of ownSets(p)) if (!(ask && id === 'general')) bring(id, userSet(id), t, [p]);
    const team = own(teams, t.kind === 'workspace' ? `ws:${t.id}` : t.key);
    if (requires(team)) bring(teamRec(team.home).id, teamSet(team.home, team), t, projects);
  }
  return sets;
}

/**
 * The Claude Code plugin name a set's skills load under (skills registry §4.1): the set's persisted slug — `general` for
 * General, which has none — or, when a Claude Code plugin of that name is installed on this host (`takenPluginNames`),
 * `<slug>-set`, then `<slug>-set-2` and so on, so a set never replaces a user's plugin for a spawn. One rule for every surface:
 * a set's prefix is the same in pipelines, Ask and previews on one host.
 * @returns {{ pluginName: string, renamed: boolean }}
 */
export function pluginNameFor(set, takenPluginNames = []) {
  const base = typeof set?.slug === 'string' && set.slug ? set.slug : 'general';
  const taken = new Set(takenPluginNames);
  if (!taken.has(base)) return { pluginName: base, renamed: false };
  for (let n = 1; ; n++) {
    const pluginName = n === 1 ? `${base}-set` : `${base}-set-${n}`;
    if (!taken.has(pluginName)) return { pluginName, renamed: true };
  }
}
