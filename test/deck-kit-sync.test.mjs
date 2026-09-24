// test/deck-kit-sync.test.mjs
// The kit under assets/deck-kit/ is canonical; docs/why-worca/ keeps flat
// byte-identical copies because deck-export.js resolves siblings relatively.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KIT = join(ROOT, 'assets', 'deck-kit');
const DECK = join(ROOT, 'docs', 'why-worca');
const SYNCED = ['deck-stage.js', 'deck-enhance.js', 'deck-export.js'];

test('every synced kit file is byte-identical in docs/why-worca', () => {
  for (const f of SYNCED) {
    const a = readFileSync(join(KIT, f));
    const b = readFileSync(join(DECK, f));
    assert.ok(a.equals(b), `${f} drifted — run \`npm run deck:sync\``);
  }
});

test('the kit carries VERSION, CONTRACT.md and deck-audit.js', () => {
  assert.match(readFileSync(join(KIT, 'VERSION'), 'utf8').trim(), /^\d+\.\d+\.\d+$/);
  assert.ok(existsSync(join(KIT, 'CONTRACT.md')));
  assert.ok(existsSync(join(KIT, 'deck-audit.js')));
});

// deck-export.js bundles from the BROWSER and needs the deck served over http;
// build-standalone.mjs is the headless from-disk twin, and it is the only one an
// agent can run. It was left in docs/why-worca/ when the kit was extracted, so
// the builder had no path to a single file and a run shipped without one.
test('the kit carries the headless bundler agents actually run', () => {
  assert.ok(existsSync(join(KIT, 'build-standalone.mjs')),
    'build-standalone.mjs must live in the kit — deck-export.js needs a browser and cannot replace it');
});

test('the builder contract names both single-file deliverables', () => {
  const contract = readFileSync(join(KIT, 'CONTRACT.md'), 'utf8');
  for (const needle of ['build-standalone.mjs', 'deck.standalone.html', 'deck.pdf', 'print-to-pdf']) {
    assert.ok(contract.includes(needle), `CONTRACT.md does not mention ${needle}`);
  }
});

// v2: the guard opens on the line ABOVE the localStorage call (multi-line
// `try {` / call / `} catch {}`), so scan a small preceding-line window rather
// than asserting `try {` on the same line. This is a REGRESSION test — the kit
// already satisfies it; it fails only if a future edit unguards a call.
test('every localStorage access in the kit sits inside a try (opaque-origin sandbox throws)', () => {
  for (const f of ['deck-stage.js', 'deck-enhance.js']) {
    const lines = readFileSync(join(KIT, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const isComment = /^\s*(\*|\/\/)/.test(line);
      if (isComment || !/localStorage\.(get|set|remove)Item/.test(line)) return;
      const windowText = lines.slice(Math.max(0, i - 2), i + 1).join('\n');
      assert.match(windowText, /try\s*\{/, `${f}:${i + 1} reads/writes localStorage outside a try`);
    });
  }
});

test('package.json publishes the kit', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('assets/deck-kit/'));
  // `tools/`, not `scripts/`: upstream made `scripts/` the BUILT-IN SCRIPT LAYER
  // (a <key>.meta.json plus its program) and moved repo dev-scripts to tools/.
  assert.equal(pkg.scripts['deck:sync'], 'node tools/deck-sync.mjs');
});

// A `Mode: both` deck stays under the 30-word live cap by moving its read-alone
// completeness into a [data-deck-caption] band. That only works if the band is
// hidden on screen and printed with the deck, and the rule lives in the kit's
// injected print sheet (beside @page) rather than in the deck's own <style>,
// because a builder that forgets it fails silently in both directions: captions
// on the projector, or the whole read-alone layer missing from the PDF.
test('the injected print sheet hides the caption band on screen and prints it', () => {
  const src = readFileSync(join(KIT, 'deck-stage.js'), 'utf8');
  assert.match(src, /\[data-deck-caption\] \{ display: none; \}/);
  assert.match(src, /@media print \{ \[data-deck-caption\] \{ display: block; \} \}/);
});

