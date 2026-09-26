// src/core/workspace-map/detectors/index.mjs
// The detector registry, in run order. One block per plan, alphabetical inside a block:
// P1 (this plan), then P3 (manifests / deploy / config / specs), then P4 (code).

import identity from './identity.mjs';
import pkgNpm from './pkg-npm.mjs';

export const DETECTORS = Object.freeze([
  // P1
  identity,
  pkgNpm,
]);

/** → the registered Detector with this id, or null */
export function detectorById(id) {
  return DETECTORS.find((d) => d.id === id) || null;
}
