// src/core/folder-dialog.mjs
// Server-side native OS "choose folder" dialog. A browser <input type=file>
// cannot reveal absolute directory paths, so the add-project Browse button asks
// the server (which runs on the user's own machine; worca-cc is localhost-only)
// to open the platform dialog and report the chosen path.
//
//   darwin -> osascript `choose folder` (the System Events activate line keeps
//             the dialog frontmost; on first use macOS may show a one-time
//             Automation consent prompt — a denial surfaces as a non-cancel
//             error and degrades to `unsupported`, i.e. the in-app fallback)
//   win32  -> PowerShell System.Windows.Forms.FolderBrowserDialog (-STA)
//   linux  -> zenity --file-selection --directory, falling back to kdialog;
//             requires DISPLAY/WAYLAND_DISPLAY (headless -> unsupported)
//   `multiple` -> multi-select on darwin and zenity (newline-separated paths);
//             win32 and kdialog stay single-select and answer a one-element list
//
// Any failure that is not a recognized user-cancel degrades to
// { status: 'unsupported' } so the web UI can fall back to its in-app folder
// browser. WORCA_NO_NATIVE_DIALOG=1 forces that fallback. Like git-info.mjs,
// every command goes through an injectable runner (_testing) so tests never
// open a real dialog. Nothing here ever throws.

import { spawn } from 'node:child_process';

// The dialog title, by PURPOSE. A closed set, never caller text: the string is
// interpolated into an osascript / PowerShell command line.
const PROMPTS = Object.freeze({
  project: 'Select a project folder',
  export: 'Select the project folder to export into',
  plugin: 'Select the plugin folder',
});
const promptFor = (purpose) => PROMPTS[purpose] || PROMPTS.project;
// A dialog waits on a human; give it a long leash, then kill the process so a
// forgotten dialog cannot pin server resources forever.
const DIALOG_TIMEOUT_MS = 5 * 60 * 1000;

/** Default runner: spawn cmd, resolve { ok, stdout, stderr, code, timedOut }. */
function defaultRun(cmd, args, { timeout = DIALOG_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, stdout: '', stderr: err.message, code: -1, timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      done({ ok: false, stdout, stderr: 'dialog timed out', code: -1, timedOut: true });
    }, timeout);
    child.stdout?.on('data', (b) => (stdout += b.toString()));
    child.stderr?.on('data', (b) => (stderr += b.toString()));
    child.on('error', (err) => done({ ok: false, stdout, stderr: stderr || err.message, code: -1, timedOut: false }));
    child.on('close', (code) => done({ ok: code === 0, stdout, stderr, code: code ?? -1, timedOut: false }));
  });
}

const _ov = { runner: null, platform: null, env: null };
let _inFlight = false;

export const _testing = {
  set({ runner = _ov.runner, platform = _ov.platform, env = _ov.env } = {}) {
    _ov.runner = runner;
    _ov.platform = platform;
    _ov.env = env;
  },
  reset() {
    _ov.runner = null;
    _ov.platform = null;
    _ov.env = null;
    _inFlight = false;
  },
};

/**
 * Open the platform's native folder picker and wait for the user.
 * Serialized: while one dialog is open, further calls resolve { status:'busy' }.
 * `multiple` asks for a multi-select dialog where the platform has one (macOS
 * `choose folder … with multiple selections allowed`, zenity --multiple);
 * Windows' FolderBrowserDialog and kdialog stay single-select. With `multiple`
 * a pick answers { status:'picked', path: <first>, paths: [...] }; without it the
 * reply keeps its historical { status:'picked', path } shape.
 * @param {{purpose?: 'project'|'export'|'plugin', multiple?: boolean}} [opts]
 * @returns {Promise<{status:'picked', path:string, paths?:string[]} | {status:'canceled'}
 *   | {status:'unsupported'} | {status:'busy'}>}
 */
