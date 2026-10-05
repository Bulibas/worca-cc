// test/report-reasons.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPT_IN_KEYS, OPT_IN_CLASSES,
  reasonById, normalizeInclude,
} from '../src/shared/report-reasons.mjs';
import { checkRows } from './helpers/rows.mjs';

test('exactly three opt-in classes; the diff and log lines are not among them', () => {
  assert.deepEqual(OPT_IN_KEYS, ['paths', 'prompt'], 'two classes, in modal order');
  assert.equal(OPT_IN_KEYS.includes('names'), false,
    'the run title, project key, branch and workspace names are ALWAYS in the report,\n     so there is nothing to opt into');
  for (const forbidden of ['diff', 'logs', 'log', 'patch']) {
    assert.equal(OPT_IN_KEYS.includes(forbidden), false, `"${forbidden}" must never be offerable`);
  }
  assert.equal(OPT_IN_CLASSES.length, 2, 'one descriptor per class');
});

test('reasonById / normalizeInclude: unknown ids resolve to null; an untrusted bag coerces to exactly two booleans', async () => {
  await checkRows([
    { name: 'reasonById resolves a known id and rejects an unknown one', run: () => {
      assert.equal(reasonById('too-slow').label, 'Too slow');
      assert.equal(reasonById('nope'), null, 'an unknown id resolves to null, never a default');
    } },
    { name: 'normalizeInclude coerces an untrusted bag to exactly the two booleans', run: () => {
      assert.deepEqual(normalizeInclude({ paths: 'yes', names: true, diff: true }),
        { paths: false, prompt: false },
        'only a literal true opts in, and an unknown key cannot smuggle a class');
      for (const junk of [null, undefined, 'x', 42, []]) {
        assert.deepEqual(normalizeInclude(junk), { paths: false, prompt: false },
          `${JSON.stringify(junk)} defaults to metadata-only`);
      }
    } },
  ]);
});
