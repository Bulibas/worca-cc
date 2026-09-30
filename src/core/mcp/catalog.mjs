// src/core/mcp/catalog.mjs
// The MCP catalog (MCP registry spec §4.1, §4.4, §4.6): every installed server —
// the honoured `mcpServers` of every installed plugin (disabled ones included,
// flagged pluginEnabled:false), manual definitions and consented policy copies —
// each with its base name. Reads the plugin lock and manifests directly (no
// agent-registry scan), so the resolver can call it on every spawn. Only
// reconcileMcpStore writes, and only through the store.

import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeManifest } from '../plugin-manifest.mjs';
import { readPluginsLock, pluginCurrentDir } from '../plugins-lock.mjs';
import { readMcpStore, assignBases } from './store.mjs';
import { assignBaseNames } from './identity.mjs';
import { validateMcpDefinition } from './definitions.mjs';

/** Plugin entries: `dir` = realpath(<plugin>/current) — versions/<sha7> for an
 *  install, the working dir for a linked plugin — which `./` paths resolve against. */
function pluginEntries() {
  const lock = readPluginsLock();
  const out = [];
  for (const plugin of Object.keys(lock)) {
    const e = lock[plugin] || {};
    let dir = null;
    let manifest = null;
    try {
      dir = realpathSync(pluginCurrentDir(plugin));
      const res = normalizeManifest(JSON.parse(readFileSync(join(dir, 'worca-cc-plugin.json'), 'utf8')), { dir });
      manifest = res.ok ? res.manifest : null;
    } catch { /* dangling current or unreadable manifest: a broken plugin serves nothing */ }
    if (!manifest) continue;
    const code = e.linked === true ? 'linked' : typeof e.pinnedSha === 'string' ? e.pinnedSha.slice(0, 7) : null;
    for (const [name, def] of Object.entries(manifest.mcpServers)) {
      out.push({ id: `plugin:${plugin}/${name}`, source: 'plugin', plugin, name, def, dir, code, pluginEnabled: e.enabled !== false });
    }
  }
  return out;
}

/**
 * @param {object} [snapshot]  readMcpStore() result; read when omitted
 * @returns {Promise<object[]>} CatalogEntry[] sorted by id; [] for a newer store
 */
export async function loadCatalog(snapshot) {
  const snap = snapshot ?? await readMcpStore();
  if (snap.newer) return [];
  const entries = pluginEntries();
  // The files are hand-editable: a definition that no longer passes §4.1 is left
  // out (its memberships skip missing-server), so the resolver only sees normalized ones.
  for (const name of Object.keys(snap.manual)) {
    const { def } = validateMcpDefinition(snap.manual[name], { name, source: 'manual' });
    if (def) entries.push({ id: `manual:${name}`, source: 'manual', name, def, dir: null, code: null, pluginEnabled: true });
  }
  for (const key of Object.keys(snap.policy)) {
    const i = key.lastIndexOf('/');
    if (i < 1) continue;   // a hand-edited key without `<home>/` names no policy server
    const { def } = validateMcpDefinition(snap.policy[key]?.def, { name: key.slice(i + 1), source: 'policy' });
    if (def) entries.push({ id: `policy:${key}`, source: 'policy', home: key.slice(0, i), name: key.slice(i + 1), def, dir: null, code: null, pluginEnabled: true });
  }
  // An id without a persisted base is named for reads only (§4.4 "provisional").
  const provisional = assignBaseNames(snap.bases, entries.map((e) => e.id));
  for (const e of entries) {
    e.provisional = !Object.hasOwn(snap.bases, e.id);
    e.base = e.provisional ? provisional[e.id] : snap.bases[e.id];
  }
  return entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Persist a base for every catalog id that lacks one. A plugin can become
 *  honoured with no install event (a host API bump, a linked plugin's edit), so
 *  this runs at server start and at the start of every `worca plugin` command. */
export async function reconcileMcpStore() {
  const missing = (await loadCatalog()).filter((e) => e.provisional).map((e) => e.id);
  if (missing.length) await assignBases(missing);
}
