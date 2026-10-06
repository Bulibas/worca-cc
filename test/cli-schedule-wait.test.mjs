// test/cli-schedule-wait.test.mjs — `worca … --at +2s --wait` end to end: the terminal owns its
// ticket, waits for it, starts the run itself and reports the outcome. Its own file so the slow
// tier can hold it (it waits out real seconds); waitAndRun's paths are pinned in-process in
// test/cli-verbs-inproc.test.mjs, the rest of the schedule CLI in test/cli-schedule.test.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useTempHome } from './helpers/temp-home.mjs';
import { gitDir } from './helpers/git-dir.mjs';
import { getDb } from '../src/core/db.mjs';
import { listTickets } from '../src/core/scheduler.mjs';
import { listNotifications } from '../src/core/notifications.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, '..', 'src', 'cli', 'worca-cc.mjs');
const home = useTempHome(after);
const proj = gitDir('cli-sched-wait');

function run(args) {
  return new Promise((res) => {
    // HOME too: settings.json (the schedule defaults) resolves under HOME, not WORCA_HOME.
    const env = { ...process.env, WORCA_MOCK: '1', WORCA_HOME: home, HOME: home, USERPROFILE: home, TZ: 'Europe/Berlin' };
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], { env, cwd: proj, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('exit', (code) => res({ code: code ?? 0, stdout, stderr }));
  });
}

test('--wait owns the ticket, starts the run in this terminal, and reports the outcome', { timeout: 120000 }, async () => {
  const r = await run(['--project', proj, '--prompt', 'Wait mode demo', '--at', '+2s', '--wait', '--yes', '--mock']);
  assert.equal(r.code, 0, r.stderr + r.stdout.slice(-600));
  assert.match(r.stdout, /Waiting here/);
  assert.match(r.stdout, /Starting the scheduled run/);
  assert.match(r.stdout, /Pipeline complete/);
  const t = listTickets({ all: true }).find((x) => x.title === 'Wait mode demo');
  assert.equal(t.status, 'fired');
  assert.ok(t.pipelineId, 'the ticket learned its pipeline');
  const row = getDb().prepare('SELECT status, scheduled_for FROM pipelines WHERE id = ?').get(t.pipelineId);
  assert.equal(row.status, 'done');
  assert.equal(row.scheduled_for, t.runAt);
  assert.ok(listNotifications().some((n) => n.kind === 'completed' && n.ticketId === t.id));
  assert.match((await run(['schedule', 'log'])).stdout, /completed\s+Wait mode demo finished\./);
});
