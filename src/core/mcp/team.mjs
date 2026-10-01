// src/core/mcp/team.mjs
// The Team set (MCP registry spec §11.2, §11.3): what each `mcp.required` entry of a cached policy
// is on this machine (the checklist state), the consent hash, seeded values, and the only writers
// of Team consent — Install, Turn on, Update, Forget. Pure core (teamRows, consentHash, seedValues)
// + the actions, like registry.mjs. Nothing here touches git or the network or listens to policy events; the Ask turn
// path only reads (teamRows, through policyPayload).
import { canonicalJson, sha256Hex } from './definitions.mjs';
import { teamRecord, assignBaseNames } from './identity.mjs';
import { teamMembers, requiredOf, skipReasonText } from './registry.mjs';
import { resolveSet } from './views.mjs';
import { readMcpStore, setTeamState, putPolicyServer, forgetTeamState, migrateServerFields, McpStoreError } from './store.mjs';
import { loadCatalog } from './catalog.mjs';
import { cachedPolicyHomes, unreadablePolicyHomes } from '../policy/cache.mjs';
import { mcpListComplete } from '../policy/registry.mjs';

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
 *  never while that doc carries an `mcp.required` warning (an entry this build drops is still listed). */
async function forgetUnlisted(home, cached, snap) {
  if (!mcpListComplete(cached.warnings)) return;
  const listed = new Set(requiredOf(cached.doc).map((e) => serverIdOf(home, e)));
  const gone = Object.keys(own(snap.teams, home)?.members ?? {}).filter((id) => !listed.has(id));
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
 * Forget (§11.2). No cached doc for `home` (no project here follows it), or one that requires no MCP server: the Team
 * set is greyed, and its Team state, secrets and tests all go with its record, so the set leaves the list. While the
 * doc still requires servers, Forget is a Team action like the others: only the entries it no longer lists go. A policy
 * this build cannot fully read (a newer schema, an entry it drops) removes nothing: 409.
 */
export async function teamForget(home) {
  const cached = cachedPolicyHomes().find((h) => h.slug === home);
  if (cached ? !mcpListComplete(cached.warnings) : unreadablePolicyHomes().has(home)) {
    throw new McpStoreError(409, `this Worca cannot read every MCP server the policy of ${home} lists — nothing was removed`);
  }
  if (!cached || !requiredOf(cached.doc).length) return forgetTeamState(home);
  return forgetUnlisted(home, cached, await readMcpStore());
}
