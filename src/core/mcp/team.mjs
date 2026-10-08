// src/core/mcp/team.mjs
// The Team set (MCP registry spec §11.2, §11.3): what each `mcp.required` entry of a cached policy
// is on this machine (the checklist state), the consent hash, seeded values, and the only writers
// of Team consent — Install, Turn on, Update, Forget. Pure core (teamRows, consentHash, seedValues)
// + the actions, like registry.mjs. Nothing here touches git or the network or listens to policy events; the Ask turn
// path only reads (teamRows, through policyPayload).
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, sha256Hex } from './definitions.mjs';
import { teamRecord, assignBaseNames } from './identity.mjs';
import { teamMembers, requiredOf, requiredSkillsOf, skipReasonText } from './registry.mjs';
import { teamSkillMembers } from './sets.mjs';
import { resolveSet } from './views.mjs';
import { readMcpStore, setTeamState, putPolicyServer, forgetTeamState, migrateServerFields, setTeamSkillState, McpStoreError } from './store.mjs';
import { loadCatalog } from './catalog.mjs';
import { cachedPolicyHomes, unreadablePolicyHomes } from '../policy/cache.mjs';
import { mcpListComplete, skillsListComplete } from '../policy/registry.mjs';
import { skillIdOf, SKILL_ID_RE } from '../skills-registry/ids.mjs';
import { loadSkillCatalog } from '../skills-registry/catalog.mjs';
import { SKILL_LIMITS } from '../skills-registry/inspect.mjs';
import { skillSkipReasonText } from '../skills-registry/texts.mjs';

/** A user-keyed lookup (homes, server ids, plugin names): own keys only. */
const own = (m, k) => (m != null && Object.hasOwn(m, k) ? m[k] : undefined);

/** sha256 of canonical { entry, values }: `entry` = the inline definition or { plugin, server }. */
export function consentHash(entry, values) { return sha256Hex(canonicalJson({ entry, values })); }

/** The definition part of a normalised inline entry (no name, no values). */
const defOf = ({ name, values, ...def }) => def;   // eslint-disable-line no-unused-vars
/** The consent hash of one normalised `mcp.required` entry (taken after the §11.1 normalizer). */
export function entryHash(e) {
  return consentHash(e.plugin ? { plugin: e.plugin, server: e.server } : defOf(e), e.values ?? {});
}

export function serverIdOf(home, e) { return e.plugin ? `plugin:${e.plugin}/${e.server}` : `policy:${home}/${e.name}`; }

/** §11.2: a value absent or still equal to its seed takes the policy value; the seed always does. */
export function seedValues(state, policyValues) {
  const values = { ...state.values }; const seeded = { ...state.seeded };
  for (const [k, v] of Object.entries(policyValues)) {
    if (!Object.hasOwn(values, k) || (Object.hasOwn(seeded, k) && values[k] === seeded[k])) values[k] = v;
    seeded[k] = v;
  }
  return { values, seeded };
}

/**
 * One checklist row per `mcp.required` entry of one cached home (§11.3), in the policy's order.
 * state: 'not-installed' | 'needs-plugin' | 'never-consented' | 'changed' | 'off' | 'skipped' | 'ok'
 * (the first that applies); `working` = a spawn starts it (P6's resolveSet: the resolver on this Team set)
 * — what the effective table's "Yours" lists. `def`/`values` are what consent covers now; `before` the
 * consented copy and its last seeds ('changed'); `running` the entry as it runs here.
 * @param {{slug:string, sha:string|null, doc:object}} home
 * @param {{catalog:object[], snapshot:object, pluginStates:Record<string,string>}} io  plus P3 hostContext()'s facts (env, platform, …)
 */
