// test/clarify-recommendation.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeClarify, scaleConfidence } from '../src/core/protocol.mjs';
import { writeStepQuestions, readStepQuestions } from '../src/core/artifacts.mjs';
import { useTempHome } from './helpers/temp-home.mjs';
import { seedPipeline } from './helpers/db-seed.mjs';
import { checkRows } from './helpers/rows.mjs';

useTempHome(after);

const one = (q) => normalizeClarify({ questions: [{ id: 'q', question: 'Pick?', ...q }] }).questions[0];

test('confidence stays aligned when blank options are dropped', () => {
  const q = one({ options: ['A', '  ', 'B', 'C'], confidence: [10, 50, 30, 10] });
  assert.deepEqual(q.options, ['A', 'B', 'C']);
  // zipped BEFORE the drop: A=10, B=30, C=10 → scaled to 100 → 20/60/20
  assert.deepEqual(q.confidence, [20, 60, 20]);
  assert.equal(q.recommended, 'B');
});

test('confidence is dropped when its length differs from the raw options, has a non-finite entry, or is all zero', async () => {
  await checkRows([
    { name: 'confidence is dropped when its length differs from the RAW options', run: () => {
      const q = one({ options: ['A', 'B'], confidence: [70] });
      assert.equal(q.confidence, undefined);
      assert.equal(q.recommended, undefined);
    } },
    { name: 'non-finite entries drop confidence', run: () => {
      assert.equal(one({ options: ['A', 'B'], confidence: [1, NaN] }).confidence, undefined);
      assert.equal(one({ options: ['A', 'B'], confidence: [1, '2'] }).confidence, undefined);
    } },
    { name: 'all-zero confidence is dropped', run: () => {
      assert.equal(one({ options: ['A', 'B'], confidence: [0, -1] }).confidence, undefined);
    } },
  ]);
});

test('negatives clamp to 0, integers sum to exactly 100, remainder on the largest (first on ties)', () => {
  const q = one({ options: ['A', 'B', 'C'], confidence: [1, 1, 1] });
  assert.deepEqual(q.confidence, [34, 33, 33]);
  assert.deepEqual(one({ options: ['A', 'B'], confidence: [-5, 3] }).confidence, [0, 100]);
});

test('recommended: agent pick when it is an option, else highest (first on ties)', () => {
  assert.equal(one({ options: ['A', 'B'], confidence: [40, 60], recommended: 'A' }).recommended, 'A');
  assert.equal(one({ options: ['A', 'B'], confidence: [50, 50], recommended: 'Z' }).recommended, 'A');
  assert.equal(one({ options: ['A', 'B'], recommended: 'A' }).recommended, undefined, 'no confidence → no recommended');
});

test('the 4-option cap keeps confidence aligned and rescales', () => {
  const q = one({ options: ['A', 'B', 'C', 'D', 'E'], confidence: [10, 10, 10, 10, 60] });
  assert.deepEqual(q.options, ['A', 'B', 'C', 'D']);
  assert.deepEqual(q.confidence, [25, 25, 25, 25]);
});

test('step questions round-trip confidence and recommended', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'worca-cc-rec-'));
  after(() => rm(dir, { recursive: true, force: true }));
  const { id } = await seedPipeline(dir);
  const q = one({ options: ['A', 'B'], confidence: [30, 70], recommended: 'B' });
  await writeStepQuestions(id, '1:s0_0', 1, { agentKey: 'planner', nodeId: 's0_0', questions: { questions: [q] } });
  const [row] = readStepQuestions(id);
  assert.deepEqual(row.questions[0].confidence, [30, 70]);
  assert.equal(row.questions[0].recommended, 'B');
});

test('scaleConfidence keeps exact integer shares (no float drift) and survives huge values', () => {
  assert.deepEqual(scaleConfidence([29, 71]), [29, 71]);
  assert.deepEqual(scaleConfidence([57, 43]), [57, 43]);
  assert.deepEqual(scaleConfidence([1e308, 1e308]), [50, 50]);
  assert.equal(scaleConfidence([Infinity, 1]), null);
});
