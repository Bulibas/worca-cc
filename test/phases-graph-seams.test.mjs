// test/phases-graph-seams.test.mjs
// The five prompt-library seams the v2 executor imports from phases.mjs, plus the
// extracted reviewer diff sentence. These are EXPORT-ONLY additions: the pins here
// are the exact live bytes, so a reword of any of them fails here first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mockMarkers, runOpts, diffInstruction,
  READ_WRITE_TOOLS, IMPLEMENTER_TOOLS, RESUME_HEADER,
} from '../src/core/phases.mjs';

test('mockMarkers renders KEY: value lines, keeps 0, and drops empty values', () => {
  assert.equal(
    mockMarkers({ MOCK_ROLE: 'refiner', MOCK_CYCLE: 2, MOCK_PRIOR: 0, MOCK_OUT: '', MOCK_JSON: null, MOCK_IN: undefined }),
    'MOCK_ROLE: refiner\nMOCK_CYCLE: 2\nMOCK_PRIOR: 0',
  );
});

test('diffInstruction: the checkpoint-ref arm names the ref, the bare arm does not', () => {
  assert.equal(
    diffInstruction({ checkpointRef: 'abc1234' }),
    'Inspect the diff with `git diff abc1234` (the orchestrator\'s pre-implementation ' +
    'checkpoint) and `git status` in your cwd. New/untracked files are intent-to-added, ' +
    'so they DO appear in that diff; use `git status` to cross-check.',
  );
  assert.equal(
    diffInstruction({}),
    'Inspect the diff with `git diff` and `git status` in your cwd. If `git diff` looks ' +
    'empty, the changes may be newly-created files — confirm with `git status` and ' +
    '`git diff HEAD`.',
  );
  assert.equal(diffInstruction({ checkpointRef: '   ' }), diffInstruction({}));
  assert.equal(diffInstruction(undefined), diffInstruction({}));
});

test('runOpts is exported and still applies RESUME_HEADER + frontmatter tools', () => {
  const o = runOpts(
    { projectDir: '/p', resumeSessionId: 's1', node: { tools: ['mcp__x__y'], fanOut: false }, claudeOpts: { mock: true } },
    { role: 'r', prompt: 'BODY', systemPrompt: 'SYS', allowedTools: READ_WRITE_TOOLS },
  );
  assert.equal(o.cwd, '/p');
  assert.equal(o.prompt, RESUME_HEADER + 'BODY');
  assert.ok(o.allowedTools.includes('mcp__x__y'), 'frontmatter tools are unioned in');
  assert.deepEqual(o.allowedTools.slice(0, READ_WRITE_TOOLS.length), READ_WRITE_TOOLS);
  assert.equal(o.mock, true);
});

test('the two baseline tool lists are the ones the v2 executor will branch on', () => {
  assert.deepEqual(READ_WRITE_TOOLS, ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Skill']);
  assert.deepEqual(IMPLEMENTER_TOOLS, ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Grep', 'Glob', 'Skill']);
});
