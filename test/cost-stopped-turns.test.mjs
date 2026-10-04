// test/cost-stopped-turns.test.mjs — an agent step the user pauses (or stops) mid-turn has no `result`
// frame, so nothing is booked for it — but its turns were billed. They are counted on the step with
// their tokens and a list-price LOWER BOUND apart (I4: never the step cost, the total, the ledger or a
// cap), and the count survives the exec_meta round-trip (History, resume).
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTempHome } from './helpers/temp-home.mjs';
import { gitDir } from './helpers/git-dir.mjs';
import { createOrchestrator } from '../src/core/orchestrator.mjs';
import { readPipelineForResume } from '../src/core/artifacts.mjs';
import { prepare } from '../src/core/db.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { addGlobalModel } from '../src/core/settings.mjs';
import { recordBridgeCall, recordBridgeCost, bridgeCostFor, _resetBridgeTelemetry } from '../src/core/bridge/telemetry.mjs';

useTempHome(after);

/** One priced turn that DID finish (result), then a second turn cut by the pause: two assistant frames
 *  of ONE message (the CLI repeats message.usage per content block), and no result. */
function pausingProducer(getOrch) {
  return async (ctx) => {
    ctx.onEvent({ type: 'result', costUsd: 0.2, raw: { type: 'result', total_cost_usd: 0.2, usage: { input_tokens: 10, output_tokens: 5 } } });
    const u = { input_tokens: 20000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    ctx.onEvent({ type: 'assistant', raw: { type: 'assistant', message: { id: 'msg_cut', usage: u, content: [{ type: 'text', text: 'a' }] } } });
    ctx.onEvent({ type: 'assistant', raw: { type: 'assistant', message: { id: 'msg_cut', usage: u, content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } } });
    queueMicrotask(() => getOrch().pause());
    return new Promise((_res, rej) => {
      const onAbort = () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); };
      if (ctx.signal.aborted) onAbort(); else ctx.signal.addEventListener('abort', onAbort, { once: true });
    });
  };
}

test('a paused agent turn is counted with its tokens and a lower bound apart, never booked', { timeout: 60_000 }, async () => {
  let orch;
  orch = createOrchestrator({
    projectDir: gitDir('cut-turns'), prompt: 'demo', auto: true, claude: { mock: true, model: 'claude-sonnet-5-5' },
    runners: { producer: pausingProducer(() => orch) },
  });
  const res = await orch.run();
  assert.equal(res.status, 'paused');
  const st = orch.getState();
  const cut = st.steps.find((s) => s.stoppedTurns);
  assert.ok(cut, 'the paused step carries its cut turns');
  assert.equal(cut.stoppedTurns.turns, 1, 'one message, counted once (not per content block)');
  assert.equal(cut.stoppedTurns.tokens, 21000);
  assert.ok(Math.abs(cut.stoppedTurns.floorUsd - 0.05) < 1e-9, `the sonnet list-price floor: ${cut.stoppedTurns.floorUsd}`);   // 20000×$2 + 1000×$10 per Mtok
  assert.equal(cut.costUsd, 0.2, 'the step cost holds only what a result booked');
  assert.equal(st.totalCostUsd, 0.2, 'the lower bound never reaches the total');
  const ledger = prepare('SELECT SUM(amount_usd) AS s FROM cost_ledger WHERE pipeline_id = ?').get(st.id);
  assert.ok(Math.abs(ledger.s - 0.2) < 1e-9, `ledger ${ledger.s}: the lower bound never reaches the ledger`);
  const back = readPipelineForResume(st.id).steps.find((s) => s.key === cut.key);
  assert.deepEqual(back.stoppedTurns, cut.stoppedTurns, 'stoppedTurns rides exec_meta');
});

test('a turn its result priced is not counted again', { timeout: 60_000 }, async () => {
  const producer = async (ctx) => {
    ctx.onEvent({ type: 'assistant', raw: { type: 'assistant', message: { id: 'msg_ok', usage: { input_tokens: 500, output_tokens: 50 } } } });
    ctx.onEvent({ type: 'result', costUsd: 0.1, raw: { type: 'result', total_cost_usd: 0.1, usage: { input_tokens: 500, output_tokens: 50 } } });
    const outputs = {};
    for (const p of ctx.ports?.outputs || []) outputs[p.id] = { path: ctx.outputs?.[p.id]?.path ?? null, type: p.type };
    return { outputs, verdict: ctx.verdict ? { issues: [], summary: '' } : null, summary: 'x' };
  };
  const orch = createOrchestrator({ projectDir: gitDir('cut-turns-ok'), prompt: 'demo', auto: true, claude: { mock: true, model: 'claude-sonnet-5-5' }, runners: { producer } });
  await orch.run();
  assert.deepEqual(orch.getState().steps.filter((s) => s.stoppedTurns).map((s) => s.key), []);
});

