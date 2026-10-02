// test/night-store.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTempHome } from './helpers/temp-home.mjs';
import { seedPipeline } from './helpers/db-seed.mjs';
import { recordCostDelta } from '../src/core/cost-budget.mjs';
import { writeNightDecision, readNightDecisions, nightSpendSinceUsd, countNightDecisions, nightCounts, nightGateCycles, nightAnsweredSince } from '../src/core/night/store.mjs';

useTempHome(after);
const dirs = [];
async function tmpProject() { const d = await mkdtemp(join(tmpdir(), 'worca-cc-nstore-')); dirs.push(d); return d; }
after(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

test('night decisions round-trip in order; counters derive from rows', async () => {
  const { id: pid } = await seedPipeline(await tmpProject());
  writeNightDecision(pid, { questionId: 'gate-w1-3', kind: 'gate', choice: 'another', strategy: 'rule', flagged: false, meta: { wireId: 'w1' } });
  writeNightDecision(pid, { questionId: 'clarify-n-1', kind: 'clarify', choice: 'A', strategy: 'weights', confidence: 80, flagged: true, rationale: 'r' });
  writeNightDecision(pid, { questionId: 'cost-cap-pipeline', kind: 'cost-cap', choice: 'continue', strategy: 'rule', flagged: true });
  writeNightDecision(pid, { questionId: 'clarify-n-2', kind: 'clarify', choice: null, strategy: 'guardrail', flagged: true, guardrail: 'maxDecisions' });
  const rows = readNightDecisions(pid);
  assert.deepEqual(rows.map((r) => r.questionId), ['gate-w1-3', 'clarify-n-1', 'cost-cap-pipeline', 'clarify-n-2']);
  assert.equal(countNightDecisions(pid), 2, 'cost-cap overrides and guardrail rows do not count');
  assert.equal(nightGateCycles(pid, 'w1'), 1);
  assert.equal(nightGateCycles(pid, 'w2'), 0);
  assert.equal(rows[1].flagged, true);
  assert.equal(rows[1].confidence, 80);
  assert.equal(rows[0].flagged, false);
  assert.deepEqual(readNightDecisions(null), []);
  assert.equal(countNightDecisions(null), 0);
  assert.deepEqual(nightCounts(pid), { decisions: 2, flagged: 3 }, 'flagged counts every flagged row');
  assert.deepEqual(nightCounts(null), { decisions: 0, flagged: 0 });
});

test('nightSpendSinceUsd sums cost_ledger across all pipelines since the anchor (ts is epoch ms)', async () => {
  const { id: pidA } = await seedPipeline(await tmpProject());
  const { id: pidB } = await seedPipeline(await tmpProject());
  const t0 = Date.now();
  recordCostDelta({ pipelineId: pidA, stepKey: 'x:a:1', amountUsd: 1.5, tsMs: t0 - 10 * 60_000 });
  recordCostDelta({ pipelineId: pidB, stepKey: 'x:b:1', amountUsd: 2, tsMs: t0 - 30_000 });
  recordCostDelta({ pipelineId: pidB, stepKey: 'x:b:1', amountUsd: 9, tsMs: t0 - 3_600_000 });   // before the anchor
  assert.equal(nightSpendSinceUsd(t0 - 20 * 60_000), 3.5);
});

test('nightAnsweredSince: answers across every run since a moment, and how many to check', async () => {
  const t0 = Date.now() - 1000;
  const { id: a } = await seedPipeline(await tmpProject());
  const { id: b } = await seedPipeline(await tmpProject());
  writeNightDecision(a, { questionId: 'q1', kind: 'clarify', choice: 'A', strategy: 'weights', flagged: true });
  writeNightDecision(b, { questionId: 'q2', kind: 'gate', choice: 'another', strategy: 'rule', flagged: false });
  writeNightDecision(b, { questionId: 'cost-cap-pipeline', kind: 'cost-cap', choice: 'continue', strategy: 'rule', flagged: true });
  writeNightDecision(b, { questionId: 'q3', kind: 'clarify', choice: null, strategy: 'guardrail', flagged: true, guardrail: 'maxDecisions' });
  const got = nightAnsweredSince(t0);
  assert.ok(got.answered >= 2 && got.flagged >= 1);
  assert.deepEqual(nightAnsweredSince(Date.now() + 60_000), { answered: 0, flagged: 0 }, 'nothing after now');
});
