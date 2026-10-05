// test/agents-questions-form.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempHome } from './helpers/temp-home.mjs';
import { createAgent, readAgent } from '../src/core/agent-store.mjs';
import { createAgentGen } from '../src/core/agent-gen.mjs';

useTempHome(after);

test('agent-store roundtrips the questions fields', async () => {
  await createAgent({
    meta: { key: 'qDemo', displayName: 'Q Demo', order: 99, metaVersion: 2, runnerType: 'producer',
      inputs: [{ id: 'task', type: 'md' }], outputs: [{ id: 'notes', type: 'md', filename: 'notes.md' }],
      asksQuestions: true, questionsLocked: false, questionsDefault: true },
    markdown: '# Q Demo\nbody\n',
  });
  const { meta } = await readAgent('qDemo');
  assert.equal(meta.asksQuestions, true);
  assert.equal(meta.questionsLocked, false);
  // Coherence: default requires asksQuestions (true here), so it survives.
  assert.equal(meta.questionsDefault, true);
});

test('mock agent-gen drafts carry the questions fields (normalized)', async () => {
  const gen = createAgentGen({ name: 'Docs Writer', purpose: 'write docs', claude: { mock: true } });
  const res = await gen.run();
  assert.equal(res.status, 'done');
  assert.equal(typeof res.draft.meta.asksQuestions, 'boolean');
  assert.equal(typeof res.draft.meta.questionsLocked, 'boolean');
  assert.equal(typeof res.draft.meta.questionsDefault, 'boolean');
});
