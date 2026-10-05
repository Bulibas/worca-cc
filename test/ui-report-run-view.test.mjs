// test/ui-report-run-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderOptIns, previewText, reportBlobParts } from '../ui/public/report-run.mjs';
import { OPT_IN_KEYS } from '../src/shared/report-reasons.mjs';
import { checkRows } from './helpers/rows.mjs';

const doc = new JSDOM('<!doctype html><body></body>').window.document;

test('the opt-ins are exactly two checkboxes; names, the diff and logs are not offered', () => {
  const wrap = renderOptIns({ doc, include: { paths: true, prompt: false } });
  const boxes = [...wrap.querySelectorAll('input[type="checkbox"]')];
  assert.equal(boxes.length, 2, 'two classes, no more');
  assert.deepEqual(boxes.map((b) => b.dataset.optin), OPT_IN_KEYS);
  assert.equal(boxes[0].checked, true, 'current state is reflected');
  assert.equal(boxes[1].checked, false);
  assert.doesNotMatch(wrap.textContent.toLowerCase(), /\bdiff\b/,
    'the unified diff is never offered');
  assert.doesNotMatch(wrap.textContent.toLowerCase(), /\blog lines\b/,
    'log lines are never offered');
  assert.doesNotMatch(wrap.textContent.toLowerCase(), /workspace names/,
    'names are unconditional now — offering them as a choice would imply they can be withheld');
  assert.equal(wrap.querySelector('.hint'), null,
    'hints use .report-optin-hint — .hint is asserted empty across the settings view');
});

test('the preview and the download blob are the EXACT payload, pretty-printed (blob ends in a newline)', async () => {
  await checkRows([
    { name: 'the preview is the EXACT payload, pretty-printed', run: () => {
      const payload = { schemaVersion: 1, run: { id: 'abc' } };
      const text = previewText(payload);
      assert.equal(text, JSON.stringify(payload, null, 2),
        'what the reporter reads is byte-identical to what is copied');
      assert.deepEqual(JSON.parse(text), payload, 'and it round-trips');
    } },
    { name: 'reportBlobParts produce valid JSON with a trailing newline', run: () => {
      const [text] = reportBlobParts({ a: 1 });
      assert.equal(text, '{\n  "a": 1\n}\n');
    } },
  ]);
});
