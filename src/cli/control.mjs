// src/cli/control.mjs
// `worca stop` / `worca pause` — run control from the terminal (issue #513).
//
// The CLI could start, resume and schedule runs but not act on a LIVE one:
// stop/pause lived only in the web UI (and the chat bot's /stop, /pause), both
// of which hold the run's orchestrator in-process. This module does NOT call
// the UI server — a run may be owned by any process (a CLI foreground terminal,
// a scheduled --wait, the server), and routing control through the server would
// reach only server-owned runs. Instead the command is WRITTEN to the store
// (pipeline_commands, the control mailbox) and the run's owning process — whose
// harness polls its slot every second — claims and executes it through the same
// orchestrator methods the UI button uses. Reads and the confirmation poll come
// straight from the store, so NO Worca server needs to be up; a run started in
// another terminal is controllable from here, and that terminal keeps its own
// Ctrl+C controls too.

import { getDb } from '../core/db.mjs';
import { isDeadOwner } from '../core/artifacts.mjs';
import { enqueuePipelineCommand, reapPipelineCommands } from '../core/pipeline-commands.mjs';
import { resolveRunRef } from './runs.mjs';

export const CONTROL_HELP = `worca stop | worca pause — control a live run

Usage:
  worca stop <id>              Abort a live run (any unique prefix)
  worca pause <id>             Gracefully pause a live run — in-flight nodes are
                               stopped, a resume point is kept; resume with: worca resume <id>
  worca stop --json <id>       Machine-readable output (pause takes it too)

The command is written to the Worca store and the process that owns the run
picks it up within about a second — no Worca server needs to be up. Stopping an
already-stopped run succeeds (idempotent, for scripts); a paused or finished run
is not controllable — resume it with: worca resume <id>.
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Statuses with no live orchestrator: once the run is in one, a command can no longer act. */
const SETTLED = new Set(['done', 'stopped', 'paused', 'interrupted']);

/** How long the CLI waits for the owner to confirm the effect. WORCA_CONTROL_CONFIRM_MS
 *  exists for tests (the same pattern as WORCA_HEARTBEAT_STALE_MS); real users get 10s,
 *  which covers a run that is mid-execution before it can act. */
const confirmMs = () => {
  const n = Number(process.env.WORCA_CONTROL_CONFIRM_MS);
  return Number.isFinite(n) && n > 0 ? n : 10_000;
};

/** An exit-1 condition (a run that cannot be controlled), printed like the
 *  resume command's: plain stderr, no usage framing. Usage errors keep the
 *  shared fail() (exit 2). */
function refusal(msg) {
  process.stderr.write(`worca: ${msg}\n`);
  return 1;
}

/**
 * One control verb, stop or pause — the flows are identical except for the
 * status they wait for and the success line they print.
 * @returns {Promise<number>} exit code
 */
async function controlRun(argv, action, { out, c, fail }) {
  const json = argv.includes('--json');
  const unknown = argv.filter((a) => a.startsWith('-') && a !== '--json');
  if (unknown.length) fail(`unknown option(s): ${unknown.join(' ')} — see: worca ${action} help`);
  const ref = argv.find((a) => !a.startsWith('-'));
  if (!ref) fail(`a run id is required (see: worca runs list)`);
  const id = resolveRunRef(ref, fail);

  // Best-effort sweep: drop stale commands whose target run settled meanwhile.
  try { reapPipelineCommands(); } catch { /* best-effort */ }

  const row = getDb().prepare(
    'SELECT id, title, status, owner_pid, owner_host, heartbeat_at, updated_at, started_at FROM pipelines WHERE id = ?',
  ).get(id);
  if (!row) fail(`no run matches "${ref}" (see: worca runs list)`);

  // The live boundary (decision "paused ≠ controllable") + stop's idempotence
  // (decision 3): stop on an already-stopped run SUCCEEDS, everything else that
  // is not `running` is refused with the row's own status and the way out.
  if (row.status !== 'running') {
    if (action === 'stop' && row.status === 'stopped') {
      if (json) out(JSON.stringify({ id: row.id, action, outcome: 'already-stopped', status: row.status }, null, 2));
      else out(`${row.title || row.id} is already stopped.`);
      return 0;
    }
    const resumeHint = row.status === 'paused' || row.status === 'interrupted' ? ` — resume it with: worca resume ${row.id}` : '';
    if (json) {
      out(JSON.stringify({ id: row.id, action, outcome: 'refused', status: row.status, error: `run is "${row.status}", not live${resumeHint}` }, null, 2));
      return 1;
    }
    return refusal(`run ${row.id} is "${row.status}" — ${action} targets a live run${resumeHint}`);
  }

  // Dead owner: never enqueue a command nobody will read (issue decision).
  if (isDeadOwner(row)) {
    const msg = `no live owner process for run ${row.id} (pid ${row.owner_pid ?? '—'} on ${row.owner_host ?? '—'})`
      + ` — the stale sweep will mark it interrupted; resume with: worca resume ${row.id}`;
    if (json) out(JSON.stringify({ id: row.id, action, outcome: 'no-owner', status: row.status, error: msg }, null, 2));
    else refusal(msg);
    return 1;
  }

  const { id: commandId } = enqueuePipelineCommand(row.id, action, { by: 'local' });

  // The waitAndRun-shaped confirmation poll (schedule.mjs): poll the run's own
  // row — the same read `worca runs show` does — adaptive sleep with a 250ms
  // floor, ~10s deadline. The effect is read from the ROW (stopped/paused); the
  // command's consumed_at only tells "the owner received it" apart from "still
  // queued", because the owner may legitimately consume a command as a no-op when
  // the state moved on first. A run that settles in some OTHER status ends the
  // wait early: the command can no longer apply (a settled run has no owner, and
  // the next owner discards leftovers).
  const target = action === 'stop' ? 'stopped' : 'paused';
  const deadline = Date.now() + confirmMs();
  let status = row.status;
  while (Date.now() < deadline) {
    await sleep(Math.min(500, Math.max(250, deadline - Date.now())));
    const r = getDb().prepare('SELECT status FROM pipelines WHERE id = ?').get(row.id);
    status = (r && r.status) || status;
    if (status === target || SETTLED.has(status)) break;
  }
  const consumed = Boolean(getDb().prepare('SELECT consumed_at FROM pipeline_commands WHERE id = ?').get(commandId)?.consumed_at);

  const title = row.title || row.id;
  const outcome = status === target ? action
    : status === 'done' ? 'finished'
    : SETTLED.has(status) ? 'not-applied'
    : consumed ? 'received' : 'enqueued';
  const code = outcome === 'not-applied' ? 1 : 0; // received/enqueued are accepted commands
  if (json) {
    out(JSON.stringify({ id: row.id, title, action, commandId, outcome, status, consumed }, null, 2));
    return code;
  }
  const Verb = action === 'stop' ? 'Stop' : 'Pause';
  if (outcome === action) {
    out(`${c('green', action === 'stop' ? 'Stopped' : 'Paused')} ${c('bold', title)}${action === 'pause' ? c('gray', ' — resume with: worca resume ' + row.id) : ''}`);
  } else if (outcome === 'finished') {
    out(c('yellow', `The run finished before the ${action} could act (${title}).`));
  } else if (outcome === 'not-applied') {
    const resumeHint = status === 'paused' || status === 'interrupted' ? ` — resume it with: worca resume ${row.id}` : '';
    return refusal(`the ${action} did not apply: run ${row.id} is now "${status}"${resumeHint}`);
  } else if (outcome === 'received') {
    out(c('gray', `${Verb} received by the run, which has not reached "${target}" yet (status: ${status}) — check: worca runs ${row.id}`));
  } else {
    out(c('gray', `${Verb} command enqueued — the run has not picked it up yet (check: worca runs ${row.id}).`));
  }
  return 0;
}

/**
 * `worca stop|pause` — dispatch. The entry point routes only `stop` and `pause`
 * here and passes the args after the verb separately (the same way cmdRuns
 * receives the rest). `help` after the verb prints the usage, like `worca runs help`.
 * @returns {Promise<number>} exit code
 */
export async function cmdControl(verb, rest, { out, c, fail }) {
  if (rest[0] === 'help' || rest[0] === '--help' || rest[0] === '-h') { process.stdout.write(CONTROL_HELP); return 0; }
  return controlRun(rest, verb, { out, c, fail });
}