// deck-audit.js measures the LIVE surface. If it ever honours location.hash
// again it will audit slide 1 and report the rest clean, because deck-stage.js
// stamps a hash in from _applyIndex before deck-audit.js ever runs.
test('the audit does not read location.hash', () => {
  const src = readFileSync(join(KIT, 'deck-audit.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
  assert.doesNotMatch(code, /location\.hash/, 'deck-audit.js must measure every slide, hash or no hash');
});

// The contract is the builder's most concrete instruction, so a hardcoded kit
// version in it beats the agent file's `<VERSION>` placeholder — every generated
// deck would then stamp a version the kit no longer is, and the deck's generator
// meta and the manifest's `Kit:` line would disagree.
test('the contract names no literal kit version', () => {
  const contract = readFileSync(join(KIT, 'CONTRACT.md'), 'utf8');
  const version = readFileSync(join(KIT, 'VERSION'), 'utf8').trim();
  const generator = contract.match(/content="OpenDeck ([^"]+)"/);
  assert.ok(generator, 'the contract still shows the generator meta');
  assert.equal(generator[1], '<VERSION>', 'it must be the placeholder, not a pinned number');
  assert.ok(contract.includes(`Kit version: **${version}**`),
    `the contract's stated kit version does not match VERSION (${version})`);
});

// A --print-to-pdf snapshot can fire before the font reveal clears
// [data-fonts-pending] (a stalled font, no frame for the rAF, a virtual-time
// budget shorter than the mount). Ancestor opacity MULTIPLIES, so the print
// sheet's ::slotted(*){opacity:1 !important} cannot rescue a hidden .stage — every
// page prints blank, with the RIGHT page count, so the one PDF assertion the
// contract defines passes on an empty deliverable.
test('printing is never gated on the font-reveal hide', () => {
  const src = readFileSync(join(KIT, 'deck-stage.js'), 'utf8');
  const printBlock = src.slice(src.indexOf('@media print'));
  assert.match(printBlock, /:host\(\[data-fonts-pending\]\)\s*\.stage[\s\S]{0,80}opacity:\s*1\s*!important/,
    'the print sheet clears the pending hide');
});

// Neither font fetch checked response.ok, so a 404 or a captive-portal page was
// inlined as CSS and base64'd as a webfont — logged as success, shipped in a
// fallback face.
test('every font fetch checks response.ok before trusting the bytes', () => {
  for (const f of ['deck-export.js', 'build-standalone.mjs']) {
    const src = readFileSync(join(KIT, f), 'utf8');
    const fonts = src.slice(src.indexOf('woff2'));
    assert.match(fonts, /\.ok\)\s*throw/, `${f} rejects a non-ok font response`);
  }
});

