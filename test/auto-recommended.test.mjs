// test/auto-recommended.test.mjs
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator } from '../src/core/orchestrator.mjs';
import { autoChoice, autoAnswerPayload } from '../src/core/run-harness.mjs';
import { useTempHome } from './helpers/temp-home.mjs';

useTempHome(after);
// settings.json is read from $HOME/.worca-cc: a developer's own night settings must not
// change what --yes answers here.
let home; const prev = {};
before(async () => {
  home = await mkdtemp(join(tmpdir(), 'worca-auto-rec-'));
  for (const k of ['HOME', 'USERPROFILE']) { prev[k] = process.env[k]; process.env[k] = home; }
});
after(async () => {
  for (const k of ['HOME', 'USERPROFILE']) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  await rm(home, { recursive: true, force: true, maxRetries: 3 });
});

test('--yes answers recommended when present, else the first option', async () => {
  const orch = createOrchestrator({ projectDir: '/tmp/proj-auto-rec', auto: true });
  const out = await orch._ask({ id: 'c1', kind: 'clarify', questions: [
    { id: 'a', question: 'A?', options: ['x', 'y'], confidence: [30, 70], recommended: 'y' },
    { id: 'b', question: 'B?', options: ['p', 'q'] },
  ] });
  assert.deepEqual(out.answers, [{ id: 'a', choice: 'y' }, { id: 'b', choice: 'p' }]);
});

test('autoChoice ignores a recommendation that is not an option and skips blanks', () => {
  assert.equal(autoChoice({ options: ['  ', 'p'], recommended: 'z' }), 'p');
  assert.equal(autoChoice({ options: [] }), 'auto');
});

test('autoAnswerPayload mirrors the --yes answer per kind', () => {
  assert.deepEqual(autoAnswerPayload({ kind: 'clarify', questions: [{ id: 'a', options: ['x', 'y'], recommended: 'y' }] }),
    { answers: [{ id: 'a', choice: 'y' }] });
  assert.deepEqual(autoAnswerPayload({ kind: 'questions', questions: [{ id: 'b', options: ['p'] }] }),
    { answers: [{ id: 'b', choice: 'p' }] });
  assert.deepEqual(autoAnswerPayload({ kind: 'form', form: 'f', version: 2, autoValues: { a: 1 } }),
    { form: 'f', version: 2, values: { a: 1 } });
  assert.deepEqual(autoAnswerPayload({ kind: 'recovery' }), { decision: 'pause' });
  assert.deepEqual(autoAnswerPayload({ kind: 'workflow', workflow: { name: 'wf' } }), { decision: 'accept', name: 'wf', nodes: {} });
  assert.deepEqual(autoAnswerPayload({ kind: 'gate' }), { decision: 'continue' });
});
