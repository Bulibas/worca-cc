// src/core/mcp/plugin-lifecycle.mjs
// What a plugin lifecycle event does to the MCP store (MCP registry spec §4.4,
// §4.6): install/link/update name the plugin's servers, an update migrates or
// removes them, uninstall removes their memberships everywhere, plus the
// queries the uninstall confirm and the update preview need. plugin-store.mjs
// calls these; the hooks that run after an install/link/update landed only warn.
// The skills a plugin ships (skills registry spec §5): an update names the new,
// removed and changed ones and removes the dropped ones from every set; an
// uninstall removes all of them. Never automatic: the preview is the consent.

import { lstatSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readMcpStore, withMcpLock, assignBases, removeServerEverywhere, migrateServerFields, removeSkillEverywhere, mcpDir, McpStoreError } from './store.mjs';
import { canonicalJson } from './definitions.mjs';
import { inspectSkillDir, isValidSkillFolderName } from '../skills-registry/inspect.mjs';

/** Every membership of the servers `match` selects — user sets' members and Team
 *  sets' local state — as { setId, name, server, values }. */
function membershipsOf(snap, match) {
  const out = [];
  for (const [setId, set] of Object.entries(snap.sets)) {
    for (const m of set.members) if (match(m.server)) out.push({ setId, name: set.name, server: m.server, values: m.values || {} });
  }
  for (const t of Object.values(snap.teams)) {
    for (const [server, m] of Object.entries(t.members)) if (match(server)) out.push({ setId: t.id, name: t.name, server, values: m.values || {} });
  }
  return out;
}

/**
 * MCP store footprint of the servers `match` selects: every server id with a
 * membership or Team state, and the names of the sets (user and Team) holding
 * one. Secrets and tests need no arm of their own: one without a membership or
 * Team state is an orphan, which readMcpStore() leaves out and the next locked
 * write sweeps from disk.
 * @param {object} snap  readMcpStore() result
 * @param {(serverId: string) => boolean} match
 * @returns {{ids: string[], sets: string[]}}
 */
export function mcpFootprint(snap, match) {
  const ms = membershipsOf(snap, match);
  return { ids: [...new Set(ms.map((m) => m.server))].sort(), sets: [...new Set(ms.map((m) => m.name))].sort() };
}

/** Persist base names for a plugin's honoured servers (§4.4). The install, link
 *  or update already landed, so a store failure only warns: the next reconcile
 *  or locked write names them. */
export async function assignPluginBases(plugin, mcpServers) {
  const ids = Object.keys(mcpServers).map((n) => `plugin:${plugin}/${n}`);
  if (!ids.length) return;
  try { await assignBases(ids); } catch (err) {
    console.warn(`[plugin-store] ${plugin}: MCP server names not saved (${err?.message || err}) — the next reconcile retries`);
  }
}

/** Pre-flight for an uninstall, and for an update that removes or migrates
 *  servers (§4.6). Their MCP writes come after the plugin's own destructive step
 *  (removePluginWorkflows, the uninstall's last guard, deletes the templates; an
 *  update swaps the version), so a registry file those writes could not write
 *  must refuse BEFORE it: a strict locked read throws its 409 ("… is damaged —
 *  fix it or remove it"). Decided from the TEXT of sets.json, never from
 *  readMcpStore(): the lenient read turns a damaged sets.json into an empty one
 *  and hides the very memberships the removal must reach. Only a sets.json that
 *  names `plugin:<plugin>`, or holds a JSON escape that could spell it, can hold
 *  a membership or Team state for it; otherwise the removal writes nothing, so a
 *  damaged registry never blocks another plugin's uninstall. A sets.json that
 *  exists but cannot be read (a dangling symlink) refuses too: the strict load
 *  would read it as absent. A newer store is never written (its rows stay, like
 *  every newer file). */
