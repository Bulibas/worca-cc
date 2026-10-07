// test/harness-drain.test.mjs
// B2: RunHarness.pauseForDrain() — a run paused because the server is stopping saves its resume
// point with pauseReason 'drain' and, after a resume, the person who resumed it (resumeAs), which
// B3's auto-resume bills the next start to.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempHome } from './helpers/temp-home.mjs';
import { createOrchestrator } from '../src/core/orchestrator.mjs';
import { readPipelineForResume } from '../src/core/artifacts.mjs';
import { autoResumeCandidates } from '../src/core/drain.mjs';
import { gitDir } from './helpers/git-dir.mjs';

useTempHome(after);

function outsOf(ctx) {
  const o = {};
  for (const p of ctx.ports.outputs || []) o[p.id] = { path: ctx.outputs?.[p.id]?.path ?? null, type: p.type };
  return o;
}
const okVerifier = async (ctx) => ({ outputs: outsOf(ctx), verdict: { issues: [], summary: '' }, summary: '' });
const okClarifier = async (ctx) => ({ outputs: outsOf(ctx), verdict: null, summary: '' });

/** A producer that calls `stop(orch)` on its first execution, then hangs until aborted. */
function stopsOnce(getOrch, stop) {
  let fired = false;
  return async (ctx) => {
    if (fired) return { outputs: outsOf(ctx), verdict: null, summary: 'ok' };
    fired = true;
    queueMicrotask(() => stop(getOrch()));
    return new Promise((_r, rej) => {
      const onAbort = () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); };
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });
    });
  };
}

test('pauseForDrain parks the run with reason drain; after a resume the point names who resumed it', { timeout: 120000 }, async () => {
  const dir = gitDir('hdrain');
  let orch;
  let drained = null;
  orch = createOrchestrator({
    projectDir: dir, workflowId: 'wf_default', prompt: 'demo', auto: true, claude: { mock: true },
    runners: { producer: stopsOnce(() => orch, (o) => { drained = o.pauseForDrain(); }), verifier: okVerifier, clarifier: okClarifier },
  });
  const first = await orch.run();
  assert.equal(drained, true);
  assert.equal(first.status, 'paused');
  assert.equal(first.reason, 'drain');
  let saved = readPipelineForResume(orch.getState().id);
  assert.equal(saved.row.status, 'paused');
  assert.equal(saved.resumePoint.pauseReason, 'drain');
  assert.equal(saved.resumePoint.resumeAs, undefined, 'never resumed: the starter (started_by) is billed');
  assert.equal(orch.pauseForDrain(), false, 'only a running run pauses');

  // Resumed by ada, drained again: the point remembers ada.
  let orch2;
  orch2 = createOrchestrator({
    projectDir: dir, auto: true, claude: { mock: true }, resume: saved, resumedBy: 'ada@example.com',
    runners: { producer: stopsOnce(() => orch2, (o) => o.pauseForDrain()), verifier: okVerifier, clarifier: okClarifier },
  });
  const second = await orch2.resume();
  assert.equal(second.status, 'paused');
  saved = readPipelineForResume(orch2.getState().id);
  assert.equal(saved.resumePoint.pauseReason, 'drain');
  assert.equal(saved.resumePoint.resumeAs, 'ada@example.com');
  const picks = autoResumeCandidates([{ ...saved.row, resumePoint: saved.resumePoint }]);
  assert.deepEqual(picks.map((p) => [p.why, p.by]), [['drain', 'ada@example.com']]);
});

test('a person\'s own pause is not a drain: no reason, nothing for auto-resume', { timeout: 120000 }, async () => {
  const dir = gitDir('hdrain-manual');
  let orch;
  orch = createOrchestrator({
    projectDir: dir, workflowId: 'wf_default', prompt: 'demo', auto: true, claude: { mock: true },
    runners: { producer: stopsOnce(() => orch, (o) => o.pause('bob@example.com')), verifier: okVerifier, clarifier: okClarifier },
  });
  const first = await orch.run();
  assert.equal(first.status, 'paused');
  const saved = readPipelineForResume(orch.getState().id);
  assert.equal(saved.resumePoint.pauseReason ?? null, null);
  assert.deepEqual(autoResumeCandidates([{ ...saved.row, resumePoint: saved.resumePoint }]), []);
});
