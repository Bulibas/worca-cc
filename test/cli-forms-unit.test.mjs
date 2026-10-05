// test/cli-forms-unit.test.mjs — the CLI's kind:'form' asker (src/cli/forms.mjs) driven
// in-process with a scripted `question`: field order, `when`, defaults, review-lists,
// every input class, the per-field re-prompts and the whole-form re-offer. Each ask is
// built by the producer itself (prepareFormAsk, gate 2) plus the wire envelope's
// `agent`. test/cli-forms.test.mjs keeps three end-to-end runs over a real stdin pipe.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFormAsker } from '../src/cli/forms.mjs';
import { prepareFormAsk } from '../src/core/ask-forms.mjs';
import { FORM_REPROMPT_MAX } from '../src/cli/render.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'worca-cc-cliform-unit-'));
after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

/** The wire envelope the CLI's question handler hands to askForm. */
async function askOf(formId, def, data) {
  const r = await prepareFormAsk({ agentMeta: { ask: { forms: { [formId]: def } } }, payload: { form: formId, data },
    cwd: scratch, pipelineDir: scratch, askId: `questions-x:n_asker:1-r1-${formId}` });
  assert.ok(r.ok, JSON.stringify(r.errors));
  return { id: 'questions-x:n_asker:1-r1', kind: 'form', agent: 'Form Asker', ...r.ask };
}

/** Run askForm over a script of { cue, send }: each prompt must match its cue, IN ORDER. */
async function drive(ask, script) {
  const lines = [];
  const prompts = [];
  const question = async (_rl, prompt) => {
    prompts.push(prompt);
    const step = script[prompts.length - 1];
    if (!step) throw new Error(`unscripted prompt #${prompts.length}: ${prompt}`);
    assert.match(prompt, step.cue, `prompt #${prompts.length}`);
    return step.send;
  };
  const { askForm } = createFormAsker({ out: (l) => lines.push(l), c: (_k, s) => s, question });
  const answer = await askForm({ rl: true }, ask);
  return { answer, lines, prompts, text: lines.join('\n') };
}

const REVIEW_FORM = {
  version: 1,
  title: 'Review mockups',
  data: { type: 'object', required: ['images'], properties: {
    summary: { type: 'string', maxLength: 8000 },
    images: { type: 'array', maxItems: 12, items: { type: 'object', required: ['id'], properties: {
      id: { type: 'string' }, caption: { type: 'string' } } } } } },
  answer: { type: 'object', required: ['verdict'], properties: {
    verdict: { type: 'string', enum: ['approve', 'changes'], default: 'approve' },
    picked: { type: 'string', enumFrom: 'data.images[].id' },
    notes: { type: 'string', maxLength: 4000 } } },
  layout: [
    { widget: 'markdown', bind: 'data.summary' },
    { widget: 'select', field: 'verdict', label: 'Verdict' },
    { widget: 'select', field: 'picked', label: 'Which one' },
    { widget: 'textarea', field: 'notes', label: 'What should change?', when: { verdict: 'changes' } },
  ],
  example: { summary: 'Two directions.', images: [{ id: 'a', caption: 'Option A' }, { id: 'b', caption: 'Option B' }] },
};

test('the projection prints first; Enter accepts the default and `when` DROPS the hidden field', async () => {
  const r = await drive(await askOf('review-mockups', REVIEW_FORM, REVIEW_FORM.example), [
    { cue: /^Choose \[number or value, Enter = approve\]/, send: '' },   // Enter -> 'approve'
    { cue: /^Choose \[number or value\]/, send: '1' },                  // picked by ORDINAL -> 'a'
  ]);
  assert.deepEqual(r.answer, { values: { verdict: 'approve', picked: 'a' } });
  assert.equal(r.prompts.length, 2, 'a `when`-hidden field is never prompted');
  assert.deepEqual(r.lines.slice(0, 2), ['', '? Review mockups — Form Asker']);
  assert.match(r.text, /Two directions\./);
  assert.match(r.text, /^3\. What should change\? \{notes\}$/m, 'the projection lists the gated field');
  assert.match(r.text, /^Verdict \*$/m);
});

