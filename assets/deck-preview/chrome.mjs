// assets/deck-preview/chrome.mjs
// The thin, impure half: find a Chrome and shoot one HTML file to one PNG. Every failure is
// SOFT — { ok: false, reason } — because a missing browser costs the form its pictures,
// never the run. Resolution order follows scripts/deck-pdf.py: WORCA_CHROME, then PATH
// names, then the macOS / Windows install paths.
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PATH_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
const MAC_APPS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

/** Every place a Chrome may live, in lookup order. Pure. */
export function chromeCandidates({ env = process.env, platform = process.platform } = {}) {
  const out = [];
  if (env.WORCA_CHROME) out.push(env.WORCA_CHROME);
  const exe = platform === 'win32' ? '.exe' : '';
  for (const dir of String(env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const name of PATH_NAMES) out.push(join(dir, name + exe));
  }
  if (platform === 'darwin') out.push(...MAC_APPS);
  if (platform === 'win32') {
    for (const base of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)) {
      out.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  }
  return out;
}

/** The first candidate that exists, or null. `exists` is injectable for tests. */
export function findChrome({ env = process.env, platform = process.platform, exists = existsSync } = {}) {
  return chromeCandidates({ env, platform }).find((p) => exists(p)) || null;
}

/** The argv for one screenshot. Pure. The recipe is worca-cc-deck-audit.md's. NO
 *  `--user-data-dir`: with a fresh profile, macOS Chrome writes the PNG and then never exits
 *  (measured: PNG in ~1 s, process alive until killed); headless=new already runs on its own
 *  throwaway profile, so an open desktop Chrome does not lock it out. */
export function screenshotArgs({ htmlPath, pngPath, width, height, noSandbox = false }) {
  return [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--force-device-scale-factor=1', '--virtual-time-budget=3000',
    `--window-size=${width},${height}`, `--screenshot=${pngPath}`,
    ...(noSandbox ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    pathToFileURL(htmlPath).href,
  ];
}

/** Shoot `htmlPath` into `pngPath`. → { ok: true } | { ok: false, reason }. Never throws.
 *  Success is judged by the FILE, not the exit: the PNG is deleted first, so a non-empty PNG
 *  afterwards is this run's, even when Chrome had to be killed at the timeout. */
export function screenshot(chrome, { htmlPath, pngPath, width, height }, {
  run = spawnSync, env = process.env, timeoutMs = 30000,
} = {}) {
  try {
    rmSync(pngPath, { force: true });
    const noSandbox = env.CHROME_NO_SANDBOX === '1' || (typeof process.getuid === 'function' && process.getuid() === 0);
    const r = run(chrome, screenshotArgs({ htmlPath, pngPath, width, height, noSandbox }), { stdio: 'ignore', timeout: timeoutMs });
    if (existsSync(pngPath) && statSync(pngPath).size > 0) return { ok: true };
    return { ok: false, reason: r && r.error ? r.error.message : `no PNG written (exit ${r ? r.status : '?'})` };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}
