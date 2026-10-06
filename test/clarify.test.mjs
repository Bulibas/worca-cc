// test/clarify.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildClarifyPrompt } from '../src/core/phases.mjs';
import { useTempHome } from './helpers/temp-home.mjs';
import { checkRows } from './helpers/rows.mjs';

useTempHome(after); // store writes -> isolated temp home, not real ~/.worca-cc

function fakeCtx(dir) {
  return {
    projectDir: dir,
    pipelineDir: dir,
    taskPrompt: 'demo task',
    toolInstruction: '',
    agentPrompts: { clarify: '' },
    claudeOpts: { mock: true },
    signal: undefined,
    onEvent: () => {},
  };
}

test('buildClarifyPrompt: round 2 re-injects prior answers and forbids re-asking; round 1 omits the section', async () => {
  await checkRows([
    { name: 'buildClarifyPrompt re-injects prior answers and forbids re-asking', run: () => {
      const prompt = buildClarifyPrompt(fakeCtx('/p'), {
        round: 2,
        priorAnswers: [{ id: 'sess', question: 'Where to store sessions?', choice: 'Redis' }],
      });
      assert.match(prompt, /DO NOT ask these again/);
      assert.match(prompt, /Where to store sessions\?/);
      assert.match(prompt, /Redis/);
      assert.match(prompt, /MOCK_PRIOR: 1/);
    } },
    { name: 'buildClarifyPrompt omits the answered section on the first round', run: () => {
      const prompt = buildClarifyPrompt(fakeCtx('/p'), { round: 1, priorAnswers: [] });
      assert.doesNotMatch(prompt, /DO NOT ask these again/);
      assert.match(prompt, /MOCK_PRIOR: 0/);
    } },
  ]);
});

import { normalizeClarify } from '../src/core/protocol.mjs';

test('normalizeClarify: caps at 8 questions and 2–4 options, never pads', async () => {
  await checkRows([
    { name: 'normalizeClarify caps questions at MAX_CLARIFY_QUESTIONS (8)', run: () => {
      const many = {
        questions: Array.from({ length: 12 }, (_, i) => ({
          id: `q${i}`,
          question: `Question ${i}?`,
          options: ['a', 'b', 'c'],
        })),
      };
      const out = normalizeClarify(many);
      assert.equal(out.questions.length, 8);
    } },
    { name: 'normalizeClarify allows 2–4 options and never pads', run: () => {
      const out = normalizeClarify({
        questions: [
          { id: 'binary', question: 'A or B?', options: ['A', 'B'] },                 // 2 kept
          { id: 'triple', question: 'Three?', options: ['x', 'y', 'z'] },             // 3 kept
          { id: 'quad',   question: 'Four?',  options: ['1', '2', '3', '4'] },        // 4 kept
          { id: 'over',   question: 'Five?',  options: ['1', '2', '3', '4', '5'] },   // capped to 4
          { id: 'blanks', question: 'Blanks?', options: ['real', '', '  ', 'b'] },    // blanks dropped
        ],
      });
      assert.deepEqual(out.questions[0].options, ['A', 'B']);
      assert.deepEqual(out.questions[1].options, ['x', 'y', 'z']);
      assert.deepEqual(out.questions[2].options, ['1', '2', '3', '4']);
      assert.deepEqual(out.questions[3].options, ['1', '2', '3', '4']);
      assert.deepEqual(out.questions[4].options, ['real', 'b']);
      assert.ok(out.questions.every((q) => q.allowFreeText === true)); // still forced true
    } },
  ]);
});