export async function checkMcpStoreWritable(plugin) {
  const file = join(mcpDir(), 'sets.json');
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (err) {
    if (err?.code === 'ENOENT' && !lstatSync(file, { throwIfNoEntry: false })) return;   // no memberships anywhere
    throw new McpStoreError(409, `MCP registry file mcp/sets.json cannot be read (${err?.code || err}) — fix it or remove it`);
  }
  if (!text.includes(`plugin:${plugin}`) && !text.includes('\\')) return;
  if ((await readMcpStore()).newer) return;
  await withMcpLock(async () => {});
}

/** Uninstall (§4.6): the plugin's memberships in every set, Team state, their
 *  secrets and tests — every `plugin:<name>/` id the store holds, honoured now
 *  or not. Bases stay reserved, so a later same-named plugin starts with no
 *  memberships and no saved token follows it. */
export async function removePluginServers(plugin) {
  const prefix = `plugin:${plugin}/`;
  for (const id of mcpFootprint(await readMcpStore(), (id) => id.startsWith(prefix)).ids) {
    await removeServerEverywhere(id);
  }
}

/** What a red line compares (§4.6): how the server starts or connects, and each
 *  field's default, secret and required. The field set counts too: a field added
 *  or removed changes what every set must fill in (and a new required one gets
 *  its own line below). A label, a description or the oauth flag is not one. */
const redKey = (d) => canonicalJson({
  // The validator leaves an absent args/env/headers absent: absent and empty start the server alike.
  type: d.type, start: [d.command ?? null, d.args ?? [], d.url ?? null, d.headers ?? {}, d.env ?? {}],
  fields: [...d.fields].sort((a, b) => (a.key < b.key ? -1 : 1)).map((f) => [f.key, f.default ?? null, f.secret, f.required]),
});

/** Name delta between two honoured blocks, each read under its own side's
 *  negotiated API (normalizeManifest strips a block below 5, so a candidate that
 *  drops below 5 shows every server as removed). */
export function mcpServerDelta(pin, cand) {
  return {
    newMcpServers: Object.keys(cand).filter((n) => !Object.hasOwn(pin, n)).sort(),
    removedMcpServers: Object.keys(pin).filter((n) => !Object.hasOwn(cand, n)).sort(),
    changedMcpServers: Object.keys(cand).filter((n) => Object.hasOwn(pin, n) && redKey(pin[n]) !== redKey(cand[n])).sort(),
  };
}

/**
 * The update preview's MCP lines, in order new → removed → changed (§4.6): a
 * changed server is a red line naming the sets holding secrets for it and the
 * sets that follow a changed default; a new required field without a default
 * names the sets it leaves skipped.
 * @returns {Array<{red: boolean, text: string}>}
 */
function mcpUpdateLines(plugin, pin, cand, delta, snap) {
  const id = (n) => `plugin:${plugin}/${n}`;
  const names = (ms) => ms.map((m) => m.name).sort().join(', ');
  const secretsOf = (setId, sid) => (Object.hasOwn(snap.secrets, setId) && Object.hasOwn(snap.secrets[setId], sid)
    ? snap.secrets[setId][sid] : {});
  const lines = delta.newMcpServers.map((n) => ({ red: false, text: `new MCP server: ${n}` }));
  for (const n of delta.removedMcpServers) {
    const ms = membershipsOf(snap, (x) => x === id(n));
    lines.push(ms.length
      ? { red: true, text: `MCP SERVER REMOVED: ${n} — leaves ${names(ms)} with its values, secrets and test results` }
      : { red: false, text: `removed MCP server: ${n}` });
  }
  for (const n of delta.changedMcpServers) {
    const ms = membershipsOf(snap, (x) => x === id(n));
    const old = Object.fromEntries(pin[n].fields.map((f) => [f.key, f]));
    const moved = cand[n].fields.filter((f) => !f.secret && Object.hasOwn(old, f.key)
      && (old[f.key].default ?? null) !== (f.default ?? null)).map((f) => f.key);
    const holders = ms.filter((m) => Object.keys(secretsOf(m.setId, id(n))).length);
    const followers = ms.filter((m) => moved.some((k) => !Object.hasOwn(m.values, k)));
    lines.push({ red: true, text: `MCP SERVER CHANGED: ${n}`
      + (holders.length ? ` — secrets held in ${names(holders)}` : '')
      + (followers.length ? ` — follows the new default in ${names(followers)}` : '') });
    for (const f of cand[n].fields) {
      if (!f.required || f.default !== undefined) continue;
      const o = Object.hasOwn(old, f.key) && old[f.key].secret === f.secret ? old[f.key] : null;
      if (o && o.required && o.default === undefined) continue;             // required before, too
      const kept = (m) => !!o && Object.hasOwn(f.secret ? secretsOf(m.setId, id(n)) : m.values, f.key);
      const skipped = ms.filter((m) => !kept(m));
      if (skipped.length) lines.push({ red: true, text: `${n}: new required field ${f.label} — skipped in ${names(skipped)} until filled` });
    }
  }
  return lines;
}

