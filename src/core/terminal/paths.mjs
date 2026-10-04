// src/core/terminal/paths.mjs — the terminal's places under the worca home (issue #573). Kept apart
// from manager.mjs so checkout.mjs can read the pid file without importing the terminal graph.
import { join } from 'node:path';

/** Live shells of this server: [{ pid, ownerPid, sessionId, instanceId? }] (instanceId `term:<runId>:<id>`). */
export const terminalPidFile = (home) => join(home, 'terminal', 'live.json');
/** Where the zsh rc files are copied (zsh needs `.zshrc` / `.zshenv` in $ZDOTDIR). */
export const zshDotDir = (home) => join(home, 'terminal', 'zsh');
/** Worca-owned worktrees for project branches: <root>/<projectKey>/<slug>-<sha6>. */
export const branchWorktreeRoot = (home) => join(home, 'terminal', 'worktrees');