test('`when` reveals the gated field once its condition holds, in layout order', async () => {
  const r = await drive(await askOf('review-mockups', REVIEW_FORM, REVIEW_FORM.example), [
    { cue: /^Choose \[number or value, Enter = approve\]/, send: '2' },  // verdict -> changes
    { cue: /^Choose \[number or value\]/, send: 'b' },                  // picked by VALUE
    { cue: /^Your answer/, send: 'tighten the spacing' },               // notes, revealed by `when`
  ]);
  assert.deepEqual(r.answer, { values: { verdict: 'changes', picked: 'b', notes: 'tighten the spacing' } });
});

test('a review-list prompts per item and collects one row each', async () => {
  const STEPS_FORM = {
    version: 1, title: 'Review the plan',
    data: { type: 'object', required: ['steps'], properties: {
      steps: { type: 'array', items: { type: 'object', required: ['id'], properties: {
        id: { type: 'string' }, title: { type: 'string' } } } } } },
    answer: { type: 'object', required: ['steps'], properties: {
      steps: { type: 'array', items: { type: 'object', required: ['id', 'verdict'], properties: {
        id: { type: 'string' },
        verdict: { type: 'string', enum: ['keep', 'drop'], default: 'keep' },
        note: { type: 'string' } } } } } },
    layout: [{ widget: 'review-list', field: 'steps', bind: 'data.steps', label: 'Per-step verdict' }],
    example: { steps: [{ id: 's1', title: 'Core' }, { id: 's2', title: 'Engine' }] },
  };
  const r = await drive(await askOf('review-plan', STEPS_FORM, STEPS_FORM.example), [
    { cue: /^ {2}Choose \[number or value, Enter = keep\]/, send: '1' },   // s1 verdict
    { cue: /^ {2}Your answer/, send: '' },                                 // s1 note (optional)
    { cue: /^ {2}Choose \[number or value, Enter = keep\]/, send: '2' },   // s2 verdict -> drop
    { cue: /^ {2}Your answer/, send: 'too risky' },                        // s2 note
  ]);
  assert.match(r.text, /^Per-step verdict \*$/m);
  assert.deepEqual(r.answer, { values: { steps: [{ id: 's1', verdict: 'keep' }, { id: 's2', verdict: 'drop', note: 'too risky' }] } });
});

// Every input class the review form does not prompt, plus all four re-ask paths: a
// validate() refusal (9 > maximum), a coerceInput refusal ("abc"), Enter on a REQUIRED
// field with no default, and the whole-form re-offer collectAnswer forces — a rank naming
// one item twice is admitted by coerceInput (unlisted items are appended) and refused by
// collectAnswer with `unique`, so askForm re-asks from the first offending field.
const RICH_FORM = {
  version: 1, title: 'Rich widgets',
  data: { type: 'object', required: ['images'], properties: {
    summary: { type: 'string' },
    images: { type: 'array', items: { type: 'object', required: ['id'], properties: {
      id: { type: 'string' }, caption: { type: 'string' } } } } } },
  answer: { type: 'object', required: ['order', 'picked'], properties: {
    order: { type: 'array', items: { type: 'string', enumFrom: 'data.images[].id' } },
    tags: { type: 'array', items: { type: 'string', enum: ['spacing', 'colour', 'copy'] } },
    ship: { type: 'boolean', default: false },
    count: { type: 'integer', minimum: 1, maximum: 5, default: 2 },
    scope: { type: 'string' },
    picked: { type: 'string', enumFrom: 'data.images[].id' } } },
  layout: [
    { widget: 'markdown', bind: 'data.summary' },
    { widget: 'rank', field: 'order', bind: 'data.images', label: 'Order' },
    { widget: 'multiselect', field: 'tags', label: 'Tags' },
    { widget: 'toggle', field: 'ship', label: 'Ship it' },
    { widget: 'number', field: 'count', label: 'Count' },
    { widget: 'select', field: 'scope', label: 'Scope', suggest: ['Web only', 'Web and CLI'] },
    { widget: 'select', field: 'picked', label: 'Which one' },
  ],
  example: { summary: 'Two.', images: [{ id: 'a', caption: 'Option A' }, { id: 'b', caption: 'Option B' }] },
};
const ORDER = /^Order \[comma-separated numbers or ids\]/;

