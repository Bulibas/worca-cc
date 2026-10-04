// test/cost-aux-bridged.test.mjs — worca's own AI calls on a BRIDGED model (OpenRouter and friends) book
// what the upstream said they cost. The CLI prices a catalog id it does not know at $0; the bridge books
// the upstream's usage.cost under the tag in its URL (/r/<tag>). A pipeline node reads it back by its
// execution id (run-harness _onAgentEvent); the Away mode review, the run title and the Auto workflow
// classifier must do the same, or their spend is hidden behind a $0.
import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTempHome } from './helpers/temp-home.mjs';
import { createOrchestrator } from '../src/core/orchestrator.mjs';
import { addGlobalModel, setNightMode, setNightModeToggle } from '../src/core/settings.mjs';
import { generateTitle } from '../src/core/title.mjs';
import { classifyTask } from '../src/core/auto/classify.mjs';
import { recordBridgeCost, bridgeCostFor, _resetBridgeTelemetry } from '../src/core/bridge/telemetry.mjs';

useTempHome(after);
let home; const prev = {};
before(async () => {
  home = await mkdtemp(join(tmpdir(), 'worca-aux-bridged-'));
  for (const k of ['HOME', 'USERPROFILE', 'WORCA_TEST_ALLOW_HOME_FALLBACK']) prev[k] = process.env[k];
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.WORCA_TEST_ALLOW_HOME_FALLBACK = '1';
  await addGlobalModel({ id: 'or-qwen', upstream: { provider: 'openai', api: 'openai-chat', model: 'qwen/qwen3.8-27b', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-x' } });
});
after(async () => {
  for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  await rm(home, { recursive: true, force: true, maxRetries: 3 });
});
beforeEach(async () => { _resetBridgeTelemetry(); await setNightMode(null); await setNightModeToggle('auto'); });

/** The tag the bridge books under: the `/r/<tag>` segment of the spawn's base URL ('' = untagged). */
const tagOf = (env) => { const m = /\/r\/([^/]+)/.exec(String(env?.ANTHROPIC_BASE_URL || '')); return m ? decodeURIComponent(m[1]) : ''; };
/** A bridged spawn: the upstream reports $0.0123 for the call; the CLI prices the unknown id at $0. */
const bridged = (text, seen = []) => async (o) => {
  seen.push(tagOf(o.modelEnv));
  recordBridgeCost({ tag: tagOf(o.modelEnv), costUsd: 0.0123 });
  o.onEvent({ type: 'result', costUsd: 0, raw: { type: 'result', usage: { input_tokens: 500, output_tokens: 50 } } });
  return { text };
};
const DECISION = '{"decisions":[{"id":"a","choice":"y","confidence":90,"rationale":"fits","reversible":true,"scores":{}}]}';
function fakeClock(start = Date.parse('2026-10-03T12:00:00Z')) {
  let t = start; let seq = 0; const timers = new Map();
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    async tick(ms) {
      t += ms;
      for (const [id, tm] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (tm.at <= t) { timers.delete(id); tm.fn(); }
      await new Promise((r) => setImmediate(r));
    },
  };
}
async function settle(clock, done) {
  for (const end = Date.now() + 5000; !done() && Date.now() < end;) {
    await clock.tick(0);
    if (!done()) await new Promise((r) => setTimeout(r, 2));
  }
}

test('an Away mode review on a bridged model books the upstream cost under its own review id', async () => {
  await setNightMode({ enabled: true, strategy: 'analysis', graceMinutes: 1, deciderModel: 'or-qwen' });
  await setNightModeToggle('on');
  const clock = fakeClock();
  const tags = [];
  const orch = createOrchestrator({ projectDir: join(tmpdir(), 'aux-bridged-1'), nightClock: clock, nightRunClaude: bridged(DECISION, tags) });
  const booked = [];
  orch._recordCost = (usd, key, opts) => booked.push([usd, opts?.aux ?? null]);
  const p = orch._ask({ id: 'c1', kind: 'clarify', questions: [{ id: 'a', question: 'A?', options: ['x', 'y'] }] });
  await settle(clock, () => !orch.pendingQuestion); await p;
  assert.match(tags[0], /^night-decider-[0-9a-f]{8}$/, 'the review spawn is tagged with its row id');
  assert.deepEqual(booked, [[0.0123, 'away']], 'the upstream figure, not the CLI\'s $0');
  assert.deepEqual([orch.nightDecision('c1').costUsd, orch.nightDecision('c1').reviewStatus], [0.0123, 'finished']);
  assert.equal(bridgeCostFor(tags[0]), null, 'the tag is consumed');
});

test('a bridged review that ends without a result still books what the upstream reported (an error row, not a floor)', async () => {
  await setNightMode({ enabled: true, strategy: 'analysis', graceMinutes: 1, deciderModel: 'or-qwen' });
  await setNightModeToggle('on');
  const clock = fakeClock();
  const run = async (o) => {                                       // the 5-min timeout aborts it before any result
    recordBridgeCost({ tag: tagOf(o.modelEnv), costUsd: 0.0123 });
    throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  };
  const orch = createOrchestrator({ projectDir: join(tmpdir(), 'aux-bridged-2'), nightClock: clock, nightRunClaude: run });
  const booked = []; const floors = [];
  orch._recordCost = (usd, key, opts) => booked.push([usd, opts?.aux ?? null]);
  orch._recordAuxStopped = (key, kind, usd) => floors.push(usd);
  const p = orch._ask({ id: 'c2', kind: 'clarify', questions: [{ id: 'a', question: 'A?', options: ['x', 'y'] }] });
  await settle(clock, () => !orch.pendingQuestion); await p;
  assert.deepEqual(booked, [[0.0123, 'away']]);
  assert.deepEqual(floors, []);
  assert.deepEqual([orch.nightDecision('c2').reviewStatus, orch.nightDecision('c2').costUsd], ['error', 0.0123]);
});

test('the run title on a bridged model reports the upstream cost', async () => {
  const orch = createOrchestrator({ projectDir: join(tmpdir(), 'aux-bridged-3'), claude: { model: 'or-qwen' } });
  const opts = orch._titleGenOpts();
  assert.ok(opts.bridgeTag, 'the run passes a bridge tag');
  const seen = [];
  await generateTitle('add rate limiting', { ...opts, run: bridged('Add rate limiting'), onCost: (c) => seen.push(c.costUsd) });
  assert.deepEqual(seen, [0.0123]);
});

test('the Auto workflow classifier on a bridged model counts the upstream cost', async () => {
  const tags = [];
  const err = await classifyTask({ taskText: 'x', model: 'or-qwen', registry: {}, maxAttempts: 1, bridgeTag: 'auto-classify:p1:1' }, { run: bridged('no shape', tags) }).catch((e) => e);
  assert.equal(tags[0], 'auto-classify:p1:1');
  assert.equal(err.costUsd, 0.0123, 'an unusable reply was still billed at the upstream figure');
});

test('an Auto workflow round tags its classifier call with the pipeline and the round', async () => {
  const dir = join(tmpdir(), 'aux-bridged-5');
  const orch = createOrchestrator({ projectDir: dir, claude: { mock: true } });
  orch.pipeline = { id: 'p-bridge', dir };
  let seen = null;
  const classify = async (input) => { seen = input; throw new Error('stop here'); };
  await assert.rejects(orch._autoRound({ registry: {}, models: [], model: 'or-qwen', fingerprint: '', extras: [], taskText: 'x', classify, round: 3 }), /stop here/);
  assert.equal(seen.bridgeTag, 'auto-classify:p-bridge:3');
});

/** A bridged spawn the run's signal cuts before its `result`: the upstream already billed $0.0123. */
const cutAfterBilling = (ctrl) => (o) => {
  recordBridgeCost({ tag: tagOf(o.modelEnv), costUsd: 0.0123 });
  setImmediate(() => ctrl.abort());
  return new Promise((_r, rej) => {
    const onAbort = () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (o.signal.aborted) onAbort(); else o.signal.addEventListener('abort', onAbort, { once: true });
  });
};

test('a bridged classifier attempt cut before its result (a pause) still carries what the upstream billed', async () => {
  const ctrl = new AbortController();
  const err = await classifyTask({ taskText: 'x', model: 'or-qwen', registry: {}, maxAttempts: 1, bridgeTag: 'auto-classify:p1:2', signal: ctrl.signal },
    { run: cutAfterBilling(ctrl) }).catch((e) => e);
  assert.equal(err.name, 'AbortError', 'still the pause itself');
  assert.equal(err.costUsd, 0.0123, '_autoRound books it before the run parks');
  assert.equal(bridgeCostFor('auto-classify:p1:2'), null, 'the tag is consumed');
});

test('a bridged run title cut by a stop still reports what the upstream billed', async () => {
  const ctrl = new AbortController();
  const seen = [];
  const t = await generateTitle('add rate limiting', { model: 'or-qwen', bridgeTag: 'run-title:p1', signal: ctrl.signal, run: cutAfterBilling(ctrl),
    onCost: (c) => seen.push([c.costUsd, c.model]), bin: '/nonexistent/claude-must-not-spawn', mock: false });
  assert.equal(t, '', 'a stopped title keeps the provisional one');
  assert.deepEqual(seen, [[0.0123, 'or-qwen']]);
  assert.equal(bridgeCostFor('run-title:p1'), null);
});
