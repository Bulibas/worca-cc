import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directionsPromptBlock, runOpts } from '../src/core/phases.mjs';

test('directionsPromptBlock is "" without pending directions (prompt snapshots untouched)', () => {
  assert.equal(directionsPromptBlock({}), '');
  assert.equal(directionsPromptBlock({ directionsPending: [] }), '');
});
test('runOpts appends the block after the questions block', () => {
  const ctx = { projectDir: '/p', claudeOpts: {}, executionId: 'x:n_build:2',
    directionsPending: [{ id: 'd1', ts: 't', source: 'ui', text: 'cut the roadmap' }] };
  const o = runOpts(ctx, { role: 'producer', prompt: 'BODY', systemPrompt: '', allowedTools: ['Read'] });
  assert.match(o.prompt, /^BODY/);
  assert.match(o.prompt, /## New directions since the last step/);
  assert.match(o.prompt, /\*\*d1\*\*/);
  assert.match(o.prompt, /"consumedBy":"x:n_build:2"/);
});

// The agent's cwd is the project worktree, not the run folder, so "append a line
// to directions.ndjson in the pipeline directory" without the path most likely
// creates the file in the user's repo. _reconcileDirections then finds no
// consumption record and every honored direction is reported as never applied.
test('the block names the ABSOLUTE directions.ndjson path, not "the pipeline directory"', () => {
  const block = directionsPromptBlock({
    executionId: 'x:n_build:2',
    pipelineDir: '/home/u/.worca-cc/store/proj-abcd1234/pipelines/17-09-26-deck-96def123',
    directionsPending: [{ id: 'd1', ts: 't', source: 'ui', text: 'cut the roadmap' }],
  });
  assert.match(block, /\/home\/u\/\.worca-cc\/store\/proj-abcd1234\/pipelines\/17-09-26-deck-96def123\/directions\.ndjson/);
  assert.doesNotMatch(block, /`directions\.ndjson` in the pipeline directory/);
});

test('with no pipelineDir the block still renders and still names the file', () => {
  const block = directionsPromptBlock({
    executionId: 'x:n_build:2',
    directionsPending: [{ id: 'd1', ts: 't', source: 'ui', text: 'cut the roadmap' }],
  });
  assert.match(block, /directions\.ndjson/);
  assert.match(block, /\*\*d1\*\*/);
});
