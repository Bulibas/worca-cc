// src/core/win-command.mjs
// What a bare command name or a path reaches on a Windows PATH (MCP registry §5.4), modelled on
// preflight.mjs' private probeWindowsClaude: PATH × PATHEXT, `.exe`/`.com` before the others for a
// bare name. `.exe`/`.com` spawn directly; a `.cmd`/`.bat` shim runs through cmd.exe (the MCP
// launcher's --win-shim); `.ps1` is reported so the caller can refuse it. Pure: `isFile` is injected.
import { win32 } from 'node:path';
import { statSync } from 'node:fs';

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
/** Characters cmd.exe re-parses inside `cmd /s /c "…"`: an argument holding one is refused, never quoted. */
export const WIN_CMD_METACHAR_RE = /[&|<>^%"!]/;

const kindOf = (p) => (/\.(exe|com)$/i.test(p) ? 'exe' : /\.(cmd|bat)$/i.test(p) ? 'shim' : /\.ps1$/i.test(p) ? 'ps1' : null);
const isFileOnDisk = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

/**
 * @param {string} bin  a bare name (`npx`), a name with its extension, or a path
 * @param {{ pathEnv?: string, pathext?: string, isFile?: (p: string) => boolean }} o
 * @returns {{ path: string, kind: 'exe'|'shim'|'ps1' } | null}
 */
export function resolveWindowsCommand(bin, { pathEnv = '', pathext = DEFAULT_PATHEXT, isFile = isFileOnDisk } = {}) {
  const exts = String(pathext || DEFAULT_PATHEXT).split(';').filter(Boolean);
  // `.exe`/`.com`, then `.cmd`/`.bat`: a `.PS1` in PATHEXT never shadows a shim in a later directory (the pass below).
  const ordered = [...exts.filter((e) => kindOf(e) === 'exe'), ...exts.filter((e) => kindOf(e) === 'shim')];
  const dirs = String(pathEnv).split(';').map((d) => d.replace(/^"(.*)"$/, '$1')).filter(Boolean);   // an entry may be quoted
  const stems = /[\\/]/.test(bin) ? [bin] : dirs.map((d) => win32.join(d, bin));
  for (const stem of stems) {
    for (const ext of kindOf(bin) ? [''] : ordered) {
      const p = stem + ext;
      const kind = kindOf(p);
      if (kind && isFile(p)) return { path: p, kind };
    }
  }
  // Nothing PATHEXT reaches: a PowerShell-only command is reported as one (skip `win-shim-unsupported`, not "not found").
  if (!kindOf(bin)) for (const stem of stems) if (isFile(`${stem}.ps1`)) return { path: `${stem}.ps1`, kind: 'ps1' };
  return null;
}
