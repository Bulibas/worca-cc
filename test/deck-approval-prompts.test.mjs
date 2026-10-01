// test/deck-approval-prompts.test.mjs — the "## Approval checkpoint" of the two deck agents asks
// through its ask form, once, and only when asking is enabled. Every other section is left as is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkSpec, KINDS } from '../assets/deck-preview/preview-html.mjs';

const md = async (name) => readFile(new URL(`../agents/${name}.md`, import.meta.url), 'utf8');
/** The body of one `## ` section, up to the next `## ` heading. */
function section(text, heading) {
  const at = text.indexOf(`\n## ${heading}\n`);
  assert.ok(at >= 0, `no "## ${heading}" section`);
  const rest = text.slice(at + 1);
  const next = rest.indexOf('\n## ', 1);
  return next < 0 ? rest : rest.slice(0, next);
}
const headings = (text) => text.match(/^## .+$/gm);

const GATES = [
  { file: 'worca-cc-deck-narrative', form: 'approve-spine', title: 'Approve the narrative spine',
    headings: ['## Ports', '## What to do', '## spine.md format (the downstream agents parse the headers)', '## The sentence', '## Spine', '## Slides', '## Captions', '## Approval checkpoint', '## Directions from the user'] },
  { file: 'worca-cc-deck-system', form: 'approve-system', title: 'Approve the visual system',
    headings: ['## Ports', '## What to do', '## Reject your own system if it fails these', '## Approval checkpoint', '## Directions from the user'] },
];

for (const g of GATES) {
  test(`${g.file}: the checkpoint asks with the ${g.form} form, once, only when asking is enabled`, async () => {
    const text = await md(g.file);
    const cp = section(text, 'Approval checkpoint');
    assert.match(cp, /"Asking the user \(enabled\)"/);
    assert.match(cp, /finish without asking/);
    assert.match(cp, new RegExp(`"form"\\s*:\\s*"${g.form}"`));
    assert.match(cp, /\bSTOP\b/);
    assert.match(cp, /## Your form answers/);
    // answers are checked BEFORE the enabled gate: after a third question round the engine
    // drops "(enabled)" from the block, and the answer must still be applied
    assert.ok(cp.indexOf('## Your form answers') < cp.indexOf('"Asking the user (enabled)"'), 'answers first');
    assert.ok(cp.includes(`"${g.title}"`), 'names the fallback question by the form title');
    assert.match(cp, /## Your form ask was refused/);
    assert.match(cp, /do NOT ask again/);
    assert.match(cp, /even when `decision` is still `approve`/);
    // the plain-question gate is gone
    assert.doesNotMatch(cp, /options\s*`?\[|"options"|Approve as written|allowFreeText/);
    assert.deepEqual(headings(text), g.headings);
  });
}

test('the system checkpoint renders the preview through the staged script, never by hand', async () => {
  const cp = section(await md('worca-cc-deck-system'), 'Approval checkpoint');
  assert.match(cp, /node <pipelineDir>\/deck-preview\/render-preview\.mjs --spec <pipelineDir>\/preview\/system\.json --ask /);
  assert.match(cp, /Never write the payload by hand/);
  for (const kind of KINDS) assert.ok(cp.includes(`\`${kind}\``), kind);
  assert.match(cp, /`## Accent` line names the accent's hex/);
  // a run set up before deck-preview shipped has no staged script: exit 1, module not found
  assert.match(cp, /any other non-zero exit \(for example the script is missing\): finish without asking/);
});

test("the system checkpoint's spec example is a valid spec (agents copy examples)", async () => {
  const cp = section(await md('worca-cc-deck-system'), 'Approval checkpoint');
  const m = /```json\n([\s\S]*?)\n\s*```/.exec(cp);
  assert.ok(m, 'a ```json example');
  const example = JSON.parse(m[1]);
  assert.deepEqual(checkSpec(example), { ok: true, errors: [] });
  assert.ok(example.typeSteps.every((s) => !('family' in s)), 'no invented font in the example');
});

test('the spine checkpoint says how to build every data field from spine.md', async () => {
  const cp = section(await md('worca-cc-deck-narrative'), 'Approval checkpoint');
  for (const f of ['headline', 'sentence', 'sections', 'slides', 'spine']) assert.ok(cp.includes(`\`${f}\`:`), f);
  assert.match(cp, /never an absolute path/);
  assert.match(cp, /ORIGINAL `#`/);
  // a workflow running deckNarrative twice prefixes the file `<nodeId>-`: the path comes from Ports
  assert.match(cp, /`spine`: the file name of your `spine` output \(the `- Write \*\*spine\*\* to:` line under `## Ports \(this run\)`\)/);
});

test('the spine checkpoint re-walks the rules before it renumbers, and keeps one hero', async () => {
  const cp = section(await md('worca-cc-deck-narrative'), 'Approval checkpoint');
  const resume = cp.slice(cp.indexOf('**On resume**'));
  // re-walking the reset rule can insert rows, so the renumbering comes last
  assert.ok(resume.indexOf('re-walk the reset rule') >= 0, 're-walks the reset rule');
  assert.ok(resume.indexOf('re-walk the reset rule') < resume.indexOf('renumber `#` and `## Captions`'), 'renumbers last');
  assert.match(resume, /a reworked slide's caption follows its new title/);
  assert.match(resume, /hero row is cut, mark the strongest remaining slide as the hero/);
});