test('sub-agent frames are not counted, and a model with no list price is counted but not priced', () => {
  const orch = createOrchestrator({ projectDir: join(tmpdir(), 'worca-cut-unit'), claude: { mock: true } });
  orch._persist = async () => {};
  orch.state.steps.push({ key: 'n_x:1', executionId: 'n_x:1', nodeId: 'n_x', costUsd: 0 });
  const attr = { stepKey: 'n_x:1', executionId: 'n_x:1', model: 'some-unpriced-model' };
  orch._onAgentEvent('producer', { type: 'assistant', raw: { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 100, output_tokens: 10 } } } }, attr);
  orch._onAgentEvent('producer', { type: 'assistant', raw: { type: 'assistant', parent_tool_use_id: 'tu1', message: { id: 's1', usage: { input_tokens: 9000, output_tokens: 900 } } } }, attr);
  orch._closeOpenTurns('n_x:1');
  assert.deepEqual(orch.state.steps[0].stoppedTurns, { turns: 1, tokens: 110, floorUsd: null });
  assert.equal(orch.state.steps[0].costUsd, 0);
  assert.equal(orch.state.totalCostUsd, 0);
});

test('no model configured (the CLI\'s default): the lower bound is priced at the model the cut message named', () => {
  const orch = createOrchestrator({ projectDir: join(tmpdir(), 'worca-cut-default'), claude: { mock: true } });
  orch._persist = async () => {};
  for (const k of ['n_a:1', 'n_b:1', 'n_c:1']) orch.state.steps.push({ key: k, executionId: k, nodeId: k.split(':')[0], costUsd: 0 });
  const u = { input_tokens: 20000, output_tokens: 1000 };
  const cutTurn = (key, model, msgModel) => {
    const message = { id: `m_${key}`, ...(msgModel ? { model: msgModel } : {}), usage: u };
    orch._onAgentEvent('producer', { type: 'assistant', raw: { type: 'assistant', message } }, { stepKey: key, executionId: key, model });
    orch._closeOpenTurns(key);
    return orch.state.steps.find((s) => s.key === key).stoppedTurns;
  };
  const named = cutTurn('n_a:1', null, 'claude-sonnet-5-5-20260928');            // a dated id prices as its base row
  assert.ok(Math.abs(named.floorUsd - 0.05) < 1e-9, `priced at the streamed message.model: ${named.floorUsd}`);   // 20000×$2 + 1000×$10 per Mtok
  assert.deepEqual(cutTurn('n_b:1', null, null), { turns: 1, tokens: 21000, floorUsd: null }, 'no model anywhere: counted, not priced');
  const configured = cutTurn('n_c:1', 'claude-sonnet-5-5', 'claude-opus-5-5');
  assert.ok(Math.abs(configured.floorUsd - 0.05) < 1e-9, `the configured model wins over the streamed one (opus: 0.1): ${configured.floorUsd}`);
  assert.equal(orch.state.totalCostUsd, 0, 'a lower bound never reaches the total');
});