/** Every skill membership `match` selects — user sets' `skills` and Team sets' skill state — as { name, skill }. */
function skillMembershipsOf(snap, match) {
  const out = [];
  for (const set of Object.values(snap.sets)) for (const m of set.skills ?? []) if (match(m.skill)) out.push({ name: set.name, skill: m.skill });
  for (const t of Object.values(snap.teams)) for (const id of Object.keys(t.skills ?? {})) if (match(id)) out.push({ name: t.name, skill: id });
  return out;
}

/**
 * The skills twin of mcpFootprint: every skill id `match` selects that a set or Team state holds, and the names of
 * the sets (user and Team) holding one — what an uninstall removes and its confirm names.
 * @returns {{ids: string[], sets: string[]}}
 */
export function skillFootprint(snap, match) {
  const ms = skillMembershipsOf(snap, match);
  return { ids: [...new Set(ms.map((m) => m.skill))].sort(), sets: [...new Set(ms.map((m) => m.name))].sort() };
}

/** The skills a plugin version dir ships: name → folder, for every skills/<name>/SKILL.md (the catalog's rule) whose
 *  folder name is a valid skill name (P1's rule, the reserved names included) — any other folder can never be a set
 *  member, and its raw name (control characters included) must never reach a preview line or the terminal. */
function shippedSkills(versionDir) {
  const out = new Map();
  const dir = join(versionDir, 'skills');
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return out; }   // no skills/ folder (or not a folder): none
  for (const d of ents) {
    if (!isValidSkillFolderName(d.name)) continue;
    if (d.isDirectory() && existsSync(join(dir, d.name, 'SKILL.md'))) out.set(d.name, join(dir, d.name));
  }
  return out;
}

/**
 * Skill delta between two plugin version dirs (the pinned one and the candidate): names new, removed and changed
 * (a different content hash — bytes, the file set, the exec bits — or a skill that starts or stops loading), and per
 * changed skill the number of scripts the candidate adds.
 * @returns {{newSkills:string[], removedSkills:string[], changedSkills:string[], addedScripts:Record<string,number>}}
 */
export function skillDelta(pinDir, candDir) {
  const pin = shippedSkills(pinDir);
  const cand = shippedSkills(candDir);
  const changedSkills = [];
  const addedScripts = {};
  for (const [n, dir] of cand) {
    if (!pin.has(n)) continue;
    const a = inspectSkillDir(pin.get(n), { name: n });
    const b = inspectSkillDir(dir, { name: n });
    // The hash covers the files the walk records. A `.claude-plugin/` folder or a link the inspection refuses records
    // none, yet it makes the catalog list the skill as invalid (never mounted): a change in what loads, so it is named.
    if (a.hash === b.hash && (a.problems.length === 0) === (b.problems.length === 0)) continue;
    changedSkills.push(n);
    const more = b.scripts.filter((x) => !a.scripts.includes(x)).length;
    if (more) addedScripts[n] = more;
  }
  return {
    newSkills: [...cand.keys()].filter((n) => !pin.has(n)).sort(),
    removedSkills: [...pin.keys()].filter((n) => !cand.has(n)).sort(),
    changedSkills: changedSkills.sort(),
    addedScripts,
  };
}

