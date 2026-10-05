import test from 'node:test';
import assert from 'node:assert/strict';
import { taskHeader } from '../src/core/phases.mjs'; // now exported
import { checkRows } from './helpers/rows.mjs';

const base = { projectDir: '/p', pipelineDir: '/pipe', taskPrompt: 'BUILD THE THING' };

test('taskHeader includes the request block for userPrompt consumers, refiner/reviewer, the clarify pre-step and entry nodes', async () => {
  await checkRows([
    { name: 'userPrompt consumer gets the raw request block', run: () => {
      const h = taskHeader({ ...base, node: { key: 'planner' }, inputs: { userPrompt: { text: 'BUILD THE THING' } } }, 'Plan');
      assert.match(h, /## Original request/);
      assert.match(h, /BUILD THE THING/);
    } },
    { name: 'refiner & reviewer keep the request block even though they do not consume userPrompt', run: () => {
      for (const key of ['refiner', 'reviewer']) {
        const h = taskHeader({ ...base, node: { key }, inputs: { plan: { path: '/x.md' } } }, key);
        assert.match(h, /## Original request/, `${key} keeps request`);
      }
    } },
    { name: 'clarify pre-step (no inputs) still gets the prompt', run: () => {
      const h = taskHeader({ ...base }, 'Clarify'); // ctx.inputs === undefined, ctx.node === undefined
      assert.match(h, /## Original request/);
    } },
    { name: 'entry node (isEntry) gets the request block regardless of role', run: () => {
      for (const key of ['implementer', 'manualWebUiTesting']) {
        const h = taskHeader({ ...base, isEntry: true, node: { key }, inputs: { plan: { path: '/x.md' } } }, key);
        assert.match(h, /## Original request/, `${key} entry gets request`);
        assert.match(h, /BUILD THE THING/);
      }
    } },
  ]);
});

test('implementer/checklist/web-ui omit the request block', () => {
  for (const key of ['implementer', 'manualTestsChecklist', 'manualWebUiTesting']) {
    const h = taskHeader({ ...base, node: { key }, inputs: { plan: { path: '/x.md' } } }, key);
    assert.doesNotMatch(h, /## Original request/, `${key} omits request`);
    assert.match(h, /## Upstream input/);
    assert.doesNotMatch(h, /BUILD THE THING/, `${key} must not leak the prompt`);
  }
});

test('entry node lists attached files, and omits the section when there are none', async () => {
  await checkRows([
    { name: 'entry node lists attached files', run: () => {
      const h = taskHeader(
        { ...base, isEntry: true, node: { key: 'implementer' }, inputs: { plan: { path: '/x.md' } },
          extras: [{ name: 'spec.md', path: '/pipe/extras/spec.md' }] },
        'Implement',
      );
      assert.match(h, /## Attached files/);
      assert.match(h, /\/pipe\/extras\/spec\.md/);
    } },
    { name: 'entry node with no attachments omits the attachments section', run: () => {
      const h = taskHeader({ ...base, isEntry: true, node: { key: 'implementer' }, inputs: { plan: { path: '/x.md' } } }, 'Implement');
      assert.match(h, /## Original request/);
      assert.doesNotMatch(h, /## Attached files/);
    } },
  ]);
});
