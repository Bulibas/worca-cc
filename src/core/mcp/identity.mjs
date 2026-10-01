// src/core/mcp/identity.mjs
// MCP registry names (registry design §4.2, §4.4). Pure. Base names and set slugs never hold `_`,
// so a copy name `<base>_<slug>` has exactly one `_` and can equal neither a base nor another copy.

import { SERVER_NAME_RE, sha256Hex } from './definitions.mjs';

const hex4 = (s) => sha256Hex(s).slice(0, 4);
/** §4.2 normalization: lower-cased, every run of [^a-z0-9] → one `-`, trimmed. */
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const lastSegment = (s) => s.slice(s.lastIndexOf('/') + 1);

/**
 * Base names for the ids in `ids` that have none in `bases` (§4.4 steps 1–3), taken manual → plugin →
 * policy, each by id ascending, each checked against `bases` plus the names assigned before it.
 * @returns {Record<string,string>} only the new entries
 */
export function assignBaseNames(bases, ids) {
  const held = new Set(Object.values(bases));
  const out = Object.create(null);
  const src = (id) => id.slice(0, id.indexOf(':'));
  // 'manual:' < 'plugin:' < 'policy:', so one ascending sort is the arrival order.
  const todo = [...new Set(ids)].filter((id) => !Object.hasOwn(bases, id)).sort();
  for (const id of todo) {
    const rest = id.slice(id.indexOf(':') + 1);
    const owner = rest.includes('/') ? rest.slice(0, rest.lastIndexOf('/')) : '';
    const name = lastSegment(rest);
    const alt = src(id) === 'plugin' ? `${owner}-${name}` : src(id) === 'policy' ? `${norm(lastSegment(owner))}-${name}` : null;
    let base = !held.has(name) ? name : alt && SERVER_NAME_RE.test(alt) && !held.has(alt) ? alt : null;
    for (let n = 0; !base; n++) {
      const c = `${name.slice(0, 15)}-${hex4(n ? `${id}\0${n}` : id)}`;
      if (!held.has(c)) base = c;
    }
    held.add(base);
    out[id] = base;
  }
  return out;
}

/** A new user set's id (§4.2): never `general`, never `team-…`, never taken or retired. */
export function newSetId(name, { taken = [], retired = [] } = {}) {
  let base = norm(name);
  // `team` itself too, not only `team-…`: its `-2` suffix would be a Team set id (isTeamId, store.mjs).
  if (!/^[a-z]/.test(base) || base === 'general' || /^team(-|$)/.test(base)) base = `s-${base}`;
  base = base.slice(0, 32);
  const used = new Set([...taken, ...retired, 'general']);
  for (let n = 1; ; n++) {
    const sfx = n === 1 ? '' : `-${n}`;
    const id = base.slice(0, 32 - sfx.length) + sfx;
    if (!used.has(id)) return id;
  }
}

/**
 * A set's slug (§4.4), persisted at creation. `source` = the set id (user sets) or
 * `team-<last home segment, normalized>` (Team sets); `takenSlugs` = every other set's persisted slug.
 */
export function slugFor({ setId, source }, takenSlugs = []) {
  const taken = new Set(takenSlugs);
  const s1 = source.slice(0, 12).replace(/-+$/, '');
  if (s1 !== 'w' && !taken.has(s1)) return s1;
  for (let n = 0; ; n++) {
    const s = `${source.slice(0, 7)}-${hex4(n ? `${setId}\0${n}` : setId)}`;
    if (!taken.has(s)) return s;
  }
}

/** A policy home's Team set (§4.2): id, slug and name. */
export function teamRecord(homeSlug, { takenSlugs = [] } = {}) {
  const id = `team-${norm(homeSlug).slice(0, 22)}-${hex4(homeSlug)}`;
  const slug = slugFor({ setId: id, source: norm(`team-${lastSegment(homeSlug)}`) }, takenSlugs);
  return { id, slug, name: `Team · ${homeSlug}`.slice(0, 40) };
}

/**
 * Records for the `homes` lacking one in `teams` (§4.4: what assignBases persists and readers show as
 * provisional), in ascending home order, each slug taken before the next. `takenSlugs` = every persisted slug.
 * @returns {Record<string,{id,slug,name}>} only the new records
 */
export function teamRecordsFor(teams, homes, takenSlugs) {
  const out = Object.create(null);
  const taken = [...takenSlugs];
  for (const h of [...new Set(homes)].sort()) {
    if (Object.hasOwn(teams, h)) continue;
    out[h] = teamRecord(h, { takenSlugs: taken });
    taken.push(out[h].slug);
  }
  return out;
}

/** D15: General's copy keeps the base; every other set's copy is `<base>_<slug>`. */
export function copyName(base, slug) {
  return slug == null ? base : `${base}_${slug}`;
}

/** The env name carrying one secret of one copy (§4.4): computed from the copy name before any rename. */
export function secretEnvName(copy, key) {
  return `MCPSECRET_${sha256Hex(`${copy}\0${key}`).slice(0, 8).toUpperCase()}`;
}
