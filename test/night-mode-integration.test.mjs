// test/night-mode-integration.test.mjs
// A real wf_default mock run (NOT --yes), opted into night mode per run: the mock
// clarifier's open question is decided after the grace timeout, by night-mode, and the
// decision reaches the clarify row, night_decisions and the run's actions.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator } from '../src/core/orchestrator.mjs';
import { readClarifyRow } from '../src/core/artifacts.mjs';
import { readNightDecisions } from '../src/core/night/store.mjs';
import { readRunActions } from '../src/core/ask/tool-deps.mjs';
import { setNightMode } from '../src/core/settings.mjs';
import { useTempHome } from './helpers/temp-home.mjs';

useTempHome(after);
let home; const prev = {};
const dirs = [];
before(async () => {
  home = await mkdtemp(join(tmpdir(), 'worca-night-home-'));
  for (const k of ['HOME', 'USERPROFILE']) { prev[k] = process.env[k]; process.env[k] = home; }
});
after(async () => {
  for (const k of ['HOME', 'USERPROFILE']) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  await rm(home, { recursive: true, force: true, maxRetries: 3 });
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 3 })));
});

function fakeClock(start = Date.parse('2026-09-27T12:00:00Z')) {
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

test('an open clarify question is decided after the grace timeout, by night-mode', async () => {
  await setNightMode({ enabled: false, graceMinutes: 5, window: null, strategy: 'weights' });
  const clock = fakeClock();
  const projectDir = await mkdtemp(join(tmpdir(), 'worca-night-proj-'));
  dirs.push(projectDir);
  const orch = createOrchestrator({ projectDir, workflowId: 'wf_default', prompt: 'demo task',
    claude: { mock: true }, nightMode: true, nightClock: clock });
  const asked = [];
  const stillOpen = [];
  orch.on('question', (q) => {
    asked.push(q);
    // Not answered by a human: advance past the grace deadline on the next tick.
    setImmediate(async () => {
      await clock.tick(4 * 60_000);
      stillOpen.push(orch.pendingQuestion?.id === q.id);
      await clock.tick(61_000);
    });
  });
  const res = await orch.run();
  assert.equal(res.status, 'done', res.error);

  const clarify = asked.find((q) => q.kind === 'clarify');
  assert.ok(clarify, 'the mock clarifier asked');
  assert.equal(stillOpen[0], true, 'still open before grace');
  assert.equal(orch.answeredBy(clarify.id), 'night-mode');

  const row = readClarifyRow(orch.pipeline.id);
  assert.equal(row.answers.answeredBy, 'night-mode');
  assert.equal(row.answers.night.strategy, 'weights');
  assert.equal(row.answers.night.flagged, true, 'no confidence → first option, flagged');
  assert.equal(row.answers.answers[0].choice, 'Fail fast with a clear error');

  const nd = readNightDecisions(orch.pipeline.id);
  assert.ok(nd.some((d) => d.questionId === clarify.id && d.kind === 'clarify'));

  const actions = readRunActions({ id: orch.pipeline.id });
  assert.ok(actions.some((a) => a.by === 'night-mode' && /answered/i.test(a.what)), 'audit/actions carry the night-mode actor');
});