// CONTRACT calls `#speaker-notes` "the kit's real mechanism" for speaker notes and
// _loadNotes parsed it faithfully — but nothing ever read `this._notes`, so a
// compliant builder emitted an array the kit discarded. And _loadNotes ran once
// from connectedCallback, so a block placed after <script src="deck-stage.js">
// (the order CONTRACT's own example uses) was never seen at all.
test('the parsed speaker notes are actually reachable, not parsed and dropped', () => {
  const src = readFileSync(join(KIT, 'deck-stage.js'), 'utf8');
  assert.match(src, /get notes\(\)/, 'a host can read them');
  assert.match(src, /note:\s*\(this\._notes/, 'and the current one rides the slide message');
  const slotChange = src.slice(src.indexOf('_onSlotChange()'));
  assert.match(slotChange.slice(0, 400), /this\._loadNotes\(\)/, 'a late notes block is re-read');
});

// The kit owns the slide animation vocabulary so a deck cannot forget the one
// rule that matters. An authored animation starting at opacity:0 without
// animation-fill-mode — or simply captured mid-flight — produces BLANK SLIDES
// WITH THE CORRECT PAGE COUNT, which is the one failure mode that passes the
// only PDF assertion the contract defines. The audit screenshots proof.html
// (noscale) and the export prints; both are forced to final state here.
test('the injected sheet declares the animation vocabulary with fill-mode both', () => {
  const src = readFileSync(join(KIT, 'deck-stage.js'), 'utf8');
  for (const name of ['deck-rise', 'deck-draw', 'deck-wipe', 'deck-pop', 'deck-count']) {
    assert.match(src, new RegExp(`@keyframes ${name}\\b`), `${name} is missing`);
  }
  assert.match(src, /\[data-deck-anim\][^']*animation-fill-mode: both/,
    'without fill-mode an animation snaps back to its from-state');
});

test('the proof copy and the print sheet both force the animation final state', () => {
  const src = readFileSync(join(KIT, 'deck-stage.js'), 'utf8');
  // Every declaration a final-state block must force. clip-path is what `wipe`
  // animates and stroke-dashoffset is what `draw` animates — drop either from a
  // final-state block and a proof screenshot catches a clipped-away element or
  // an undrawn stroke: blank content at the correct page count, the exact
  // silent failure this whole vocabulary exists to make impossible.
  const REQUIRED = ['animation: none', 'opacity: 1', 'transform: none', 'clip-path: none', 'stroke-dashoffset: 0'];
  // The proof copy — what the audit measures and screenshots — carries `noscale`.
  assert.match(src, /deck-stage\[noscale\] \[data-deck-anim\][^']*animation: none !important/,
    'a screenshot of the proof copy must never catch an animation mid-flight');
  assert.match(src, /deck-stage\[noscale\] \[data-deck-anim\][^']*opacity: 1 !important/);
  const noscaleRules = src.match(/deck-stage\[noscale\] \[data-deck-anim\][^']*/);
  assert.ok(noscaleRules, 'the noscale sheet has no [data-deck-anim] rule');
  for (const decl of REQUIRED) {
    assert.ok(noscaleRules[0].includes(decl), `the noscale rule does not force ${decl}`);
  }
  // ...and the PDF.
  const printRules = src.match(/@media print \{ \[data-deck-anim\][^']*/);
  assert.ok(printRules, 'the print sheet has no [data-deck-anim] rule');
  for (const decl of REQUIRED) {
    assert.ok(printRules[0].includes(decl), `the print rule does not force ${decl}`);
  }
});

test('reduced motion disables the animations', () => {
  const src = readFileSync(join(KIT, 'deck-stage.js'), 'utf8');
  assert.match(src, /@media \(prefers-reduced-motion: reduce\) \{ \[data-deck-anim\] \{ animation: none/);
});

test('the contract documents the animation vocabulary it now owns', () => {
  const contract = readFileSync(join(KIT, 'CONTRACT.md'), 'utf8');
  assert.match(contract, /## Animation/);
  for (const v of ['rise', 'draw', 'wipe', 'pop', 'count']) {
    assert.ok(contract.includes(`\`${v}\``), `CONTRACT.md does not name ${v}`);
  }
});

// M1: the kit forces `transform: none` and `clip-path: none` in BOTH still-frame
// contexts — the proof copy the audit measures and screenshots, and the PDF. That
// is deliberate (a half-played transform must not freeze into a still frame), and
// it silently deletes an author's STATIC transform in exactly the two places the
// deck is checked and shipped: an element nudged out of the slide box with
// `translate` is measured un-transformed and passes every geometry check. The CSS
// stays; the contract has to say so, and so does the agent that writes the deck.
test('the forced final state is documented where a builder will read it', () => {
  const stage = readFileSync(join(KIT, 'deck-stage.js'), 'utf8');
  const forced = stage.match(/transform: none !important; clip-path: none !important/g) || [];
  assert.equal(forced.length, 2,
    'the noscale and @media print final-state blocks are what the contract clause describes');
  assert.match(stage, /deck-stage\[noscale\] \[data-deck-anim\][^\n]*transform: none !important/);
  assert.match(stage, /@media print \{ \[data-deck-anim\][^\n]*transform: none !important/);
  for (const [label, file] of [
    ['CONTRACT.md', join(KIT, 'CONTRACT.md')],
    ['worca-cc-deck-builder.md', join(ROOT, 'agents', 'worca-cc-deck-builder.md')],
  ]) {
    const text = readFileSync(file, 'utf8');
    assert.match(text, /static `transform` or\s*\n?`?clip-path`?|no static `transform` or `clip-path`/,
      `${label} does not forbid a static transform/clip-path on a [data-deck-anim] element`);
  }
});

// M8: the legibility floors moved to 20px / 36px and the prose around them did
// not — `deck-audit.js` still called it "the 48px copy floor" two lines above
// `px < 36`, and a test's own assertion MESSAGE said "the 27px floor", which a
// future debugger reads as fact. The numbers in the words track the numbers in the
// code, or they are worse than no comment at all.
test('the audit only names the floors it actually enforces', () => {
  const audit = readFileSync(join(KIT, 'deck-audit.js'), 'utf8');
  assert.match(audit, /if \(px < 20\) issues\.push\(\{ check: 'small'/);
  assert.match(audit, /if \(px < 36 && isBodyCopy\(el, section\)\)/);
  for (const file of [join(KIT, 'deck-audit.js'), join(ROOT, 'test', 'deck-audit-dom.test.mjs')]) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /\b(?:48|27)px (?:copy |body |`small` )?floor/,
      `${file} names a floor the audit no longer enforces (they are 20px and 36px)`);
  }
});
