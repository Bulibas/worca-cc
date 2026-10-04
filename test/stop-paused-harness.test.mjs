// test/stop-paused-harness.test.mjs — RunHarness.stopPaused on a REAL paused run: the row
// reads stopped with no resume point, the saved totals and step ledger survive the write-back,
// the work in the worktree is committed onto the kept branch and the worktree is removed,
// exactly one done(stopped) and never a `running` state; a lost claim touches nothing; an
// interrupted run is refused; a worktree deleted by hand does not block the stop; a resume and
// a stop never both win, and a stop or pause mailed while a resume rehydrates is executed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { useTempHome } from './helpers/temp-home.mjs';
import { ENGINES } from './helpers/engines.mjs';
import { getDb } from '../src/core/db.mjs';
import { readPipelineForResume } from '../src/core/artifacts.mjs';
import { createOrchestratorFor } from '../src/core/engine-select.mjs';
import { enqueuePipelineCommand, CONTROL_CHECK_INTERVAL_MS } from '../src/core/pipeline-commands.mjs';

useTempHome(after);
const engine = ENGINES[0];
const okVerifier = async () => ({ status: 'ok', issues: [], review: { issues: [] }, summary: '' });

function gitDir() {
  const dir = mkdtempSync(join(tmpdir(), 'worca-cc-stop-paused-'));
  execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: dir });
  return dir;
}

/** A real paused run whose producer wrote `wip.txt` into its worktree before the pause. */
async function pausedRun() {
  const dir = gitDir();
  let orch;
  orch = engine.create({
    projectDir: dir, prompt: 'demo', auto: true, claude: { mock: true },
    runners: {
      producer: async (ctx) => {
        writeFileSync(join(orch.runCwd, 'wip.txt'), 'half done\n');
        ctx.onEvent({ type: 'session', sessionId: 'sess-wip' });
        queueMicrotask(() => orch.pause());
        return new Promise((_res, rej) => {
          const onAbort = () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); };
          if (ctx.signal.aborted) onAbort();
          else ctx.signal.addEventListener('abort', onAbort, { once: true });
        });
      },
      verifier: okVerifier,
    },
  });
  const res = await orch.run();
  assert.equal(res.status, 'paused');
  const id = orch.state.id;
  const branch = JSON.parse(getDb().prepare('SELECT branch FROM pipelines WHERE id = ?').get(id).branch);
  return { dir, id, wt: branch.worktreeDir, feature: branch.feature, orig: orch };
}

async function stopper(dir, id) {
  // mock: a mock run records no team metrics (no sink discovery) — hermetic and fast.
  const o = await createOrchestratorFor({ projectDir: dir, claude: { mock: true }, resume: readPipelineForResume(id) });
  const events = [];
  const logs = [];
  o.on('state', (s) => events.push(`state:${s.status}`));
  o.on('done', (d) => events.push(`done:${d.status}`));
  o.on('log', (l) => logs.push(String(l.text || '')));
  return { o, events, logs };
}

const rowOf = (id) => getDb().prepare('SELECT status, resume_point, total_cost_usd FROM pipelines WHERE id = ?').get(id);
const stepCount = (id) => getDb().prepare('SELECT COUNT(*) n FROM pipeline_steps WHERE pipeline_id = ?').get(id).n;
const audit = (id) => getDb().prepare('SELECT text FROM pipeline_events WHERE pipeline_id = ? ORDER BY id').all(id).map((r) => r.text).join('\n');

