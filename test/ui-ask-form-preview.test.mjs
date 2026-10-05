// test/ui-ask-form-preview.test.mjs
// The Agents view previews a DECLARATION, so it needs the run-time envelope a
// form's own `example` stands for (spec §11). Pure: plain objects in, one plain
// object out. No DOM, no fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewAskFromDef, previewFileUrl } from '../ui/public/ask/form-preview.mjs';
import { resolveAnswerSchema } from '../src/shared/forms/schema.mjs';
import { checkRows } from './helpers/rows.mjs';

const PICK_ONE = {
  version: 2, title: 'Pick one',
  data: { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } },
  answer: { type: 'object', required: ['verdict'], properties: { verdict: { type: 'string', enum: ['yes', 'no'] } } },
  layout: [{ widget: 'markdown', bind: 'data.summary' }, { widget: 'select', field: 'verdict', label: 'Verdict' }],
  example: { summary: 'Something happened.' },
};
const WITH_FILES = {
  version: 1, title: 'Review mockups',
  data: { type: 'object', required: ['images'], properties: {
    images: { type: 'array', items: { type: 'object', required: ['id', 'file'], properties: {
      id: { type: 'string' },
      file: { type: 'file', accept: ['image/*'] } } } } } },
  answer: { type: 'object', required: ['picked'], properties: { picked: { type: 'string', enumFrom: 'data.images[].id' } } },
  layout: [{ widget: 'gallery', bind: 'data.images', field: 'picked' }],
  example: { images: [{ id: 'a', file: 'mockups/a.png' }] },
};

test('the envelope is P2\u2019s (ruling X1): every key, with data from `example`', () => {
  const ask = previewAskFromDef('pick-one', PICK_ONE);
  assert.deepEqual(Object.keys(ask).sort(), [
    'agent', 'answerSchema', 'askId', 'data', 'executionId', 'fileRefs', 'files',
    'form', 'id', 'kind', 'layout', 'nodeId', 'surface', 'title', 'version',
  ], 'the SAME key set the engine emits \u2014 the renderer must not tell them apart');
  assert.equal(ask.kind, 'form');
  assert.equal(ask.form, 'pick-one');
  assert.equal(ask.version, 2);
  assert.equal(ask.title, 'Pick one');
  assert.equal(ask.surface, 'any');
  assert.deepEqual(ask.data, PICK_ONE.example, 'the example IS the preview data');
  assert.deepEqual(ask.layout, PICK_ONE.layout);
  assert.deepEqual(ask.answerSchema, resolveAnswerSchema(PICK_ONE.answer, PICK_ONE.example),
    'the RESOLVED schema, exactly as a run would send it');
});

test('a declaration preview has files [] and a null fileUrl, but fileRefs IS built (X14/X16)', async () => {
  await checkRows([
    { name: 'files is EMPTY and fileUrl is null \u2014 a declaration snapshotted nothing (X14)', run: async () => {
      const ask = previewAskFromDef('review-mockups', WITH_FILES);
      assert.deepEqual(ask.files, [], 'the renderer\u2019s fileFor() then answers null and draws .af-nofile');
      assert.equal(previewFileUrl(0), null);
      assert.equal(previewFileUrl(), null);
    } },
    { name: 'fileRefs IS built (X16): it is what marks a bound value as a file', run: async () => {
      assert.deepEqual(previewAskFromDef('review-mockups', WITH_FILES).fileRefs,
        [{ path: 'data.images[0].file', rel: 'mockups/a.png' }],
        'path + rel only, in document order, so fileRefs[i] would match files[i]');
      assert.deepEqual(previewAskFromDef('pick-one', PICK_ONE).fileRefs, [],
        'a form with no file-typed property declares none');
    } },
  ]);
});

test('surface rides through, and a half-written def never throws', () => {
  assert.equal(previewAskFromDef('w', { ...PICK_ONE, surface: 'web' }).surface, 'web');
  assert.equal(previewAskFromDef('w', { ...PICK_ONE, surface: 'nonsense' }).surface, 'any');
  const ask = previewAskFromDef('draft', { version: 0, title: '', data: {}, answer: {}, layout: [], example: {} });
  assert.equal(ask.title, 'draft', 'a blank title falls back to the id so the preview has a heading');
  assert.equal(ask.version, 1, 'version is a POSITIVE integer or 1');
  assert.deepEqual(ask.layout, []);
  const empty = previewAskFromDef('draft', null);
  assert.equal(empty.form, 'draft');
  assert.deepEqual(empty.data, {});
});
