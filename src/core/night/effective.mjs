// src/core/night/effective.mjs
// The I/O entry point for night mode config, used by the harness and the server:
// reads the project prefs (sqlite), the user settings file and the cached team policy.
// Nothing low-level imports this module (config.mjs stays the zero-import leaf).
import { readNightModePrefs } from '../config.mjs';
import { nightModeSettings } from '../settings.mjs';
import { teamDefault } from '../policy/cache.mjs';
import { projectKey } from '../store.mjs';
import { resolveNightConfig, teamNightLayer } from './config.mjs';

function projectLayer(projectDir) {
  try { return projectDir ? readNightModePrefs(projectKey(projectDir)) : null; } catch { return null; }
}

function userLayer() {
  try { return nightModeSettings(); } catch { return null; }
}

/** Synchronous (settings file + sqlite + cached policy): safe to call at every arm. Never throws. */
export function effectiveNightConfig(projectDir) {
  let team = {};
  try { team = projectDir ? teamNightLayer((k) => teamDefault(projectDir, k)) : {}; } catch { team = {}; }
  return resolveNightConfig({ project: projectLayer(projectDir), user: userLayer(), team });
}

/** Project + user layers only (the policy "local" snapshot must not include the team layer). */
export function effectiveNightConfigLocalOnly(projectDir) {
  return resolveNightConfig({ project: projectLayer(projectDir), user: userLayer() });
}