// ── a BRIDGED node (OpenRouter and friends): the upstream priced the requests it answered ───────
// The bridge books the upstream's usage.cost under the execution id as each request completes, so a
// spawn a pause kills mid-turn has a REAL figure waiting under its tag — the result path would have
// read it (run-harness _onAgentEvent); the flush must, or the spend is neither booked nor floored.
let home; const prev = {};
before(async () => {
  home = await mkdtemp(join(tmpdir(), 'worca-cut-bridged-'));
  for (const k of ['HOME', 'USERPROFILE', 'WORCA_TEST_ALLOW_HOME_FALLBACK']) prev[k] = process.env[k];
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.WORCA_TEST_ALLOW_HOME_FALLBACK = '1';
  await addGlobalModel({ id: 'or-qwen', upstream: { provider: 'openai', api: 'openai-chat', model: 'qwen/qwen3.8-27b', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-x' } });
});
after(async () => {
  for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  await rm(home, { recursive: true, force: true, maxRetries: 3 });
});

test('a bridged node cut mid-turn books what its upstream reported (never a floor), folds its request counters, forgets the tag', () => {
  _resetBridgeTelemetry();
  const orch = createOrchestrator({ projectDir: join(tmpdir(), 'worca-cut-bridged'), claude: { mock: true } });
  orch._persist = async () => {};
  orch.state.steps.push({ key: 'x:n_impl:1', executionId: 'x:n_impl:1', nodeId: 'n_impl', costUsd: 0 });
  const attr = { stepKey: 'x:n_impl:1', executionId: 'x:n_impl:1', model: 'or-qwen' };
  recordBridgeCall({ tag: 'x:n_impl:1', catalogId: 'or-qwen', provider: 'openai', api: 'openai-chat', initiator: 'user' });
  recordBridgeCost({ tag: 'x:n_impl:1', costUsd: 0.0123 });
  orch._onAgentEvent('implementer', { type: 'assistant', raw: { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 9000, output_tokens: 1 } } } }, attr);
  recordBridgeCall({ tag: 'x:n_impl:1', catalogId: 'or-qwen', provider: 'openai', api: 'openai-chat', initiator: 'agent' });
  recordBridgeCost({ tag: 'x:n_impl:1', costUsd: 0.0201 });
  orch._onAgentEvent('implementer', { type: 'assistant', raw: { type: 'assistant', message: { id: 'm2', usage: { input_tokens: 12000, output_tokens: 1 } } } }, attr);
  orch._closeOpenTurns('x:n_impl:1');                       // what _execStep('paused') does
  const s = orch.state.steps[0];
  assert.equal(s.costUsd, 0.0324, 'the upstream figure is booked, like the result path books it');
  assert.equal(orch.state.totalCostUsd, 0.0324);
  assert.equal(s.stoppedTurns, undefined, 'turns the upstream priced are not counted as cut');
  assert.deepEqual([s.bridgeCalls, s.bridgeContinued], [1, 1], 'the request counters are folded too');
  assert.equal(bridgeCostFor('x:n_impl:1'), null, 'the tag is forgotten: a resumed spawn starts from zero');
});

test('a fresh execution leaves its bridge tag alone at start; a retry of it closes what the failed attempt left', () => {
  _resetBridgeTelemetry();
  const orch = createOrchestrator({ projectDir: join(tmpdir(), 'worca-cut-fresh'), claude: { mock: true } });
  orch._persist = async () => {};
  const ctx = { executionId: 'x:n_impl:1', nodeId: 'n_impl', ordinal: 1, uiPhase: 'implement', node: { id: 'n_impl', kind: 'agent', key: 'implementer' } };
  // Execution ids repeat across runs (x:<node>:<ordinal>) and the bridge books by that bare id: another
  // live run of the same workflow may be mid-turn under it.
  recordBridgeCall({ tag: 'x:n_impl:1', catalogId: 'or-qwen', provider: 'openai', api: 'openai-chat', initiator: 'user' });
  recordBridgeCost({ tag: 'x:n_impl:1', costUsd: 0.0123 });
  orch._execStep(ctx, 'start');
  assert.equal(bridgeCostFor('x:n_impl:1')?.costUsd, 0.0123, 'a fresh row takes nothing it did not spend');
  assert.equal(orch.state.totalCostUsd, 0);
  orch._execStep(ctx, 'start');                                   // the retry re-entry (_runNodeAttempts)
  assert.equal(bridgeCostFor('x:n_impl:1'), null);
  assert.equal(orch.state.steps[0].costUsd, 0.0123, 'a re-entered row books what its earlier attempt left under the tag');
});

test('an upstream figure the result booked is never booked again by the flush', () => {
  _resetBridgeTelemetry();
  const orch = createOrchestrator({ projectDir: join(tmpdir(), 'worca-cut-once'), claude: { mock: true } });
  orch._persist = async () => {};
  orch.state.steps.push({ key: 'x:n_impl:1', executionId: 'x:n_impl:1', nodeId: 'n_impl', costUsd: 0 });
  const attr = { stepKey: 'x:n_impl:1', executionId: 'x:n_impl:1', model: 'or-qwen' };
  // A cost under the tag with no counted call (the call and cost maps evict apart at MAX_TAGS), so
  // _recordBridgeCalls keeps the tag.
  recordBridgeCost({ tag: 'x:n_impl:1', costUsd: 0.3 });
  orch._onAgentEvent('implementer', { type: 'result', costUsd: 0, raw: { type: 'result', total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 5 } } }, attr);
  assert.equal(orch.state.steps[0].costUsd, 0.3, 'the result books the upstream figure');
  orch._closeOpenTurns('x:n_impl:1');                       // the 'done' mark's flush
  assert.equal(orch.state.steps[0].costUsd, 0.3, 'and the flush never books it again');
  assert.equal(orch.state.totalCostUsd, 0.3);
  assert.equal(bridgeCostFor('x:n_impl:1'), null);
});