/**
 * The update preview's skill lines, in order new → removed → changed (§5): a removed or changed skill a set holds is a
 * red line naming those sets ("+N scripts" when the change adds scripts); one no set holds is a plain line.
 * @returns {Array<{red: boolean, text: string}>}
 */
export function skillUpdateLines(plugin, delta, snap) {
  const sets = (n) => skillFootprint(snap, (x) => x === `skill:plugin:${plugin}/${n}`).sets.join(', ');
  const plus = (n) => { const k = Object.hasOwn(delta.addedScripts ?? {}, n) ? delta.addedScripts[n] : 0; return k ? ` (+${k} script${k === 1 ? '' : 's'})` : ''; };
  const lines = delta.newSkills.map((n) => ({ red: false, text: `new skill: ${n}` }));
  for (const n of delta.removedSkills) {
    const held = sets(n);
    lines.push(held ? { red: true, text: `SKILL REMOVED: ${n} — leaves ${held}` } : { red: false, text: `removed skill: ${n}` });
  }
  for (const n of delta.changedSkills) {
    const held = sets(n);
    lines.push(held ? { red: true, text: `SKILL CHANGED: ${n} — in ${held}${plus(n)}` } : { red: false, text: `changed skill: ${n}${plus(n)}` });
  }
  return lines;
}

/** Uninstall (§5): every `skill:plugin:<name>/` membership and Team state the store holds. */
export async function removePluginSkills(plugin) {
  const prefix = `skill:plugin:${plugin}/`;
  for (const id of skillFootprint(await readMcpStore(), (id) => id.startsWith(prefix)).ids) await removeSkillEverywhere(id);
}

/** The update preview's MCP part: the name delta plus its lines; with the two version dirs, the skill delta and its
 *  lines too (skills registry spec §5). */
export async function mcpUpdatePreview(plugin, pin, cand, { pinDir = null, candDir = null } = {}) {
  const delta = mcpServerDelta(pin, cand);
  const snap = await readMcpStore();
  const skills = pinDir && candDir ? skillDelta(pinDir, candDir) : { newSkills: [], removedSkills: [], changedSkills: [], addedScripts: {} };
  return {
    ...delta, mcpLines: mcpUpdateLines(plugin, pin, cand, delta, snap),
    newSkills: skills.newSkills, removedSkills: skills.removedSkills, changedSkills: skills.changedSkills,
    skillLines: skillUpdateLines(plugin, skills, snap),
  };
}

/** Apply (§4.6): a removed server is handled like an uninstall, a changed one
 *  runs the field migration, new ones get their base; each of `removedSkills`
 *  (the names the update's own preview listed as removed) leaves every set (a
 *  changed skill stays: its copy is mounted fresh on the next spawn). Warn-only:
 *  the update already landed, and the resolver skips what a failure leaves behind. */
export async function applyMcpUpdate(plugin, pin, cand, { removedSkills = [] } = {}) {
  const delta = mcpServerDelta(pin, cand);
  try {
    for (const n of delta.removedMcpServers) await removeServerEverywhere(`plugin:${plugin}/${n}`);
    for (const n of delta.changedMcpServers) await migrateServerFields(`plugin:${plugin}/${n}`, pin[n], cand[n]);
  } catch (err) {
    console.warn(`[plugin-store] ${plugin}: MCP registry not updated (${err?.message || err})`);
  }
  // Skills (skills registry §5): the skills the preview named as removed leave every set — exactly those, never a delta
  // recomputed from the version dirs (a rolled-back `current` or a setup step would make it differ from what the user
  // saw). Its own warn-only step, so an MCP failure never skips it and its failure is named for what it is.
  if (removedSkills.length) {
    try {
      const held = new Set(skillFootprint(await readMcpStore(), (id) => id.startsWith(`skill:plugin:${plugin}/`)).ids);
      for (const n of removedSkills) if (held.has(`skill:plugin:${plugin}/${n}`)) await removeSkillEverywhere(`skill:plugin:${plugin}/${n}`);
    } catch (err) {
      console.warn(`[plugin-store] ${plugin}: skills not removed from sets (${err?.message || err})`);
    }
  }
  await assignPluginBases(plugin, cand);
}
