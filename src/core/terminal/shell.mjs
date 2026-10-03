// src/core/terminal/shell.mjs — which shell a terminal runs and how it starts (issue #573). bash and
// zsh load worca's rc snippets (rc/), which print the command markers markers.mjs reads; any other
// shell runs plain: a working terminal with no command blocks.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'rc');
export const BASH_RC = join(RC_DIR, 'worca.bash');

export const shellKind = (file) => {
  const b = basename(String(file || ''));
  return b === 'bash' || b === 'zsh' ? b : 'other';
};

/** The server user's $SHELL, else bash, else sh. Windows: ComSpec (cmd.exe). */
export function pickShell({ env = process.env, platform = process.platform, exists = existsSync } = {}) {
  if (platform === 'win32') return { file: env.ComSpec || 'cmd.exe', kind: 'other', platform };
  const file = [env.SHELL, '/bin/bash', '/usr/bin/bash', '/bin/sh']
    .find((f) => typeof f === 'string' && f.startsWith('/') && exists(f)) || '/bin/sh';
  return { file, kind: shellKind(file), platform };
}

/**
 * argv and env additions that start `shell` interactively, with worca's markers when it can. `nonce`
 * (D12) reaches the rc snippets as WORCA_TERMINAL_NONCE; they unset it before anything else runs.
 */
export function shellLaunch(shell, { env = process.env, zshDir = null, nonce = null } = {}) {
  const mark = nonce ? { WORCA_TERMINAL_NONCE: nonce } : {};
  if (shell.kind === 'bash') return { args: ['--rcfile', BASH_RC, '-i'], env: { BASH_SILENCE_DEPRECATION_WARNING: '1', ...mark } };
  if (shell.kind === 'zsh' && zshDir) {
    return { args: ['-i'], env: { ZDOTDIR: zshDir, WORCA_USER_ZDOTDIR: env.ZDOTDIR || env.HOME || '', ...mark } };
  }
  return { args: shell.platform === 'win32' ? [] : ['-i'], env: {} };
}

/** Copy the zsh rc files into `dir` under the names zsh reads; a no-op when they are current. */
export function ensureZshDir(dir) {
  mkdirSync(dir, { recursive: true });
  for (const [src, dest] of [['zshenv.zsh', '.zshenv'], ['zshrc.zsh', '.zshrc']]) {
    const want = readFileSync(join(RC_DIR, src), 'utf8');
    const at = join(dir, dest);
    let have = null;
    try { have = readFileSync(at, 'utf8'); } catch { /* first use */ }
    if (have !== want) writeFileSync(at, want);
  }
  return dir;
}
