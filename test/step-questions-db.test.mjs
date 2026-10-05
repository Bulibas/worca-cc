// test/step-questions-db.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTempHome } from './helpers/temp-home.mjs';
import { seedPipeline } from './helpers/db-seed.mjs';
import { writeStepQuestions, readStepQuestions, readPipelineExtras } from '../src/core/artifacts.mjs';
import { checkRows } from './helpers/rows.mjs';

useTempHome(after);
const dirs = [];
async function tmpProject() { const d = await mkdtemp(join(tmpdir(), 'worca-cc-sq-')); dirs.push(d); return d; }
after(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

const QS = { questions: [{ id: 'q1', question: 'Pick?', options: ['A', 'B'], allowFreeText: true }] };
const AS = { answers: [{ id: 'q1', question: 'Pick?', choice: 'B' }] };

test('writeStepQuestions partial-upserts, orders by (stepKey, round), and is a no-op on missing args', async () => {
  await checkRows([
    { name: 'writeStepQuestions partial-upserts and readStepQuestions orders by (stepKey, round)', run: async () => {
      const { id } = await seedPipeline(await tmpProject());
      await writeStepQuestions(id, '1:s0_0', 1, { agentKey: 'planner', nodeId: 's0_0', questions: QS });
      await writeStepQuestions(id, '1:s0_0', 1, { agentKey: 'planner', nodeId: 's0_0', answers: AS }); // second call keeps questions
      await writeStepQuestions(id, '3:s2_0#2', 1, { agentKey: 'implementer', nodeId: 's2_0', questions: QS });
      const rows = readStepQuestions(id);
      assert.equal(rows.length, 2);
      assert.deepEqual(rows[0], {
        stepKey: '1:s0_0', round: 1, nodeId: 's0_0', agentKey: 'planner',
        questions: QS.questions, answers: AS.answers,
      });
      assert.deepEqual(rows[1].answers, []); // answers not yet written
      assert.equal(rows[1].nodeId, 's2_0');
    } },
    { name: 'writeStepQuestions is a no-op on missing args (never throws)', run: async () => {
      await writeStepQuestions('', 'k', 1, { questions: QS });
      await writeStepQuestions('p', '', 1, { questions: QS });
    } },
  ]);
});

test('readPipelineExtras carries stepQuestions; unknown pipeline yields []', async () => {
  const { id } = await seedPipeline(await tmpProject());
  await writeStepQuestions(id, '0:s_clarify', 1, { agentKey: 'clarify', nodeId: 's_clarify', questions: QS });
  const extras = readPipelineExtras(id);
  assert.equal(extras.stepQuestions.length, 1);
  assert.deepEqual(readStepQuestions('nope'), []);
});

test('answers-only partial call preserves previously written identity columns', async () => {
  const { id } = await seedPipeline(await tmpProject());
  await writeStepQuestions(id, '2:s1_0', 1, { agentKey: 'reviewer', nodeId: 's1_0', questions: QS });
  await writeStepQuestions(id, '2:s1_0', 1, { answers: AS }); // identity omitted
  const rows = readStepQuestions(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].nodeId, 's1_0', 'nodeId survives identity-omitting call');
  assert.equal(rows[0].agentKey, 'reviewer', 'agentKey survives identity-omitting call');
  assert.deepEqual(rows[0].answers, AS.answers);
});

test('a round night mode answered carries its night record; others gain no key', async () => {
  const { id } = await seedPipeline(await tmpProject());
  await writeStepQuestions(id, '1:s0_0', 1, { agentKey: 'planner', nodeId: 's0_0', questions: QS });
  await writeStepQuestions(id, '1:s0_0', 1, { answers: { ...AS, answeredBy: 'night-mode', night: { strategy: 'weights', flagged: false } } });
  await writeStepQuestions(id, '2:s1_0', 1, { agentKey: 'reviewer', nodeId: 's1_0', questions: QS });
  const [night, plain] = readStepQuestions(id);
  assert.deepEqual(night.night, { strategy: 'weights', flagged: false });
  assert.equal(night.answeredBy, 'night-mode');
  assert.equal('night' in plain, false);
});
