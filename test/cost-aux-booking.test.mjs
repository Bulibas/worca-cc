// test/cost-aux-booking.test.mjs — _recordCost's aux share + unknown-key fallback, a stopped call's
// lower bound kept apart, the exec_meta round-trip of step.auxCosts (no migration: it rides the JSON
// column), and the total of a resumed run.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator } from '../src/core/orchestrator.mjs';
import { createPipeline, readPipelineForResume } from '../src/core/artifacts.mjs';
import { prepare } from '../src/core/db.mjs';
import { useTempHome } from './helpers/temp-home.mjs';

useTempHome(after);
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });

function orchWithSteps() {
  const orch = createOrchestrator({ projectDir: join(tmpdir(), 'worca-aux-cost'), claude: { mock: true } });
  orch._persist = async () => {};                       // state only; the round-trip test covers the DB
  orch.state.steps.push(
    { key: 'x:preflight:1', executionId: 'x:preflight:1', nodeId: 'preflight', costUsd: 0 },
    { key: 'n_impl:1', executionId: 'n_impl:1', nodeId: 'n_impl', costUsd: 0 },
  );
  return orch;
}

test('aux share is tallied inside the step cost; the total stays the sum of steps', () => {
  const orch = orchWithSteps();
  orch._recordCost(1.84, 'n_impl:1');
  orch._recordCost(0.0712, 'n_impl:1', { aux: 'away' });
  const s = orch.state.steps[1];
  assert.equal(s.costUsd, 1.9112);
  assert.deepEqual(s.auxCosts, { away: { usd: 0.0712, calls: 1 } });
  assert.equal(orch.state.totalCostUsd, 1.9112);
});

test('I3: three full-float reviews never push the aux share above the step cost', () => {
  const orch = orchWithSteps();
  for (let i = 0; i < 3; i++) orch._recordCost(0.01234, 'n_impl:1', { aux: 'away' });
  const s = orch.state.steps[1];
  assert.equal(s.costUsd, 0.0369);
  assert.equal(s.auxCosts.away.usd, 0.0369, 'same roundUsd grain as the step (a raw tally reads 0.03702)');
  assert.ok(s.auxCosts.away.usd <= s.costUsd);
});

test('an unknown stepKey lands on the preflight bookend, once-logged, never dropped from the total', () => {
  const orch = orchWithSteps();
  const logged = [];
  orch._log = (src, lvl, text) => logged.push(text);
  orch._recordCost(0.05, 'gone:7', { aux: 'away' });
  orch._recordCost(0.01, 'gone:8');
  assert.equal(orch.state.steps[0].costUsd, 0.06);
  assert.deepEqual(orch.state.steps[0].auxCosts, { away: { usd: 0.05, calls: 1 } });
  assert.equal(orch.state.totalCostUsd, 0.06);
  assert.equal(logged.filter((t) => /no step row/.test(t)).length, 1);
});