export function teamRows({ slug, sha, doc }, { catalog, snapshot, pluginStates, ...host }) {
  const required = requiredOf(doc);
  const rec = own(snapshot.teams, slug) ?? teamRecord(slug, { takenSlugs: [] });
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const members = new Map(teamMembers(slug, required, catalog, rec.members ?? {}).map((m) => [m.serverId, m.state]));
  // What a spawn does with each member (§5.7), so the checklist and "Yours" never disagree with a run.
  const res = resolveSet({ ...host, snapshot, catalog, setId: rec.id, team: { home: slug, required } });
  const bases = { ...snapshot.bases };
  for (const c of catalog) if (!Object.hasOwn(bases, c.id)) bases[c.id] = c.base;
  return required.map((e) => {
    const serverId = serverIdOf(slug, e);
    const hit = byId.get(serverId) ?? null;
    const st = members.get(serverId) ?? null;
    const hash = entryHash(e);
    const pluginOk = !e.plugin || own(pluginStates, e.plugin) === 'ok';
    const skip = res.skipped.find((x) => x.serverId === serverId) ?? null;
    const missing = skip?.reason.startsWith('missing:') ? hit.def.fields.find((f) => f.key === skip.reason.slice(8)) ?? null : null;
    let state;
    if (!hit) state = e.plugin ? 'needs-plugin' : 'not-installed';
    else if (!pluginOk) state = 'needs-plugin';
    else if (!st.consent) state = 'never-consented';
    else if (st.consent !== hash) state = 'changed';
    else if (!st.enabled) state = 'off';
    else if (skip) state = 'skipped';
    else state = 'ok';
    const def = e.plugin ? hit?.def ?? null : defOf(e);
    return {
      home: slug, sha, setId: rec.id, setName: rec.name, serverId, name: e.plugin ? e.server : e.name, plugin: e.plugin ?? null,
      type: def?.type ?? null, state, working: res.copies.some((c) => c.serverId === serverId), hash,
      field: missing ? missing.label : null, problem: state === 'skipped' ? skipReasonText(skip, catalog) : null, base: hit ? hit.base : assignBaseNames(bases, [serverId])[serverId],
      def, values: e.values ?? {},
      before: state === 'changed' ? { def: hit.def, values: st.seeded } : null,
      running: e.plugin ? { plugin: e.plugin, server: e.server } : hit ? { name: e.name, ...hit.def } : null,
    };
  });
}

/** §11.2: in a Team action on a present cached doc, the Team state of the entries it no longer lists goes —
 *  never while that doc carries an `mcp.required` warning (an entry this build drops is still listed); the same
 *  for required skills and their `skills.required` warnings (skills registry spec §5). */
async function forgetUnlisted(home, cached, snap) {
  const team = own(snap.teams, home);
  const gone = [];
  if (mcpListComplete(cached.warnings)) {
    const listed = new Set(requiredOf(cached.doc).map((e) => serverIdOf(home, e)));
    gone.push(...Object.keys(team?.members ?? {}).filter((id) => !listed.has(id)));
  }
  if (skillsListComplete(cached.warnings)) {
    const listed = new Set(requiredSkillsOf(cached.doc).map(skillIdOfEntry));
    gone.push(...Object.keys(team?.skills ?? {}).filter((id) => !listed.has(id)));
  }
  if (gone.length) await forgetTeamState(home, gone);
}

/**
 * Install / Turn on / Update one Team member (§11.3). The definition, values and hash come from the
 * CACHED policy, never the caller; `expectHash` is the hash the consent dialog showed (409 when the
 * cache moved on). Seeds the policy values, records consent, re-tests in the background.
 * @param {'install'|'turn-on'|'update'} action
 * @returns {Promise<{setId:string, serverId:string}>}
 */
export async function teamAction(action, home, serverId, { expectHash }) {
  const cached = cachedPolicyHomes().find((h) => h.slug === home);
  if (!cached) throw new McpStoreError(404, `no project here follows ${home}`);
  const required = requiredOf(cached.doc);
  const snap = await readMcpStore();
  await forgetUnlisted(home, cached, snap);   // §11.2: this is a Team action on a present doc
  const entry = required.find((e) => serverIdOf(home, e) === serverId);
  if (!entry) throw new McpStoreError(404, `${serverId} is not required by ${home}`);
  const hash = entryHash(entry);
  if (expectHash !== hash) throw new McpStoreError(409, 'the team definition changed, review it again');
  const hit = (await loadCatalog(snap)).find((c) => c.id === serverId);
  const st = own(own(snap.teams, home)?.members, serverId) ?? null;
  if (action === 'install' && (entry.plugin || hit)) throw new McpStoreError(409, entry.plugin ? `${entry.server} comes with plugin ${entry.plugin}` : `${entry.name} is already installed`);
  if (action !== 'install' && !hit) throw new McpStoreError(409, `${serverId} is not installed`);
  if (action === 'turn-on' && st?.consent && st.consent !== hash) throw new McpStoreError(409, 'the team definition changed — Update it first');
  if (action === 'update' && !(st?.consent && st.consent !== hash)) throw new McpStoreError(409, 'nothing to update');
  let replaced = false;   // an older consented copy gave way to this one
  if (!entry.plugin) {
    // The consented copy (§4.1 Policy): replaced only by what this consent covers; §4.6 migration when it changes.
    const key = `${home}/${entry.name}`;
    const stored = own(snap.policy, key);
    if (stored?.hash !== hash) {
      await putPolicyServer(key, { def: defOf(entry), hash });
      if (stored) { await migrateServerFields(serverId, stored.def, defOf(entry)); replaced = true; }
    }
  }
  const cur = own(own((await readMcpStore()).teams, home)?.members, serverId) ?? { enabled: false, values: {}, seeded: {}, consent: null };
  // A plugin reference's values meet its fields only here: secret or unknown keys never seed (§11.1 non-secret values).
  const nonSecret = new Set((entry.plugin ? hit.def : defOf(entry)).fields.filter((f) => !f.secret).map((f) => f.key));
  const seeds = Object.fromEntries(Object.entries(entry.values ?? {}).filter(([k]) => nonSecret.has(k)));
  await setTeamState(home, serverId, { ...seedValues(cur, seeds), consent: hash, ...(action === 'update' ? {} : { enabled: true }) });
  const setId = (own(snap.teams, home) ?? teamRecord(home, { takenSlugs: [] })).id;
  // §7.3 background Test, loaded on use (the Test runner pulls in the MCP SDK; this module's readers, policy/local.mjs,
  // never need it). Install and Turn on switch the Team member on and test it. A new definition (an Update, or a Turn on
  // that replaced an older consented copy: an entry listed again after its Team state went) re-tests every switched-on
  // membership of the server (user sets too); a switched-off one starts nothing. Update keeps the switch.
  const t = await import('./test.mjs');
  if (action === 'update' || replaced) void t.retestServers((id) => id === serverId);
  else t.retestInBackground([`${setId}|${serverId}`]);
  return { setId, serverId };
}

