// test/deck-approval-forms.test.mjs — the Presentation pipeline's two approval gates are ask forms:
// `approve-spine` (deckNarrative) and `approve-system` (deckSystem). Gate 1 for every built-in
// form is swept by agents-ask-forms.test.mjs; this file pins what the two gates promise the
// user: untouched submits approve, edits reach the agent, and bad answers are refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeAskBlock, validateFormDef } from '../src/shared/forms/form-def.mjs';
import { autoAnswer, checkAskData } from '../src/shared/forms/answer.mjs';
import { formAnswerValidator, prepareFormAsk } from '../src/core/ask-forms.mjs';

const meta = async (key) => JSON.parse(await readFile(new URL(`../agents/${key}.meta.json`, import.meta.url), 'utf8'));
const NARR = await meta('deckNarrative');
const SYS = await meta('deckSystem');
const SPINE = NARR.ask.forms['approve-spine'];
const SYSTEM = SYS.ask.forms['approve-system'];

test('both gates are valid forms and the normalizer keeps them', () => {
  for (const [id, def, m] of [['approve-spine', SPINE, NARR], ['approve-system', SYSTEM, SYS]]) {
    assert.deepEqual(validateFormDef(def, { id }).errors, [], id);
    assert.deepEqual(normalizeAskBlock(m.ask).dropped, [], id);
    assert.deepEqual(Object.keys(m.ask.forms), [id]);
  }
});

test('the forms carry the titles the prompts name for the plain-question fallback', () => {
  assert.equal(SPINE.title, 'Approve the narrative spine');
  assert.equal(SYSTEM.title, 'Approve the visual system');
});

test('the approve-system example keeps the accent to one job: no ground is the accent colour', () => {
  // agents copy the example, and `## Accent` is "one hue, one job"
  const accentHex = /#[0-9A-Fa-f]{6}/.exec(SYSTEM.example.accent)[0].toLowerCase();
  assert.deepEqual(SYSTEM.example.grounds.filter((g) => g.hex.toLowerCase() === accentHex), []);
  assert.equal(SYSTEM.example.grounds.length, 3);
});

test('an untouched submit (and --yes) is an approval that changes nothing', () => {
  const ex = SPINE.example;
  assert.deepEqual(autoAnswer(SPINE, ex), {
    decision: 'approve',
    sentence: ex.sentence,
    sectionOrder: ex.sections.map((s) => s.id),
    slides: ex.slides.map((s) => ({ id: s.id, verdict: 'keep' })),
  });
  assert.deepEqual(autoAnswer(SYSTEM, SYSTEM.example), { decision: 'approve' });
});

const slides = (n) => Array.from({ length: n }, (_, i) => ({ id: String(i + 1), title: `Takeaway ${i + 1}`, meta: 'Evidence' }));

test('approve-spine takes a real deck (up to 60 slides) and refuses a 61st', () => {
  assert.deepEqual(checkAskData(SPINE, { ...SPINE.example, slides: slides(60) }).errors, []);
  const r = checkAskData(SPINE, { ...SPINE.example, slides: slides(61) });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === 'data.slides'), JSON.stringify(r.errors));
});

async function askSpine(body) {
  const pdir = await mkdtemp(join(tmpdir(), 'deck-spine-'));
  const cwd = await mkdtemp(join(tmpdir(), 'deck-spine-cwd-'));
  await writeFile(join(pdir, 'spine.md'), body);
  const r = await prepareFormAsk({ agentMeta: NARR, payload: { form: 'approve-spine', data: SPINE.example }, cwd, pipelineDir: pdir, askId: 'questions-x-n_narr-c1-r1' });
  await rm(pdir, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
  return r;
}

test('gate 2 snapshots spine.md as text — even one whose lines look like a diff header', async () => {
  for (const body of ['# Deck\n\n## The sentence\nOne line.\n', '# Deck\n--- before\n+++ after\n']) {
    const r = await askSpine(body);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.match(r.ask.files[0].mime, /^text\//);
  }
});

test('gate 3 on approve-spine: edits pass, made-up or repeated ids and a blank sentence do not', async () => {
  const r = await askSpine('# Deck\n');
  const check = formAnswerValidator(r.ask);
  const base = r.autoValues;
  assert.equal(check({ values: base }).ok, true);
  const edited = check({ values: { ...base, sectionOrder: ['s3', 's1', 's2'], slides: [{ id: '1', verdict: 'cut' }, { id: '2', verdict: 'rework', note: 'name the cost' }], notes: 'Shorter.' } });
  assert.equal(edited.ok, true, JSON.stringify(edited.errors));
  assert.deepEqual(edited.payload.values.slides[1], { id: '2', verdict: 'rework', note: 'name the cost' });
  assert.equal(check({ values: { ...base, slides: [{ id: '99', verdict: 'keep' }] } }).ok, false);
  assert.equal(check({ values: { ...base, slides: [{ id: '1', verdict: 'drop' }] } }).ok, false);
  assert.equal(check({ values: { ...base, sectionOrder: ['s1', 's1'] } }).ok, false);
  assert.equal(check({ values: { ...base, sentence: '' } }).ok, false);
});

test('approve-system works without any image (no Chrome) and refuses an unknown change area', async () => {
  const { sheet, compositionsSheet, samples, ...noImages } = SYSTEM.example;
  assert.ok(sheet && compositionsSheet && samples, 'the example shows the images');
  const pdir = await mkdtemp(join(tmpdir(), 'deck-system-'));
  try {
    const r = await prepareFormAsk({ agentMeta: SYS, payload: { form: 'approve-system', data: noImages }, cwd: pdir, pipelineDir: pdir, askId: 'questions-x-n_system-c1-r1' });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.ask.fileRefs, []);
    const check = formAnswerValidator(r.ask);
    assert.equal(check({ values: { decision: 'approve', changeAreas: ['type', 'accent'], notes: 'Warmer paper.' } }).ok, true);
    assert.equal(check({ values: { decision: 'approve', changeAreas: ['motion'] } }).ok, false);
    assert.equal(check({ values: { decision: 'maybe' } }).ok, false);
  } finally { await rm(pdir, { recursive: true, force: true }); }
});