test('rank, multiselect, toggle, number and suggest; per-field re-prompts and the whole-form re-offer', async () => {
  const r = await drive(await askOf('rich', RICH_FORM, RICH_FORM.example), [
    { cue: ORDER, send: 'a,a' },                                            // admitted here, refused by collectAnswer
    { cue: /^Choose \[numbers or values, comma-separated\]/, send: '1,3' },
    { cue: /^Choose \[y\/n, Enter = false\]/, send: '' },                   // Enter -> false
    { cue: /^Enter a number \[Enter = 2\]/, send: '9' },                    // validate: Maximum is 5
    { cue: /^Enter a number \[Enter = 2\]/, send: 'abc' },                  // coerce: not a number
    { cue: /^Enter a number \[Enter = 2\]/, send: '4' },
    { cue: /^Choose \[number, value or your own text\]/, send: 'Everything' }, // free text on a suggest select
    { cue: /^Choose \[number or value\]/, send: '' },                       // required, no default
    { cue: /^Choose \[number or value\]/, send: 'b' },
    // pass 2: collectAnswer refused the duplicate rank, so EVERY field is re-asked
    { cue: ORDER, send: '2,1' },
    { cue: /^Choose \[numbers or values, comma-separated\]/, send: '' },    // optional, dropped
    { cue: /^Choose \[y\/n, Enter = false\]/, send: 'y' },
    { cue: /^Enter a number \[Enter = 2\]/, send: '' },                     // Enter -> 2
    { cue: /^Choose \[number, value or your own text\]/, send: '2' },       // ordinal -> 'Web and CLI'
    { cue: /^Choose \[number or value\]/, send: '1' },                      // ordinal -> 'a'
  ]);
  assert.equal(r.prompts.length, 15);
  assert.match(r.text, /count: Maximum is 5\./, 'a validate() refusal names the field (formatFormErrors)');
  assert.match(r.text, /Count: "abc" is not a number/, 'a coerceInput refusal carries the label (formatCoerceError)');
  assert.match(r.text, /Which one is required/, 'Enter on a required field with no default re-prompts');
  assert.match(r.text, /order: Each item may appear only once\./, 'collectAnswer refused the duplicate rank');
  assert.equal((r.text.match(/Order \*\n {2}1\) Option A/g) || []).length, 2, 're-offered exactly once, from the rank');
  assert.deepEqual(r.answer, { values: { order: ['b', 'a'], ship: true, count: 2, scope: 'Web and CLI', picked: 'a' } });
});

test(`a form still invalid after FORM_REPROMPT_MAX (${FORM_REPROMPT_MAX}) whole-form passes throws, naming the form`, async () => {
  const pass = [
    { cue: ORDER, send: 'a,a' },
    { cue: /^Choose \[numbers or values, comma-separated\]/, send: '' },
    { cue: /^Choose \[y\/n, Enter = false\]/, send: '' },
    { cue: /^Enter a number \[Enter = 2\]/, send: '' },
    { cue: /^Choose \[number, value or your own text\]/, send: '' },
    { cue: /^Choose \[number or value\]/, send: 'a' },
  ];
  const ask = await askOf('rich', RICH_FORM, RICH_FORM.example);
  await assert.rejects(drive(ask, Array.from({ length: FORM_REPROMPT_MAX }, () => pass).flat()),
    /^Error: form "rich" is still invalid after 3 attempts$/);
});
