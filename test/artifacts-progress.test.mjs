// test/artifacts-progress.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempHome } from './helpers/temp-home.mjs';
import { seedPipeline } from './helpers/db-seed.mjs';
import { readRunProgress } from '../src/core/artifacts.mjs';
import { checkRows } from './helpers/rows.mjs';

useTempHome(after);

test('readRunProgress aggregates a run and returns null for an unknown one', async () => {
  await checkRows([
    { name: 'readRunProgress aggregates phase/status/phases/tasks/extras', run: async () => {
      const { id } = await seedPipeline(process.cwd(), { title: 'A', status: 'done', phase: 'review' });
      const p = await readRunProgress(id);
      assert.equal(p.runId, id);
      assert.equal(p.status, 'done');
      assert.ok(Array.isArray(p.phases));
      assert.ok(Array.isArray(p.tasks));
      assert.ok(p.clarify && Array.isArray(p.reviews) && Array.isArray(p.stepQuestions));
    } },
    { name: 'readRunProgress returns null for an unknown run', run: async () => {
      assert.equal(await readRunProgress('deadbeef'), null);
    } },
  ]);
});
