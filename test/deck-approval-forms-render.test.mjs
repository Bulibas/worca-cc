// test/deck-approval-forms-render.test.mjs — the acceptance view of the two deck gates. Each
// form goes through the real gate 2 (files snapshotted) and is drawn by the real form renderer
// in jsdom: the user sees tabs, one keep/rework/cut row per slide, the section rank and the
// preview images, and an untouched form submits the approval. Needs jsdom (node_modules).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { renderAskForm } from '../ui/public/ask/form-renderer.mjs';
import { prepareFormAsk } from '../src/core/ask-forms.mjs';
import { checkRows } from './helpers/rows.mjs';

const doc = new JSDOM('<!doctype html><body></body>').window.document;
const meta = async (key) => JSON.parse(await readFile(new URL(`../agents/${key}.meta.json`, import.meta.url), 'utf8'));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');   // a PNG signature: enough for the sniffer

/** Gate 2 on `data` (default: the form's example) with `files` written into a fresh pipeline dir. */
async function gate2(key, form, files, data) {
  const agentMeta = await meta(key);
  const pdir = await mkdtemp(join(tmpdir(), 'deck-gate-'));
  const cwd = await mkdtemp(join(tmpdir(), 'deck-gate-cwd-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(dirname(join(pdir, rel)), { recursive: true });
      await writeFile(join(pdir, rel), body);
    }
    const payload = { form, data: data ?? agentMeta.ask.forms[form].example };
    const r = await prepareFormAsk({ agentMeta, payload, cwd, pipelineDir: pdir, askId: 'questions-x-n_deck-c1-r1' });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    return r;
  } finally {
    await rm(pdir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
}
const mount = (r) => renderAskForm(r.ask, { doc, fileUrl: (i) => `/ask-files/x/${i}`, loadText: async () => '# Deck' });
const tabs = (el) => [...el.querySelectorAll('[role="tab"]')].map((t) => t.textContent.trim());

test('both deck gates render their tabs and rows; an untouched submit approves', async () => {
  await checkRows([
    { name: 'approve-spine: headline, editable sentence, Story / Slides / Full spine.md, a verdict per slide', run: async () => {
      const r = await gate2('deckNarrative', 'approve-spine', { 'spine.md': '# Deck\n\n## The sentence\nOne.\n' });
      const f = mount(r);
      assert.deepEqual(tabs(f.el), ['Story', 'Slides', 'Full spine.md']);
      assert.ok(f.el.textContent.includes(r.ask.data.headline));
      assert.equal(f.el.querySelector('textarea').value, r.ask.data.sentence, 'the sentence is prefilled and editable');
      assert.equal(f.el.querySelectorAll('.af-rv-item').length, r.ask.data.slides.length);
      assert.equal(f.el.querySelectorAll('.af-rank-txt').length, r.ask.data.sections.length);
      assert.equal(f.el.querySelectorAll('.af-nofile').length, 0, 'spine.md is served, not a missing tile');
      assert.deepEqual(f.snapshot(), r.autoValues, 'an untouched submit is the approval');
    } },
    { name: 'approve-system renders with and without preview images; untouched = approve', run: async () => {
      await checkRows([
        { name: 'approve-system: the three previews as images next to the tables; untouched = approve', run: async () => {
          const files = { 'preview/system-sheet.png': PNG, 'preview/compositions.png': PNG, 'preview/samples.png': PNG };
          const f = mount(await gate2('deckSystem', 'approve-system', files));
          assert.deepEqual(tabs(f.el), ['Sheet', 'Compositions', 'Samples']);
          assert.deepEqual([...f.el.querySelectorAll('img')].map((i) => i.getAttribute('src')),
            ['/ask-files/x/0', '/ask-files/x/1', '/ask-files/x/2']);
          assert.equal(f.el.querySelectorAll('table').length, 3);
          assert.deepEqual(f.snapshot(), { decision: 'approve' });
        } },
        { name: 'approve-system without Chrome: tables and callouts still carry the system', run: async () => {
          const { sheet, compositionsSheet, samples, ...data } = (await meta('deckSystem')).ask.forms['approve-system'].example;
          const f = mount(await gate2('deckSystem', 'approve-system', {}, data));
          assert.equal(f.el.querySelectorAll('img').length, 0);
          assert.equal(f.el.querySelectorAll('.af-nofile').length, 3, 'the known, accepted tiles (see Risks)');
          assert.equal(f.el.querySelectorAll('table').length, 3);
          assert.deepEqual(f.snapshot(), { decision: 'approve' });
        } },
      ]);
    } },
  ]);
});