export async function pickFolderNative({ purpose, multiple = false } = {}) {
  if (_inFlight) return { status: 'busy' };
  _inFlight = true;
  try {
    const platform = _ov.platform || process.platform;
    const env = _ov.env || process.env;
    const run = _ov.runner || defaultRun;
    const prompt = promptFor(purpose);
    const multi = multiple === true;
    if ((env.WORCA_NO_NATIVE_DIALOG || '') === '1') return { status: 'unsupported' };
    let r = { status: 'unsupported' };
    if (platform === 'darwin') r = await pickMac(run, prompt, multi);
    else if (platform === 'win32') r = await pickWindows(run, prompt);
    else if (platform === 'linux') r = await pickLinux(run, env, prompt, multi);
    if (r.status !== 'picked') return r;
    return multi ? { status: 'picked', path: r.paths[0], paths: r.paths } : { status: 'picked', path: r.paths[0] };
  } finally {
    _inFlight = false;
  }
}

// One path per stdout line (a multi-select dialog prints several): trimmed, a
// trailing slash dropped (a bare "/" kept), blanks skipped, duplicates collapsed.
function parsePicked(stdoutRaw) {
  const paths = [];
  for (const line of String(stdoutRaw || '').split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw) continue;
    const path = raw === '/' ? raw : raw.replace(/\/+$/, '');
    if (!paths.includes(path)) paths.push(path);
  }
  return paths.length ? { status: 'picked', paths } : { status: 'canceled' };
}

async function pickMac(run, prompt, multiple) {
  // `choose folder … with multiple selections allowed` returns a LIST of aliases;
  // POSIX path must be taken per item, one per line.
  const pick = multiple
    ? [
        '-e', `set picked to (choose folder with prompt "${prompt}" with multiple selections allowed)`,
        '-e', 'set out to ""',
        '-e', 'repeat with f in picked',
        '-e', 'set out to out & (POSIX path of f) & linefeed',
        '-e', 'end repeat',
        '-e', 'return out',
      ]
    : ['-e', `POSIX path of (choose folder with prompt "${prompt}")`];
  const r = await run('osascript', ['-e', 'tell application "System Events" to activate', ...pick]);
  if (r.ok) return parsePicked(r.stdout);
  // `choose folder` cancel: exit 1 + "execution error: User canceled. (-128)"
  if (/-128|User cancell?ed/i.test(r.stderr || '')) return { status: 'canceled' };
  return { status: 'unsupported' }; // no GUI session, automation denied, ...
}

async function pickWindows(run, prompt) {
  // FolderBrowserDialog has no multi-select: a `multiple` caller gets a one-element list.
  const script =
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null; ' +
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog; ' +
    `$d.Description = '${prompt}'; $d.ShowNewFolderButton = $true; ` +
    "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.WriteLine($d.SelectedPath) }";
  const r = await run('powershell.exe', ['-NoProfile', '-STA', '-Command', script]);
  if (!r.ok) return { status: 'unsupported' };
  // OK exit either way; empty stdout means the user canceled.
  const path = r.stdout.trim();
  return path ? { status: 'picked', paths: [path] } : { status: 'canceled' };
}

async function pickLinux(run, env, prompt, multiple) {
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return { status: 'unsupported' };
  const zenArgs = ['--file-selection', '--directory', `--title=${prompt}`];
  if (multiple) zenArgs.push('--multiple', '--separator=\n');
  const zen = await run('zenity', zenArgs);
  if (zen.ok) return parsePicked(zen.stdout);
  if (zen.code === 1 && !zen.timedOut) return { status: 'canceled' }; // user closed it
  // zenity missing (spawn error -> code -1) or broken: try kdialog (single-select only).
  const kd = await run('kdialog', ['--title', prompt, '--getexistingdirectory', env.HOME || '/']);
  if (kd.ok) return parsePicked(kd.stdout);
  if (kd.code === 1 && !kd.timedOut) return { status: 'canceled' };
  return { status: 'unsupported' };
}