test('stopPaused settles a paused run for real: row, totals, steps, branch, worktree, events', async () => {
  const { dir, id, wt, feature, orig } = await pausedRun();
  // A spend the stop must write back unchanged (the upsert rewrites total_cost_usd AND every step
  // row from state). I2: the total is the sum of the step costs, so the spend sits on a step too.
  getDb().prepare('UPDATE pipeline_steps SET cost_usd = 1.25 WHERE rowid = (SELECT MIN(rowid) FROM pipeline_steps WHERE pipeline_id = ?)').run(id);
  getDb().prepare('UPDATE pipelines SET total_cost_usd = 1.25 WHERE id = ?').run(id);
  const steps = stepCount(id);
  assert.ok(steps > 0, 'the paused run has a step ledger');
  assert.ok(existsSync(wt), 'a pause keeps the worktree');

  const { o, events } = await stopper(dir, id);
  const res = await o.stopPaused('ada@example.com');

  assert.equal(res.status, 'stopped');
  const row = rowOf(id);
  assert.equal(row.status, 'stopped');
  assert.equal(row.resume_point, null, 'a stopped run is not resumable');
  assert.equal(row.total_cost_usd, 1.25, 'the saved spend survives the write-back');
  assert.equal(stepCount(id), steps, 'the step ledger survives the write-back');
  assert.equal(getDb().prepare('SELECT SUM(cost_usd) s FROM pipeline_steps WHERE pipeline_id = ?').get(id).s, 1.25, 'the step spend survives (I2)');
  const stepStatuses = getDb().prepare('SELECT status FROM pipeline_steps WHERE pipeline_id = ?').all(id).map((s) => s.status);
  assert.ok(stepStatuses.includes('stopped') && !stepStatuses.includes('paused'), `the parked step ends stopped, as a live stop leaves it: ${stepStatuses}`);
  const br = JSON.parse(getDb().prepare('SELECT branch FROM pipelines WHERE id = ?').get(id).branch);
  assert.equal(br.worktreeRemoved, true, 'the row records the teardown');
  assert.match(br.commit || '', /^[0-9a-f]{40}$/, 'the row records the commit on the kept branch');
  assert.ok(!events.includes('state:running'), `never running: ${events}`);
  assert.equal(events.filter((e) => e === 'done:stopped').length, 1, `one done(stopped): ${events}`);
  assert.equal(events.at(-1), 'done:stopped');
  assert.equal(existsSync(wt), false, 'the worktree is removed');
  const kept = execFileSync('git', ['show', `${feature}:wip.txt`], { cwd: dir, encoding: 'utf8' });
  assert.equal(kept, 'half done\n', 'the work so far is committed onto the kept branch');
  assert.match(audit(id), /Pipeline \*\*stopped\*\* by ada@example\.com\./);
  // The harness that paused the run can still write late (its title outlives a pause): the row is no longer its own.
  const before = rowOf(id);
  await orig._persist();
  assert.deepEqual(rowOf(id), before, 'a late write from the paused harness leaves the stopped row alone');
});

test('a lost claim touches nothing: a second stop of the same run throws NOT_PAUSED', async () => {
  const { dir, id } = await pausedRun();
  const first = await stopper(dir, id);
  const second = await stopper(dir, id);         // read while still paused: a stale snapshot
  await first.o.stopPaused('ada');
  await assert.rejects(second.o.stopPaused('grace'), (e) => e.code === 'NOT_PAUSED');
  assert.deepEqual(second.events, [], 'the loser emitted nothing');
  assert.equal(rowOf(id).status, 'stopped');
});

test('an interrupted run is refused: status, resume point and worktree are kept', async () => {
  const { dir, id, wt } = await pausedRun();
  getDb().prepare("UPDATE pipelines SET status = 'interrupted' WHERE id = ?").run(id);
  const { o, events } = await stopper(dir, id);
  await assert.rejects(o.stopPaused('ada'), (e) => e.code === 'NOT_PAUSED');
  const row = rowOf(id);
  assert.equal(row.status, 'interrupted');
  assert.ok(row.resume_point, 'it stays resumable');
  assert.ok(existsSync(wt), 'its worktree is kept');
  assert.deepEqual(events, []);
});

test('a worktree deleted by hand does not block the stop', async () => {
  const { dir, id, wt } = await pausedRun();
  rmSync(wt, { recursive: true, force: true });
  execSync('git worktree prune', { cwd: dir });
  const { o, events, logs } = await stopper(dir, id);
  const res = await o.stopPaused('ada');
  assert.equal(res.status, 'stopped');
  assert.equal(rowOf(id).status, 'stopped');
  assert.equal(events.at(-1), 'done:stopped');
  // The non-strict re-attach handles it (warns, skips), not the last-resort catch.
  assert.ok(logs.some((t) => /worktree missing: .* nothing to commit or remove/.test(t)), `logs: ${logs.join(' | ')}`);
  assert.ok(!logs.some((t) => /could not be fully restored/.test(t)), 'the re-attach did not throw');
  assert.match(readFileSync(join(o.pipeline.dir, 'live-log.ndjson'), 'utf8'), /worktree missing/, 'the stop writes into the run log');
});

