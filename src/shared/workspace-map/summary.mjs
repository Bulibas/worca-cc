// src/shared/workspace-map/summary.mjs
// The small digest the workspace list carries instead of the whole map (spec D16).

import { effectiveEdges } from './overrides.mjs';

/** → null when map is null; else { scannedAt, members, edges, gaps, confirmed, rejected, manual,
 *  missing, byKind: {kind: n} } where edges counts effective non-rejected, non-missing edges and
 *  gaps counts members whose coverage.level is 'none' or whose usageStatus is 'failed'. */
export function mapSummary(map, overrides) {
  if (!map || typeof map !== 'object') return null;
  const members = Array.isArray(map.members) ? map.members : [];
  const eff = effectiveEdges(map, overrides);
  const count = (state) => eff.filter((e) => e.state === state).length;
  const live = eff.filter((e) => e.state !== 'rejected' && e.state !== 'missing');
  const kinds = new Map();
  for (const e of live) kinds.set(e.kind, (kinds.get(e.kind) || 0) + 1);
  return {
    scannedAt: typeof map.scannedAt === 'string' ? map.scannedAt : null,
    members: members.length,
    edges: live.length,
    gaps: members.filter((m) => m?.coverage?.level === 'none' || m?.coverage?.usageStatus === 'failed').length,
    confirmed: count('confirmed'),
    rejected: count('rejected'),
    manual: count('manual'),
    missing: count('missing'),
    byKind: Object.fromEntries(kinds),
  };
}