/**
 * Forget (§11.2). No cached doc for `home` (no project here follows it), or one that requires no MCP server and no
 * skill: the Team set is greyed, and its Team state, secrets and tests all go with its record, so the set leaves the
 * list. While the doc still requires servers or skills, Forget is a Team action like the others: only the entries it no
 * longer lists go. A policy this build cannot fully read (a newer schema, an entry it drops) removes nothing: 409.
 */
export async function teamForget(home) {
  const cached = cachedPolicyHomes().find((h) => h.slug === home);
  if (cached ? !mcpListComplete(cached.warnings) : unreadablePolicyHomes().has(home)) {
    throw new McpStoreError(409, `this Worca cannot read every MCP server the policy of ${home} lists — nothing was removed`);
  }
  if (cached && !skillsListComplete(cached.warnings)) {
    throw new McpStoreError(409, `this Worca cannot read every skill the policy of ${home} lists — nothing was removed`);
  }
  if (!cached || (!requiredOf(cached.doc).length && !requiredSkillsOf(cached.doc).length)) return forgetTeamState(home);
  return forgetUnlisted(home, cached, await readMcpStore());
}

// ── Required skills (skills registry spec §5, §7, F8) ─────────────────────────────────────────────────────────────
// `skills.required` lists plugin skills ({ plugin, skill }); each developer turns each one on with consent and it joins
// the home's Team set. Consent covers the reference only: content changes reach the Team set through the plugin's
// own update consent, so there is no Update — Turn on and Forget are the only actions.

/** sha256 of canonical { plugin, skill } (§2b-10). */
export function skillConsentHash({ plugin, skill }) { return sha256Hex(canonicalJson({ plugin, skill })); }

/** A Team skill id: a plugin skill, the only kind `skills.required` lists. */
export function isTeamSkillId(id) { return typeof id === 'string' && SKILL_ID_RE.test(id) && id.startsWith('skill:plugin:'); }

const skillIdOfEntry = (e) => skillIdOf({ source: 'plugin', plugin: e.plugin, name: e.skill });

/**
 * One checklist row per `skills.required` entry of one cached home, in the policy's order (§6 board 10).
 * state: 'needs-plugin' | 'never-consented' | 'off' | 'skipped' | 'ok' (the first that applies; 'skipped' also when the
 * plugin is ok but ships no skill of that name); `working` = the Team set mounts it on a spawn here, as the resolver
 * decides — what the effective table's "Yours" lists. `code` (sha7 or 'linked'), files, scripts and
 * shell blocks are the catalog's facts the row and the consent dialog show.
 * @param {{slug:string, sha:string|null, doc:object}} home
 * @param {{catalog:object[], snapshot:object, pluginStates:Record<string,string>}} io  catalog = loadSkillCatalog()
 */
