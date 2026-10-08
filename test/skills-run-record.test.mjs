// test/skills-run-record.test.mjs — skills registry design §4.3 / §6 board 9: a finished run's History
// detail carries its run.json.skillMount (the durable copy in the run dir), and null without one.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempHome } from './helpers/temp-home.mjs';
import { skillSetFixture, scratchGitDir as gitDir } from './helpers/skill-sets.mjs';
import { createOrchestrator } from '../src/core/orchestrator.mjs';
import { readPipeline } from '../src/core/artifacts.mjs';
import { readRunManifest } from '../src/core/run-manifest.mjs';

useTempHome(after);
const ok = { producer: async () => ({ status: 'ok', summary: 'ok' }), verifier: async () => ({ status: 'ok', issues: [], review: { issues: [] }, summary: '' }) };

test('History detail: skillMount from the run\'s run.json; null for a run without set skills', async () => {
  const { dir, set } = await skillSetFixture();
  const orch = createOrchestrator({ projectDir: dir, prompt: 'x', auto: true, claude: { mock: true }, runners: ok });
  assert.equal((await orch.run()).status, 'done');
  const saved = await readPipeline(dir, orch.state.id);
  assert.deepEqual(saved.skillMount, (await readRunManifest(orch.getState().pipelineDir)).skillMount);
  assert.equal(saved.skillMount.plugins[0].pluginName, set.slug);
  const bare = gitDir('skills-record-none');
  const plain = createOrchestrator({ projectDir: bare, prompt: 'x', auto: true, claude: { mock: true }, runners: ok });
  assert.equal((await plain.run()).status, 'done');
  assert.equal((await readPipeline(bare, plain.state.id)).skillMount, null);
});
