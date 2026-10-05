// src/cli/logs.mjs
// `worca logs` — read a run's live log from the terminal (issue #531).
//
// The third leg of the terminal run workflow (#487 runs, #513 stop|pause):
// inspect what a run is doing live. Every run already persists a durable NDJSON
// log next to its artifacts (run-log.mjs, `live-log.ndjson`, buffered, ~1s
// flush) — the same records the web UI's log pane renders over its event
// stream. This module reads the FILE directly: reads work with no `worca ui`
// up, for runs owned by any process. Follow is a poll-and-append tail (~1s,
// matched to the writer's flush cadence; no fs.watch) — Ctrl-C detaches and
// the run keeps going; the loop also ends on its own when the run settles.

import { readFile, stat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { getDb } from '../core/db.mjs';
import { runDirForRow } from '../core/artifacts.mjs';
import { RUN_LOG_FILE } from '../core/run-log.mjs';
import { resolveRunRef } from './runs.mjs';

export const LOGS_HELP = `worca logs — read a run's live log

Usage:
  worca logs <id>                 Last 50 lines (any unique id prefix)
  worca logs <id> --tail 200      More history
  worca logs <id> -f              Follow — new lines as they land; Ctrl-C
                                  detaches and the run keeps going
  worca logs <id> --component <s> Only one log source (repeatable)
  worca logs <id> --level <l>     Minimum level: debug | info | warn | error
                                  (that level and above)
  worca logs <id> --json          Raw NDJSON lines, untouched

Reads come straight from the run's log file — no Worca server needs to be up.
`;

/** The severity ladder (index = rank): a record at or above the --level
 *  threshold passes. This is NOT the UI's exact-match filter — the UI has
 *  multi-select checkboxes, a single CLI flag cannot, and the terminal use
 *  case is "what went wrong". */
const LEVELS = ['debug', 'info', 'warn', 'error'];
/** The same level palette the foreground run uses (worca-cc.mjs LEVEL_COLOR). */
const LEVEL_COLOR = { info: 'reset', debug: 'gray', warn: 'yellow', error: 'red' };
/** Statuses after which a run writes nothing more, so following can end
 *  (run-report.mjs TERMINAL_STATUSES; 'paused' is parked, not settled). */
const SETTLED = ['done', 'error', 'stopped', 'interrupted'];

/**
 * Parse the logs verb's options. `--x v` and `--x=v` both land; unknown
 * options and valueless value-flags fail here, never silently pass (the
 * runs.mjs posture).
 */
function parseOptions(rest, fail) {
  const opts = { tail: 50, follow: false, json: false, sources: [], level: null };
  const refs = [];
  const take = (name, inline) => {
    if (inline !== undefined) return inline;
    const v = rest[++i];
    if (v === undefined || v.startsWith('-')) fail(`--${name} needs a value (see: worca logs help)`);
    return v;
  };
  let i = -1;
  while (++i < rest.length) {
    const a = rest[i];
    if (a === '--tail' || a.startsWith('--tail=')) {
      const n = Number(take('tail', a.startsWith('--tail=') ? a.slice(7) : undefined));
      if (!Number.isInteger(n) || n < 1 || n > 100_000) fail(`--tail must be a positive integer, got: ${n}`);
      opts.tail = n;
    } else if (a === '-f' || a === '--follow') {
      opts.follow = true;
    } else if (a === '--json') {
      opts.json = true;
    } else if (a === '--component' || a.startsWith('--component=')) {
      const v = take('component', a.startsWith('--component=') ? a.slice(12) : undefined);
      if (v) opts.sources.push(String(v).toLowerCase());
    } else if (a === '--level' || a.startsWith('--level=')) {
      const v = take('level', a.startsWith('--level=') ? a.slice(8) : undefined);
      if (!LEVELS.includes(String(v).toLowerCase())) fail(`--level must be one of ${LEVELS.join(', ')}, got: ${v}`);
      opts.level = String(v).toLowerCase(); // a threshold, not a category: last one wins
    } else if (a.startsWith('-')) {
      fail(`unknown option: ${a} — see: worca logs help`);
    } else {
      refs.push(a);
    }
  }
  if (!refs.length) fail('a run id is required (see: worca runs list)');
  if (refs.length > 1) fail('one run at a time (see: worca logs help)');
  opts.ref = refs[0];
  return opts;
}

/** Does one NDJSON line pass the --component filter and the --level threshold?
 *  Threshold, not exact: `--level warn` shows warn AND error. A record with no
 *  level counts as 'info' (the UI log filter's rule, log-filter.mjs); a level
 *  outside the ladder (e.g. the 'artifact' provenance records the writer
 *  emits) ranks below debug, so it only ever appears in unfiltered views.
 *  Unparseable lines pass only when no filter was given (they still render,
 *  raw). */
function passes(line, opts) {
  if (!opts.sources.length && opts.level == null) return true;
  let evt = null;
  try { evt = JSON.parse(line); } catch { return false; }
  if (!evt || typeof evt !== 'object') return false;
  if (opts.sources.length && !opts.sources.includes(String(evt.source || '').toLowerCase())) return false;
  if (opts.level != null && LEVELS.indexOf(String(evt.level || 'info').toLowerCase()) < LEVELS.indexOf(opts.level)) return false;
  return true;
}

/** One compact line per record, in the conventional log-layout order:
 *  timestamp, LEVEL (fixed width, right-aligned the way Rust's tracing
 *  formats levels — the level's last column lines up against the source),
 *  [source], text. Color is unified to ONE accent per line: the level token
 *  carries the severity color (warn yellow, error red, debug gray, info
 *  plain); the clock and [source] stay gray and the message stays plain, so
 *  long lines remain readable and the color always points at the severity.
 *  EVERY line carries its level (this is an explicit log command, not the
 *  foreground run's live stream, and a visible level is what makes the
 *  --level filter verifiable). Unparseable lines print raw, gray: the file
 *  is honest about itself. */
function renderLine(line, { out, c }) {
  let evt = null;
  try { evt = JSON.parse(line); } catch { evt = null; }
  if (!evt || typeof evt !== 'object' || evt.text == null) {
    out(c('gray', `  ${line}`));
    return;
  }
  const clock = typeof evt.ts === 'string' && Number.isFinite(Date.parse(evt.ts))
    ? `${new Date(evt.ts).toTimeString().slice(0, 8)} `
    : '';
  const level = String(evt.level || 'info').toLowerCase();
  const color = LEVEL_COLOR[level] || 'reset';
  const text = String(evt.text).replace(/\n/g, '\n    ');
  out(`  ${c('gray', clock)}${c(color, level.padStart(5))} ${c('gray', `[${evt.source ?? '?'}] `)}${text}`);
}

/** Emit the lines of `text` (whole-file read) that pass the filters. */
function emitTail(text, opts, ctx) {
  const lines = text.split('\n').filter(Boolean);
  const hits = lines.filter((l) => passes(l, opts));
  for (const line of hits.slice(-opts.tail)) {
    if (opts.json) ctx.out(line);
    else renderLine(line, ctx);
  }
  return hits.length;
}

/**
 * The follow loop: poll-and-append at the writer's own cadence. Each tick
 * re-establishes the truth (stat the size, read the delta past the offset), a
 * size SHRINK resets the offset to 0 (restart wipe / cleanup delete — the only
 * truncations the writer produces; the loop re-checks every tick), and the
 * run's status is re-read so following ENDS on its own once the run settles.
 * Poll interval: 1s by default (matched to the writer's flushMs),
 * WORCA_LOGS_FOLLOW_MS to tune, clamped to [100, 5000].
 */
async function follow(row, path, opts, startOffset, { out, c }) {
  const ms = Math.min(5000, Math.max(100, Number(process.env.WORCA_LOGS_FOLLOW_MS) || 1000));
  // The same filters the initial tail applied hold for every appended line.
  const print = (line) => {
    if (!passes(line, opts)) return;
    if (opts.json) out(line);
    else renderLine(line, { out, c });
  };
  const status = () => {
    try { return (getDb().prepare('SELECT status FROM pipelines WHERE id = ?').get(row.id) || {}).status; }
    catch { return null; } // a locked store mid-write must not kill the follow
  };
  // Ctrl-C detaches: exit 0, print where to look later — never touch the run.
  const onInt = () => {
    out('');
    out(c('gray', `detached — the run keeps going (check: worca runs ${row.id})`));
    process.exit(0);
  };
  process.on('SIGINT', onInt);
  try {
    // Start exactly where the initial tail's read ended (0 when there was no
    // file yet), so nothing written in between is skipped.
    let offset = startOffset;
    // A trailing line without its newline yet (read mid-append) waits here
    // until the rest of it lands, so one record never prints as two.
    let pending = '';
    // Streaming decode: a multi-byte character split across two reads stays whole.
    let decoder = new StringDecoder('utf8');
    const drain = async () => {
      let s = null;
      try { s = await stat(path); } catch {
        // Not there (yet / any more). A run that has not started has no named
        // run dir yet, so re-resolve it: the dir appears under its final name.
        try { path = join(await runDirForRow(row), RUN_LOG_FILE); } catch { /* next tick */ }
        return;
      }
      if (s.size < offset) { offset = 0; pending = ''; decoder = new StringDecoder('utf8'); }
      if (s.size <= offset) return;
      const fh = await open(path, 'r');
      try {
        const buf = Buffer.alloc(s.size - offset);
        const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
        offset += bytesRead;
        const parts = (pending + decoder.write(buf.subarray(0, bytesRead))).split('\n');
        pending = parts.pop();
        for (const line of parts) if (line) print(line);
      } finally { await fh.close(); }
    };
    for (;;) {
      await new Promise((r) => setTimeout(r, ms));
      await drain();
      const st = status();
      if (st && SETTLED.includes(st)) {
        // The writer flushes on its own timer, so the last lines can land just
        // after the status flips: one more beat, one more read, then flush
        // whatever partial line is left.
        await new Promise((r) => setTimeout(r, ms));
        await drain();
        if (pending) print(pending);
        out(c('gray', `run ${row.id} ${st}.`));
        return 0;
      }
    }
  } finally {
    process.removeListener('SIGINT', onInt);
  }
}

/**
 * `worca logs <id> [-f]` — tail (and optionally follow) a run's live log.
 * @returns {Promise<number>} exit code
 */
export async function cmdLogs(rest, { out, c, fail }) {
  const verb = rest[0];
  if (verb === 'help' || verb === '--help' || verb === '-h') { process.stdout.write(LOGS_HELP); return 0; }

  const opts = parseOptions(rest, fail);
  const id = resolveRunRef(opts.ref, fail);
  // The columns runDirForRow routes on (project vs workspace store namespace).
  const row = getDb().prepare('SELECT id, status, target, project_key, workspace_key FROM pipelines WHERE id = ?').get(id);
  if (!row) fail(`no run matches "${opts.ref}" (see: worca runs list)`); // resolveRunRef already guarantees the row

  const dir = await runDirForRow(row);
  const path = join(dir, RUN_LOG_FILE);
  let text = null;
  try { text = await readFile(path, 'utf8'); } catch { text = null; }

  if (opts.follow) {
    if (text == null) {
      out(c('gray', `No log yet for run ${id} — waiting for the first lines (Ctrl-C detaches).`));
      return follow(row, path, opts, 0, { out, c });
    }
    // Tail only the complete lines; a last line still mid-append is left for
    // the follow loop to read whole.
    const complete = text.slice(0, text.lastIndexOf('\n') + 1);
    emitTail(complete, opts, { out, c });
    return follow(row, path, opts, Buffer.byteLength(complete, 'utf8'), { out, c });
  }

  if (text == null) {
    out(`No log yet for run ${id} — the run may not have started (check: worca runs ${id}).`);
    return 0;
  }
  const hits = emitTail(text, opts, { out, c });
  if (!hits && (opts.sources.length || opts.level != null)) {
    out('No log lines match the given filters (see: worca logs help).');
  }
  return 0;
}
