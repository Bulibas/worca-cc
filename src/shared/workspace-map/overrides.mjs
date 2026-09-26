// src/shared/workspace-map/overrides.mjs
// Human review of a map (spec §5.9 as amended by the plan index): confirm / reject an edge by
// its stable id, add / remove manual edges. Overrides live apart from the map, so a re-scan
// replaces the map and the overrides still apply — the edge id hashes (from, to, kind, norm),
// never a file or line. Every function returns a NEW doc; the input is never mutated.

import { MAP_VERSION } from './limits.mjs';
import { KINDS, checkOverrides } from './schema.mjs';
import { manualEdgeId } from './ids.mjs';

const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const clean = (overrides) => checkOverrides(overrides ?? emptyOverrides()).value;
/** A map value shown as text: a corrupt map_json may hold an object there (`{"toString": null}`),
 *  whose String() throws. */
const text = (v) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

export function emptyOverrides() {
  return { version: MAP_VERSION, edges: {}, manual: [] };
}

/** A manual edge is a person's assertion: no scan measured it, so its confidence is null. A
 *  missing edge was confirmed by a person on an earlier scan: 'verified'. */
const synthetic = (o, state, extra) => ({
  id: o.id, from: o.from, to: o.to, kind: o.kind, norm: null, display: o.display, label: null,
  detail: o.detail ?? '', confidence: state === 'manual' ? null : 'verified', sources: [state === 'manual' ? 'manual' : 'override'],
  evidence: { from: [], to: [] }, ...extra, state,
});

/** map.edges merged with overrides. Each returned edge = the map edge (or manual/missing
 *  synthetic edge) + { state }. auto: no override; confirmed/rejected: override on a present
 *  edge; manual: overrides.manual (synthetic edge, confidence null, no evidence); missing: a
 *  CONFIRMED override whose id is absent from map.edges (synthetic edge from the snapshot,
 *  confidence 'verified', no evidence). A REJECTED override whose id is absent is ignored.
 *  Synthetic edges carry norm: null. Sorted by from, to, kind, display. map may be null. */
export function effectiveEdges(map, overrides) {
  const ov = clean(overrides);
  const edges = Array.isArray(map?.edges)
    ? map.edges.filter((e) => e && typeof e.id === 'string' && typeof e.from === 'string' && typeof e.to === 'string' && typeof e.kind === 'string')
    : [];
  const present = new Set(edges.map((e) => e.id));
  const out = edges.map((e) => ({ ...e, state: Object.hasOwn(ov.edges, e.id) ? ov.edges[e.id].state : 'auto' }));
  for (const [id, o] of Object.entries(ov.edges)) {
    if (o.state === 'confirmed' && !present.has(id)) out.push(synthetic({ id, ...o }, 'missing', { at: o.at }));
  }
  for (const m of ov.manual) out.push(synthetic(m, 'manual', { createdAt: m.createdAt }));
  return out.sort((a, b) => byStr(a.from, b.from) || byStr(a.to, b.to) || byStr(a.kind, b.kind)
    || byStr(text(a.display), text(b.display)) || byStr(a.id, b.id));
}

/** state: 'confirmed'|'rejected'|null → new doc (null clears). `edge` needs id, from, to, kind,
 *  display (the snapshot; display clipped to 300 chars so the stored doc stays valid). Throws only
 *  on a programmer error (bad state or no edge id). */
export function setEdgeState(overrides, edge, state, at) {
  // C4: only a scanned edge (x_…) carries a state — any other id would be stored, then dropped by
  // the next clean() (and '__proto__' would re-parent the edges object).
  if (!edge || typeof edge.id !== 'string' || !/^x_[0-9a-f]{12}$/.test(edge.id)) throw new TypeError('setEdgeState: edge.id must be an x_ edge id');
  if (state !== null && state !== 'confirmed' && state !== 'rejected') throw new TypeError(`setEdgeState: bad state ${state}`);
  const next = clean(overrides);
  if (state === null) delete next.edges[edge.id];
  else next.edges[edge.id] = { state, from: edge.from, to: edge.to, kind: edge.kind, display: text(edge.display).slice(0, 300), at: String(at) };
  return next;
}

/** → { overrides, edge } — or { overrides (unchanged copy), edge: null, error } when the input
 *  is not a valid manual edge (so an API route can answer 400 without a try/catch). */
export function addManualEdge(overrides, input, at) {
  const { from, to, kind, display, detail: rawDetail } = input && typeof input === 'object' ? input : {};
  const detail = rawDetail ?? ''; // a JSON body's `"detail": null` means no detail, like an absent one
  const next = clean(overrides);
  const d = typeof display === 'string' ? display.trim() : '';
  let error = null;
  // The same rules checkOverrides applies on every later read: an edge it would drop is refused here.
  if (typeof from !== 'string' || !from.trim() || typeof to !== 'string' || !to.trim()) error = 'from and to must be member keys';
  else if (from === to) error = 'from and to must differ';
  else if (!KINDS.includes(kind)) error = `kind must be one of ${KINDS.join(', ')}`;
  else if (!d || d.length > 300) error = 'display must be 1-300 chars';
  else if (typeof detail !== 'string' || detail.length > 200) error = 'detail must be at most 200 chars';
  if (error) return { overrides: next, edge: null, error };
  const createdAt = String(at);
  const id = manualEdgeId(from, to, kind, d, createdAt);
  const existing = next.manual.find((m) => m.id === id);
  if (existing) return { overrides: next, edge: existing };
  const edge = { id, from, to, kind, display: d, detail, createdAt };
  next.manual.push(edge);
  return { overrides: next, edge };
}

/** → new doc (unknown id → unchanged copy) */
export function removeManualEdge(overrides, id) {
  const next = clean(overrides);
  next.manual = next.manual.filter((m) => m.id !== id);
  return next;
}
