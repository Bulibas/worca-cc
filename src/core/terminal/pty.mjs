// src/core/terminal/pty.mjs — start a shell under a pseudo-terminal (node-pty, an optional native
// dependency) or, where node-pty is missing, over plain pipes (issue #573). Both return the same small
// handle. Over pipes there is no tty: commands, markers and Stop work; full-screen programs do not.
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const OFF = /^(0|false|no|off)$/i;
let cached = null;

/**
 * node-pty 1.1.0's npm tarball ships `prebuilds/darwin-*\/spawn-helper` as mode 0644, and every
 * pty.spawn then throws "posix_spawnp failed." (D14). Set the exec bit where it is missing. Returns
 * null when the helper is usable (or absent), else why it is not.
 */
export function ensureSpawnHelper(pkgDir, { platform = process.platform, arch = process.arch } = {}) {
  for (const rel of [join('prebuilds', `${platform}-${arch}`, 'spawn-helper'), join('build', 'Release', 'spawn-helper')]) {
    const file = join(pkgDir, rel);
    let st;
    try { st = statSync(file); } catch { continue; }                 // not shipped for this platform
    if ((st.mode & 0o111) === 0o111) continue;
    try { chmodSync(file, st.mode | 0o755); } catch (e) {
      return `node-pty's spawn-helper is not executable and could not be fixed (${e?.code || e?.message || e})`;
    }
  }
  return null;
}

/** node-pty, or null with the reason it is unavailable. WORCA_TERMINAL_PTY=0 forces pipes. */
export function loadPty(env = process.env) {
  if (OFF.test(String(env.WORCA_TERMINAL_PTY || '').trim())) return { pty: null, reason: 'turned off with WORCA_TERMINAL_PTY=0' };
  if (cached) return cached;
  try {
    const pty = require('node-pty');
    const problem = process.platform === 'win32' ? null : ensureSpawnHelper(dirname(require.resolve('node-pty/package.json')));
    cached = problem ? { pty: null, reason: problem } : { pty, reason: null };
  } catch (e) {
    cached = { pty: null, reason: `node-pty is not installed on this server (${String(e?.code || e?.message || e).slice(0, 120)})` };
  }
  return cached;
}
export function _resetPtyForTests() { cached = null; }

/** Shells still running, killed synchronously if the host exits without a graceful close. */
const live = new Set();
process.on('exit', () => {
  for (const h of live) { try { killDescendants(h.pid); } catch { /* best effort */ } h.signal('SIGKILL'); }
});

/** Throws only when node-pty itself cannot spawn; TerminalManager then falls back to pipes (D14). */
export function spawnTerminal({ file, args = [], cwd, env, cols = 100, rows = 30, platform = process.platform, pty = loadPty().pty }) {
  const h = pty ? viaPty(pty, { file, args, cwd, env, cols, rows, platform }) : viaPipes({ file, args, cwd, env, platform });
  if (h.pid) live.add(h);
  h.onExit(() => live.delete(h));
  return h;
}

function groupSignal(pid, sig, platform, fallback) {
  if (platform !== 'win32' && pid) { try { process.kill(-pid, sig); return; } catch { /* not a group leader */ } }
  try { fallback(sig); } catch { /* gone */ }
}

function viaPty(pty, { file, args, cwd, env, cols, rows, platform }) {
  const p = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env });
  return {
    pid: p.pid,
    mode: 'pty',
    write: (s) => { try { p.write(s); } catch { /* exited */ } },
    resize: (c, r) => { try { p.resize(c, r); } catch { /* exited */ } },
    signal: (sig) => groupSignal(p.pid, sig, platform, (s) => p.kill(platform === 'win32' ? undefined : s)),
    onData: (cb) => { p.onData((d) => cb(String(d))); },
    onExit: (cb) => { p.onExit(({ exitCode, signal }) => cb({ exitCode: exitCode ?? null, signal: signal || null })); },
  };
}

function viaPipes({ file, args, cwd, env, platform }) {
  const child = spawn(file, args, {
    cwd, env,
    detached: platform !== 'win32',          // own process group: SIGINT/SIGHUP reach the shell and its jobs
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdin?.on('error', () => { /* the shell went away mid-write */ });
  const exitCbs = [];
  let ended = false;
  const end = (e) => { if (ended) return; ended = true; for (const cb of exitCbs) cb(e); };
  child.once('error', () => end({ exitCode: -1, signal: null }));          // ENOENT, EACCES: no shell started
  child.once('close', (code, sig) => end({ exitCode: code ?? null, signal: sig || null }));
  return {
    pid: child.pid,
    mode: 'pipes',
    write: (s) => { if (child.stdin?.writable) child.stdin.write(String(s).replace(/\r\n?/g, '\n')); },
    resize: () => {},
    signal: (sig) => groupSignal(child.pid, sig, platform, (s) => child.kill(s)),
    onData: (cb) => { child.stdout?.on('data', cb); child.stderr?.on('data', cb); },
    onExit: (cb) => { exitCbs.push(cb); },
  };
}

/** [[pid, ppid], …] of every process (POSIX ps). */
function psRows() {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout.split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter((a) => a.length === 2 && a.every(Number.isFinite));
}

/** Every descendant of `pid`, deepest first (a job-control job lives in its own group, so kill(-pid) misses it). */
export function descendantPids(pid, rows = psRows) {
  const kids = new Map();
  for (const [p, pp] of rows()) { if (!kids.has(pp)) kids.set(pp, []); kids.get(pp).push(p); }
  const out = [];
  const walk = (p) => { for (const c of kids.get(p) || []) { walk(c); out.push(c); } };
  walk(pid);
  return out;
}

/** Send `sig` to each pid (POSIX only). Returns how many were signalled. */
export function signalPids(pids, sig, platform = process.platform) {
  if (platform === 'win32') return 0;
  let n = 0;
  for (const p of pids) { try { process.kill(p, sig); n++; } catch { /* already gone */ } }
  return n;
}

/** Send `sig` to every descendant of `pid` (not `pid` itself). Returns how many were signalled. */
export function signalDescendants(pid, sig, platform = process.platform, rows = psRows) {
  if (!pid || platform === 'win32') return 0;
  return signalPids(descendantPids(pid, rows), sig, platform);
}

/** SIGKILL every descendant of `pid` (not `pid` itself). Returns how many were signalled. */
export const killDescendants = (pid, platform = process.platform, rows = psRows) => signalDescendants(pid, 'SIGKILL', platform, rows);

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}
