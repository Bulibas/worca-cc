// test/cli-render-forms.test.mjs
// The CLI's FORMATTING of a kind:'form' prompt (spec §8, ruling X7). Coercion is
// P1's coerceInput and is NOT re-implemented here — this file pins only what a
// line looks like. No readline, no spawn, no WORCA_HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FORM_REPROMPT_MAX, formatFormField, formatCoerceError, formatFormErrors,
} from '../src/cli/render.mjs';
import { checkRows } from './helpers/rows.mjs';

/** A promptFields() entry (P1). `options` is ALWAYS [{ value, label }]. */
const F = (over) => ({
  field: 'verdict', label: 'Verdict', widget: 'select', type: 'string',
  schema: { type: 'string' }, options: [], items: null, itemFields: null, verdicts: [],
  free: false, default: undefined, required: false, when: null,
  ...over,
});

// Rows: [original title, field overrides, expected lines (null = not pinned), expected prompt].
test('formatFormField: select variants (default + required, no default, suggest)', async () => {
  await checkRows([
    ['formatFormField: a select numbers its option LABELS and marks the default', {
      options: [{ value: 'approve', label: 'Ship it' }, { value: 'changes', label: 'Another pass' }],
      default: 'approve', required: true,
    }, ['Verdict *', '  1) Ship it', '  2) Another pass'], 'Choose [number or value, Enter = approve]: '],
    ['formatFormField: no default, no Enter hint; not required, no asterisk', {
      options: [{ value: 'approve', label: 'approve' }, { value: 'changes', label: 'changes' }],
    }, ['Verdict', '  1) approve', '  2) changes'], 'Choose [number or value]: '],
    ['formatFormField: a `suggest` select says the answer may be your own text', {
      field: 'q', label: 'Scope', free: true,
      options: [{ value: 'Web only', label: 'Web only' }, { value: 'Web and CLI', label: 'Web and CLI' }],
    }, null, 'Choose [number, value or your own text]: '],
  ].map(([name, over, expectedLines, expectedPrompt]) => ({ name, run: () => {
    const { lines, prompt } = formatFormField(F(over));
    if (expectedLines) assert.deepEqual(lines, expectedLines);
    assert.equal(prompt, expectedPrompt);
  } })));
});

test('formatFormField: multiselect, rank, toggle, number, date, free text and review-list prompts', async () => {
  await checkRows([
    { name: 'formatFormField: multiselect, rank, toggle, number, date and free text', run: async () => {
      assert.equal(formatFormField(F({
        field: 'tags', label: 'Tags', widget: 'multiselect', type: 'array',
        options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
      })).prompt, 'Choose [numbers or values, comma-separated]: ');

      const rank = formatFormField(F({
        field: 'order', label: 'Order', widget: 'rank', type: 'array',
        options: [{ value: 'a', label: 'Option A' }, { value: 'b', label: 'Option B' }],
        items: [{ id: 'a', label: 'Option A' }, { id: 'b', label: 'Option B' }],
      }));
      assert.deepEqual(rank.lines, ['Order', '  1) Option A', '  2) Option B']);
      assert.equal(rank.prompt, 'Order [comma-separated numbers or ids]: ');

      assert.equal(formatFormField(F({ field: 'ship', label: 'Ship it', widget: 'toggle', type: 'boolean' })).prompt,
        'Choose [y/n]: ');
      assert.equal(formatFormField(F({ field: 'n', label: 'Count', widget: 'number', type: 'integer', default: 3 })).prompt,
        'Enter a number [Enter = 3]: ');
      assert.equal(formatFormField(F({ field: 'by', label: 'By when', widget: 'date', type: 'string' })).prompt,
        'Enter a date (YYYY-MM-DD): ');
      assert.equal(formatFormField(F({ field: 'notes', label: 'Notes', widget: 'textarea', type: 'string' })).prompt,
        'Your answer: ');
    } },
    { name: 'formatFormField: a review-list lists its ROWS and returns NO prompt', run: async () => {
      const { lines, prompt } = formatFormField(F({
        field: 'steps', label: 'Per-step verdict', widget: 'review-list', type: 'array',
        options: [{ value: 's1', label: 'Core' }, { value: 's2', label: 'Engine' }],
        items: [{ id: 's1', label: 'Core' }, { id: 's2', label: 'Engine' }],
        verdicts: ['keep', 'change', 'drop'],
        itemFields: [{ field: 'verdict', label: 'Verdict', widget: 'select', type: 'string',
          options: [{ value: 'keep', label: 'keep' }], default: 'keep', required: true }],
      }));
      assert.deepEqual(lines, ['Per-step verdict', '  1) Core', '  2) Engine']);
      assert.equal(prompt, null, 'the caller loops items x itemFields itself');
    } },
  ]);
});

test('formatCoerceError / formatFormErrors prefix label or path; FORM_REPROMPT_MAX is 3', async () => {
  await checkRows([
    { name: 'formatCoerceError prefixes the label onto P1\'s message', run: async () => {
      assert.equal(
        formatCoerceError(F({ label: 'Verdict' }), { ok: false, code: 'enum', message: '"zz" is not one of: approve, changes' }),
        '  Verdict: "zz" is not one of: approve, changes');
      assert.equal(
        formatCoerceError(F({ field: 'n', label: undefined }), { ok: false, code: 'type', message: '"four" is not a number' }),
        '  n: "four" is not a number');
    } },
    { name: 'formatFormErrors prefixes the path when there is one; FORM_REPROMPT_MAX is 3', run: async () => {
      assert.equal(FORM_REPROMPT_MAX, 3);
      assert.deepEqual(formatFormErrors([
        { path: 'verdict', code: 'enum', message: 'must be one of approve, changes' },
        { path: '', code: 'required', message: 'notes is required' },
      ]), ['  verdict: must be one of approve, changes', '  notes is required']);
      assert.deepEqual(formatFormErrors(null), []);
      assert.deepEqual(formatFormErrors([{ path: 'a' }]), ['  a: invalid value']);
    } },
  ]);
});