// A resume and a stop of one paused run in two processes (`worca resume` vs a UI Stop): the stop
// lands while the resume is mid-rehydration. Exactly one of them may win, whichever await it hits.
for (const hook of ['_engineRehydrate', '_resolvePolicy']) {
  test(`a stop that lands while resume() awaits ${hook}: exactly one of them wins`, async () => {
    const { dir, id } = await pausedRun();
    const resumer = await createOrchestratorFor({
      projectDir: dir, claude: { mock: true }, resume: readPipelineForResume(id),
      runners: { producer: async () => ({ status: 'ok', summary: 'ok' }), verifier: okVerifier },
    });
    const { o: other } = await stopper(dir, id);
    let stopping = null;
    const orig = resumer[hook].bind(resumer);
    resumer[hook] = (...a) => {
      if (!stopping) stopping = other.stopPaused('ada').then((r) => r.status, (e) => e.code || e.message);
      return orig(...a);
    };
    const resumed = await resumer.resume().then((r) => r.status, (e) => `threw: ${e.message}`);
    const stopped = await stopping;
    const row = rowOf(id);
    if (stopped === 'stopped') {
      assert.match(resumed, /not resumable/, `the stop won, so the resume is refused (resume: ${resumed})`);
      assert.equal(row.status, 'stopped');
      assert.equal(row.resume_point, null);
    } else {
      assert.equal(stopped, 'NOT_PAUSED', `the resume won, so the stop is refused (stop: ${stopped})`);
      assert.equal(resumed, 'done');
      assert.equal(row.status, 'done');
    }
  });
}

// A `worca stop` / `worca pause` from a terminal while a resume is rehydrating: the row already reads
// running (claimForResume), so the CLI mails a command. The run must execute it once it is running —
// never drop it as stale when it takes ownership, never consume it as a no-op before then.
for (const action of ['stop', 'pause']) {
  test(`a ${action} mailed while resume() rehydrates is executed once the run is running`, async () => {
    const { dir, id } = await pausedRun();
    const resumer = await createOrchestratorFor({
      projectDir: dir, claude: { mock: true }, resume: readPipelineForResume(id),
      runners: {
        // Alive until stopped or paused (4 s at most), so the command has a running run to act on.
        producer: (ctx) => new Promise((res, rej) => {
          const t = setTimeout(() => res({ status: 'ok', summary: 'ok' }), 4000);
          const onAbort = () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; rej(e); };
          if (ctx.signal.aborted) onAbort();
          else ctx.signal.addEventListener('abort', onAbort, { once: true });
        }),
        verifier: okVerifier,
      },
    });
    const seen = {};
    const orig = resumer._resolvePolicy.bind(resumer);
    resumer._resolvePolicy = async (...a) => {
      seen.status = rowOf(id).status;
      seen.beating = !!resumer._heartbeatTimer;
      enqueuePipelineCommand(id, action, { by: 'grace' });
      await new Promise((r) => setTimeout(r, 2.5 * CONTROL_CHECK_INTERVAL_MS));   // the poller ticks meanwhile
      return orig(...a);
    };
    const res = await resumer.resume();
    const want = action === 'stop' ? 'stopped' : 'paused';
    assert.equal(res.status, want, `the ${action} took effect`);
    assert.equal(rowOf(id).status, want);
    assert.deepEqual(seen, { status: 'running', beating: true }, 'the claimed row beats while the run rehydrates');
  });
}

test('a booking that lands after the stop read the run is kept: the stop re-reads the row it claimed', async () => {
  const { dir, id } = await pausedRun();
  const { o } = await stopper(dir, id);              // the snapshot is read here, before the booking
  // A cost the paused harness books after that (its title call outlives a pause), on a step (I2).
  getDb().prepare('UPDATE pipeline_steps SET cost_usd = 0.3 WHERE rowid = (SELECT MIN(rowid) FROM pipeline_steps WHERE pipeline_id = ?)').run(id);
  getDb().prepare('UPDATE pipelines SET total_cost_usd = 0.3 WHERE id = ?').run(id);
  await o.stopPaused('ada');
  assert.equal(rowOf(id).total_cost_usd, 0.3, 'the late booking survives the write-back');
  assert.equal(getDb().prepare('SELECT SUM(cost_usd) s FROM pipeline_steps WHERE pipeline_id = ?').get(id).s, 0.3);
});

test('a resume prepared before the stop is refused: the stopped row stays stopped', async () => {
  const { dir, id } = await pausedRun();
  const stale = await createOrchestratorFor({ projectDir: dir, claude: { mock: true }, resume: readPipelineForResume(id) });
  const { o } = await stopper(dir, id);
  await o.stopPaused('ada');
  await assert.rejects(stale.resume(), /not resumable/);
  const row = rowOf(id);
  assert.equal(row.status, 'stopped', 'never re-parked or errored over');
  assert.equal(row.resume_point, null);
});