test('with no step rows at all, the cost says once that it is outside the run total', () => {
  const orch = createOrchestrator({ projectDir: join(tmpdir(), 'worca-aux-norow'), claude: { mock: true } });
  orch._persist = async () => {};
  const logged = [];
  orch._log = (src, lvl, text) => logged.push(text);
  orch._recordCost(0.05, 'x:preflight:1', { aux: 'title' });
  orch._recordCost(0.01, 'n_impl:1');
  assert.equal(orch.state.totalCostUsd, 0);
  assert.equal(logged.filter((t) => /not in this run's total/.test(t)).length, 1);
});

test('a stopped call is counted with its lower bound apart — never costUsd or the total', () => {
  const orch = orchWithSteps();
  orch._recordAuxStopped('n_impl:1', 'away', 0.0189);
  orch._recordAuxStopped('n_impl:1', 'away', null);        // no list price: counted, not priced
  orch._recordAuxStopped('n_impl:1', 'away', undefined);   // never NaN
  orch._recordAuxStopped('n_impl:1', 'away', NaN);
  const s = orch.state.steps[1];
  assert.equal(s.costUsd, 0);
  assert.equal(orch.state.totalCostUsd, 0);
  assert.deepEqual(s.auxCosts, { away: { usd: 0, calls: 0, floorUsd: 0.0189, stopped: 4 } });
  const free = orchWithSteps();
  free._recordAuxStopped('n_impl:1', 'away', 0);           // a {free} model: the floor is a real $0
  assert.deepEqual(free.state.steps[1].auxCosts, { away: { usd: 0, calls: 0, floorUsd: 0, stopped: 1 } });
});

// ── exec_meta round-trip (real DB under the temp WORCA_HOME) ──────────────────────────────
// Writes through the harness's own _persist → writeState and reads back the way resume() does.
// The preflight bookend carries NO other exec_meta field: it is the hasMeta-gate case
// (without `|| st.auxCosts != null` its auxCosts would never reach the JSON column).
test('auxCosts survive _persist → readPipelineForResume, on a meta-less bookend row too; ledger = total', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'worca-aux-rt-'));
  try {
    const pipeline = await createPipeline(dir, { prompt: 'aux round-trip' });
    const orch = createOrchestrator({ projectDir: dir, claude: { mock: true } });
    orch.pipeline = pipeline;
    orch.state.id = pipeline.id;
    orch.state.steps.push(
      { key: 'x:preflight:1', executionId: 'x:preflight:1', nodeId: 'preflight', costUsd: 0 },   // no other meta
      { key: 'n_impl:1', executionId: 'n_impl:1', nodeId: 'n_impl', nodeKey: 'implement', costUsd: 0 },
    );
    orch._recordCost(1.84, 'n_impl:1');
    orch._recordCost(0.0712, 'n_impl:1', { aux: 'away' });
    orch._recordCost(0.0021, 'x:preflight:1', { aux: 'title' });
    orch._recordCost(0.004, 'gone:3');                    // unknown key → the bookend, ledger keyed to it
    orch._recordAuxStopped('n_impl:1', 'away', 0.0189);
    await orch._persist();
    const { row, steps } = readPipelineForResume(pipeline.id);
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s]));
    assert.deepEqual(byKey['n_impl:1'].auxCosts, { away: { usd: 0.0712, calls: 1, stopped: 1, floorUsd: 0.0189 } });
    assert.deepEqual(byKey['x:preflight:1'].auxCosts, { title: { usd: 0.0021, calls: 1 } }, 'hasMeta gate: a bookend with only auxCosts round-trips');
    assert.equal(byKey['x:preflight:1'].costUsd, 0.0061);
    assert.equal(row.total_cost_usd, 1.9173);
    const ledger = prepare('SELECT step_key, amount_usd FROM cost_ledger WHERE pipeline_id = ? ORDER BY id').all(pipeline.id);
    assert.ok(Math.abs(ledger.reduce((s, r) => s + r.amount_usd, 0) - row.total_cost_usd) < 1e-4, 'I2: ledger = total');
    assert.equal(ledger.at(-1).step_key, 'x:preflight:1', 'the ledger row names the step actually charged');
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