export function teamSkillRows({ slug, sha, doc }, { catalog, snapshot, pluginStates }) {
  const required = requiredSkillsOf(doc);
  const rec = own(snapshot.teams, slug) ?? teamRecord(slug, { takenSlugs: [] });
  const byId = new Map(catalog.map((c) => [c.id, c]));
  // The Team set's skills as the resolver derives them (P2 sets.mjs): in the catalog, one per name, with their state.
  const members = new Map(teamSkillMembers(slug, required, catalog, rec.skills ?? {}).map((m) => [m.skillId, m.state]));
  return required.map((e) => {
    const skillId = skillIdOfEntry(e);
    const hit = byId.get(skillId) ?? null;
    const st = members.get(skillId) ?? null;
    const hash = skillConsentHash(e);
    const consented = st?.consent === hash;
    const on = consented && st.enabled === true && !st.pending;
    let state; let problem = null;
    // The resolver's order (missing, invalid, then consent, then off): a skill that can never mount is never offered Turn on.
    if (own(pluginStates, e.plugin) !== 'ok') state = 'needs-plugin';
    else if (!hit) { state = 'skipped'; problem = `${e.plugin} does not ship a skill named ${e.skill}`; }
    else if (!hit.valid) {
      state = 'skipped';
      problem = skillSkipReasonText({ setId: rec.id, setName: rec.name, skillId, name: e.skill, reason: 'invalid-skill' });
    } else if (!consented) state = 'never-consented';
    else if (!on) state = 'off';
    else state = 'ok';
    // `working` is what the resolver does, not the checklist's state: it mounts a consented, on, valid skill of an enabled
    // plugin whatever the policy's version floor says (the floor is the plugin row's action).
    const working = !!hit && hit.pluginEnabled !== false && hit.valid === true && on;
    return {
      home: slug, sha, setId: rec.id, setName: rec.name, skillId, name: e.skill, plugin: e.plugin, state, working, hash, problem,
      code: hit?.code ?? null, files: hit?.files ?? 0, bytes: hit?.bytes ?? 0, scripts: hit?.scripts ?? [], shellBlocks: hit?.shellBlocks ?? 0,
      description: hit?.description ?? '',
    };
  });
}

/** The cached home and its `skills.required` entry for `skillId` (400 / 404). */
function cachedSkillEntry(home, skillId) {
  if (!isTeamSkillId(skillId)) throw new McpStoreError(400, 'skillId must be a plugin skill id');
  const cached = cachedPolicyHomes().find((h) => h.slug === home);
  if (!cached) throw new McpStoreError(404, `no project here follows ${home}`);
  return { cached, entry: requiredSkillsOf(cached.doc).find((e) => skillIdOfEntry(e) === skillId) ?? null };
}

/**
 * Turn on one required skill: records consent and switches the Team member on. The reference and the hash come from
 * the CACHED policy, never the caller; `expectHash` is the hash the consent dialog showed (409 when it moved on).
 * @param {'turn-on'} action
 * @returns {Promise<{setId:string, skillId:string}>}
 */
export async function teamSkillAction(action, home, skillId, { expectHash }) {
  if (action !== 'turn-on') throw new McpStoreError(400, `unknown Team skill action ${action}`);
  const { cached, entry } = cachedSkillEntry(home, skillId);
  const snap = await readMcpStore();
  await forgetUnlisted(home, cached, snap);   // §11.2: this is a Team action on a present doc
  if (!entry) throw new McpStoreError(404, `${skillId} is not required by ${home}`);
  const hash = skillConsentHash(entry);
  if (expectHash !== hash) throw new McpStoreError(409, 'the team definition changed, review it again');
  if (!(await loadSkillCatalog()).some((c) => c.id === skillId)) throw new McpStoreError(409, `${skillId} is not installed`);
  await setTeamSkillState(home, skillId, { consent: hash, enabled: true });
  return { setId: (own(snap.teams, home) ?? teamRecord(home, { takenSlugs: [] })).id, skillId };
}

/**
 * What the Turn on dialog shows (§6 board 10): the SKILL.md text, its scripts and shell blocks, allowed tools, the
 * plugin @ code, the home @ sha and the set it joins — read from the cached policy and the catalog, like the action.
 */
export async function teamSkillConsent(home, skillId) {
  const { cached, entry } = cachedSkillEntry(home, skillId);
  if (!entry) throw new McpStoreError(404, `${skillId} is not required by ${home}`);
  const hit = (await loadSkillCatalog()).find((c) => c.id === skillId);
  if (!hit) throw new McpStoreError(409, `${skillId} is not installed`);
  const rec = own((await readMcpStore()).teams, home) ?? teamRecord(home, { takenSlugs: [] });
  let skillMd = '';
  try {
    // P1's readSkillMd rule: a regular file within the limit, never read through a link — a SKILL.md linked out of the
    // plugin, to /dev/zero or to a FIFO would show another file or block the server (this read is synchronous).
    const file = join(hit.dir, 'SKILL.md');
    const st = lstatSync(file);
    if (st.isFile() && st.size <= SKILL_LIMITS.fileBytes) skillMd = readFileSync(file, 'utf8');
  } catch { /* removed since the catalog read: the facts still show */ }
  return {
    home, sha: cached.sha ?? null, setId: rec.id, setName: rec.name, skillId, name: entry.skill, plugin: entry.plugin,
    hash: skillConsentHash(entry), code: hit.code ?? null, description: hit.description ?? '', files: hit.files, bytes: hit.bytes,
    scripts: hit.scripts, shellBlocks: hit.shellBlocks, allowedTools: hit.frontmatter?.allowedTools ?? null,
    hooks: hit.frontmatter?.hooks === true, pluginRootRefs: hit.frontmatter?.pluginRootRefs === true, skillMd,
  };
}