// ── resume: the total is rehydrated with the steps (I2 for a resumed run) ──────────────────
test('a resumed run that books nothing new keeps the total it paused with (I2)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'worca-resume-total-'));
  dirs.push(dir);
  execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: dir });
  let hangOnce = true; let orchRef = null;
  const mkRunners = () => ({
    producer: async (ctx) => {
      if (hangOnce) {
        hangOnce = false;
        queueMicrotask(() => { orchRef._recordCost(0.5, ctx.executionId); orchRef.pause(); });
        return new Promise((_r, rej) => {
          const onAbort = () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); };
          if (ctx.signal.aborted) onAbort(); else ctx.signal.addEventListener('abort', onAbort, { once: true });
        });
      }
      return { status: 'ok', summary: 'ok' };
    },
    verifier: async () => ({ status: 'ok', issues: [], review: { issues: [] }, summary: '' }),
  });
  const orch1 = createOrchestrator({ projectDir: dir, prompt: 'demo', auto: true, claude: { mock: true, bin: '/nonexistent/claude-must-not-spawn' }, runners: mkRunners() });
  orchRef = orch1;
  assert.equal((await orch1.run()).status, 'paused');
  await orch1._titlePromise;
  const id = orch1.state.id;
  const pausedTotal = readPipelineForResume(id).row.total_cost_usd;
  const orch2 = createOrchestrator({ projectDir: dir, claude: { mock: true, bin: '/nonexistent/claude-must-not-spawn' }, auto: true, runners: mkRunners(), resume: readPipelineForResume(id) });
  orchRef = orch2;
  assert.equal((await orch2.resume()).status, 'done');
  const { row, steps } = readPipelineForResume(id);
  const ledger = prepare('SELECT SUM(amount_usd) AS s FROM cost_ledger WHERE pipeline_id = ?').get(id).s;
  assert.equal(pausedTotal, 0.5);
  assert.equal(row.total_cost_usd, 0.5, 'not $0: the resumed harness rehydrates the total with the steps');
  assert.equal(row.total_cost_usd, Math.round(steps.reduce((s, x) => s + (x.costUsd || 0), 0) * 1e4) / 1e4);
  assert.ok(Math.abs(ledger - row.total_cost_usd) < 1e-4, 'I2: ledger = total');
});

test('the Auto workflow classifier books its share as aux "auto" on the preflight bookend', () => {
  const orch = orchWithSteps();
  orch._recordAutoCost(1, { costUsd: 0.0398, usage: {} }, new Date().toISOString(), 'claude-sonnet-5-5', { checkCaps: false });
  assert.deepEqual(orch.state.steps[0].auxCosts, { auto: { usd: 0.0398, calls: 1 } });
  assert.equal(orch.state.totalCostUsd, 0.0398);
});

test('an Auto workflow round a pause or stop cuts is recorded as stopped, not finished', async () => {
  const cutRound = async (err, { abortFirst = false } = {}) => {
    const orch = orchWithSteps();
    orch.pipeline = { dir: join(tmpdir(), 'worca-aux-cut-round') };
    await assert.rejects(orch._autoRound({ registry: {}, models: [], model: 'claude-sonnet-5-5', fingerprint: '', extras: [], taskText: 'x',
      classify: async () => { if (abortFirst) orch.pauseAbort.abort(); throw err; }, round: 2 }), { name: err.name });
    return orch.state.subAgents.filter((s) => s.subagentType === 'auto-classify').map((s) => [s.status, s.costUsd]);
  };
  const usage = { input_tokens: 0, output_tokens: 0 };
  assert.deepEqual(await cutRound(Object.assign(new Error('aborted'), { name: 'AbortError', costUsd: 0, usage })), [['stopped', 0]]);
  assert.deepEqual(await cutRound(Object.assign(new Error('aborted'), { name: 'AbortError', costUsd: 0.01, usage })), [['stopped', 0.01]],
    'a cut round that was billed is booked, and still says it was cut');
  assert.deepEqual(await cutRound(Object.assign(new Error('no shape'), { name: 'ClassifierError', costUsd: 0.02, usage })), [['finished', 0.02]],
    'a round that ran to its end and failed is not a stopped one');
  // A pause during the 429 backoff: withRecoveryRetry rethrows the earlier attempt's ClassifierError.
  assert.deepEqual(await cutRound(Object.assign(new Error('rate limited'), { name: 'ClassifierError', costUsd: 0.02, usage }), { abortFirst: true }),
    [['stopped', 0.02]], 'the run\'s pause cut it, whatever error the retry rethrew');
});
