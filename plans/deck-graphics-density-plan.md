# Deck Graphics & Density Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make generated decks carry smaller type and kit-owned motion, and produce one self-contained HTML file built by a shipped Python script card.

**Architecture:** Three independent seams. (1) The two type floors `deck-audit.js` actually measures drop, and the contrast pivot moves with them. (2) `deck-stage.js` gains a `data-deck-anim` vocabulary in the document-level sheet it already injects, with proof-copy and print rules that force final state. (3) A new built-in Python script card `deckBundle` inlines the deck into one file and is wired into the Presentation workflow between the reviewer and the export step; `build-standalone.mjs` stays as the fallback for hosts without Python.

**Tech Stack:** Node 22 (`node:test`), jsdom for DOM-level kit tests, Python 3.8+ stdlib only (the `worca_script.py` harness), SQLite schema ladder in `src/core/db.mjs`.

**Spec:** `plans/deck-graphics-density-design.md`

## Global Constraints

- **Python: stdlib only, and it must parse and run on 3.8.** No `match`, no `X | Y` unions, no `str.removeprefix`. The harness runs with `WORCA_HOME` stripped on whatever interpreter the probe found (`src/core/graph/worca_script.py`).
- **`stdout` is protocol-reserved in a Python card.** The harness dups fd 1 and points it at stderr. Use `print()`/`api.log()` freely; never write the result frame yourself.
- **Never edit `assets/deck-kit/deck-*.js` and `docs/why-worca/deck-*.js` independently.** `assets/deck-kit/` is canonical; run `npm run deck:sync` and let `test/deck-kit-sync.test.mjs` prove byte-identity.
- **The design canvas is fixed at 1920×1080.** `deck-audit.js` reports `canvasMismatch` for anything else; every floor below is that canvas's number.
- **Kit version for this whole plan is `1.2.0`.** Bumped once, in Task 1. Task 2 adds to the same version. `CONTRACT.md`'s `Kit version: **1.2.0**` line and `assets/deck-kit/VERSION` must agree or `test/deck-kit-sync.test.mjs` fails.
- **Run the full suite with the repo's own script**, never bare `node --test`: `npm test` (it sets `WORCA_HOME`, puts the no-real-claude shims on `PATH`, and asserts no real `claude` binary was invoked).
- Single-file test runs need the same shims:
  `PATH="$PWD/test/helpers/no-real-claude:$PATH" WORCA_HOME=.worca-cc-tmp node --disable-warning=ExperimentalWarning --test <file>`

---

### Task 1: Lower the measured type floors and move the contrast pivot

**Files:**
- Modify: `assets/deck-kit/deck-audit.js:8-11` (header check list), `:41-45` (canvas note), `:297` (`small`), `:302` (`body`), `:327` (contrast pivot)
- Modify: `assets/deck-kit/VERSION`, `assets/deck-kit/CONTRACT.md:3` (version line), `:91-93` (minimums), `:126-127` (caption note)
- Modify: `agents/worca-cc-deck-builder.md:18`, `agents/worca-cc-deck-system.md:15`, `agents/worca-cc-deck-audit.md`
- Test: `test/deck-audit-dom.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: the new floors, relied on by nothing in code (they are literals inside `deck-audit.js`). Task 2 edits the same kit and must not re-bump `VERSION`.

`deck-audit.js` is a CommonJS UMD module loaded in tests with `require('../assets/deck-kit/deck-audit.js')`. The DOM tests inject geometry: `data-r="left,top,width,height"` becomes `getBoundingClientRect()`, `data-scroll="scrollWidth,clientWidth"` the scroll metrics. Assertions filter with `checksOf(slide, check)` because jsdom's default black-on-transparent styling produces contrast noise that would otherwise mask the property under test.

- [ ] **Step 1: Write the failing tests**

Append to `test/deck-audit-dom.test.mjs`:

```javascript
// The floors this kit measures were lowered so a slide can spend its area on
// figures instead of type: `small` 27 -> 20, `body` 48 -> 36. Only these two are
// measured; the 72px title and 60px icon in CONTRACT.md are guidance and no check
// has ever read them.
test('the small floor is 20px: 20px passes, 19px reports', () => {
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01">`
    + `<p data-r="40,200,800,30"><span data-r="40,200,800,30" style="font-size:20px">At the floor</span></p>`
    + `</section>`,
    `<section ${SLIDE_BOX} data-label="02">`
    + `<p data-r="40,200,800,30"><span data-r="40,200,800,30" style="font-size:19px">Under it</span></p>`
    + `</section>`,
  );
  const [ok, under] = DeckAudit.run(win.document, win).slides;
  assert.deepEqual(checksOf(ok, 'small'), [], '20px is legal now');
  assert.equal(checksOf(under, 'small').length, 1, '19px is not');
  assert.match(checksOf(under, 'small')[0].detail, /floor 20px/);
});

test('the body floor is 36px: 36px passes, 35px reports', () => {
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01">`
    + `<p data-r="40,200,800,50"><span data-r="40,200,800,50" style="font-size:36px">At the floor</span></p>`
    + `</section>`,
    `<section ${SLIDE_BOX} data-label="02">`
    + `<p data-r="40,200,800,50"><span data-r="40,200,800,50" style="font-size:35px">Under it</span></p>`
    + `</section>`,
  );
  const [ok, under] = DeckAudit.run(win.document, win).slides;
  assert.deepEqual(checksOf(ok, 'body'), [], '36px body copy is legal now');
  assert.equal(checksOf(under, 'body').length, 1, '35px is not');
  assert.match(checksOf(under, 'body')[0].detail, /floor 36px/);
});

// THE REGRESSION THE PIVOT MOVE PREVENTS. The contrast floor is relaxed from
// 4.5:1 to 3:1 for "large" text. With the pivot left at 36px, body copy set at
// its new 36px floor would land on `px >= 36` and silently inherit the 3:1
// allowance — smaller AND lower-contrast type from one edit, with nothing
// reported. The pivot moves to 48px so 36px copy keeps the real requirement.
test('36px text keeps the 4.5:1 contrast floor', () => {
  // MEASURED on white: #767676 is 4.542:1 (legal either way) and #8a8a8a is
  // 3.452:1 — legal under a 3:1 floor, a failure under 4.5:1. That gap is the
  // whole discriminator, so use this exact grey.
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01" style="background-color:rgb(255,255,255)">`
    + `<p data-r="40,200,800,50"><span data-r="40,200,800,50" style="font-size:36px;color:rgb(138,138,138)">Mid grey</span></p>`
    + `</section>`,
  );
  win.document.body.style.backgroundColor = UNSTYLED_BODY;
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.equal(checksOf(slide, 'contrast').length, 1, '3.45:1 at 36px must fail the 4.5:1 floor');
  assert.match(checksOf(slide, 'contrast')[0].detail, /floor 4\.5:1/);
});

test('48px text gets the relaxed 3:1 floor', () => {
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01" style="background-color:rgb(255,255,255)">`
    + `<h1 data-r="40,40,800,60" style="font-size:48px;color:rgb(138,138,138)">Large grey</h1>`
    + `</section>`,
  );
  win.document.body.style.backgroundColor = UNSTYLED_BODY;
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.deepEqual(checksOf(slide, 'contrast'), [], '3.45:1 at 48px clears the 3:1 floor');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
PATH="$PWD/test/helpers/no-real-claude:$PATH" WORCA_HOME=.worca-cc-tmp \
  node --disable-warning=ExperimentalWarning --test test/deck-audit-dom.test.mjs
```

Expected: FAIL. `20px` reports `small` (floor is still 27), `36px` reports `body` (floor is still 48), and the 36px contrast case reports nothing (the pivot still relaxes it to 3:1).

- [ ] **Step 3: Lower the two floors and move the pivot**

`assets/deck-kit/deck-audit.js:297` — replace:

```javascript
        if (px < 27) issues.push({ check: 'small', selector: sel, detail: `${px}px text (floor 27px)` });
```

with:

```javascript
        if (px < 20) issues.push({ check: 'small', selector: sel, detail: `${px}px text (floor 20px)` });
```

`:302` — replace:

```javascript
        if (px < 48 && isBodyCopy(el, section)) issues.push({ check: 'body', selector: sel, detail: `${px}px body text (floor 48px)` });
```

with:

```javascript
        if (px < 36 && isBodyCopy(el, section)) issues.push({ check: 'body', selector: sel, detail: `${px}px body text (floor 36px)` });
```

`:327` — replace:

```javascript
          const floor = px >= 36 ? 3 : 4.5;
```

with:

```javascript
          // The pivot is the BODY FLOOR, not a number of its own. WCAG relaxes
          // contrast for large text, and with the body floor at 36px a pivot of 36
          // would hand every piece of body copy set at its floor the 3:1 allowance —
          // so lowering the type would quietly lower the contrast requirement too,
          // with nothing reported. 48px is where type is genuinely large.
          const floor = px >= 48 ? 3 : 4.5;
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
PATH="$PWD/test/helpers/no-real-claude:$PATH" WORCA_HOME=.worca-cc-tmp \
  node --disable-warning=ExperimentalWarning --test test/deck-audit-dom.test.mjs
```

Expected: PASS, and every pre-existing test in the file still passes. Two existing tests name the old numbers in their titles/messages — `'the body floor applies to copy wrapped inside a p or li'` (uses 32px, still under 36, still 2 findings) and `'a heading nested in a non-body element is not held to the body floor'` (message says "48px floor"). Update that message to `36px floor`; do not change the test's logic.

- [ ] **Step 5: Update the stated minimums everywhere they appear**

`assets/deck-kit/deck-audit.js:8-11` — the header check list:

```javascript
 *   contrast  computed fg/bg ratio below 4.5:1 (< 48px text) or 3:1 (>= 48px)
 *   small     text below 20px
 *   body      p/li/blockquote text below 36px
```

`assets/deck-kit/deck-audit.js:41-45` — the canvas note says "the floors below (27px / 48px)"; make it `(20px / 36px)`.

`assets/deck-kit/CONTRACT.md:91-93`:

```markdown
- body text ≥ 36px, slide title ≥ 56px, icon beside text ≥ 44px.
- text contrast ≥ 4.5:1 (≥ 3:1 for text ≥ 48px).
- no text under 20px.
```

`assets/deck-kit/CONTRACT.md:126-127` — "the 1920×1080 box, the 27px floor and the 48px body floor" becomes "the 20px floor and the 36px body floor".

`agents/worca-cc-deck-builder.md:18` — the minimums sentence becomes:

```markdown
- The design canvas is **1920×1080**. Minimums: body text 36px, slide title 56px, icon beside text 44px, text contrast 4.5:1 (3:1 at ≥ 48px), no text under 20px, ≤ 30 words on a live slide.
```

`agents/worca-cc-deck-system.md:15` — this line claims "the skill's minimums scale by 1.5", which stops being true. Replace the whole line with:

```markdown
The canvas is **1920×1080**. Minimums: body 36px, slide title 56px, icon beside text 44px; contrast 4.5:1 (3:1 for text ≥ 48px); ≤ 30 words per live slide. These sit BELOW the six-foot-test defaults on purpose: the deck is meant to spend its area on figures, not on type. Smaller type is not licence for more words — the 30-word cap is unchanged, and the space you save belongs to the graphic.
```

`agents/worca-cc-deck-audit.md` — the `small`/`body` severity row already names the checks rather than the numbers; if any sentence quotes 27 or 48, update it to 20/36. Leave the `words` row alone: **the cap stays 30.**

- [ ] **Step 6: Bump the kit version**

`assets/deck-kit/VERSION` → `1.2.0` (single line, no trailing text).
`assets/deck-kit/CONTRACT.md:3` → `Kit version: **1.2.0**`.

`test/deck-kit-sync.test.mjs` asserts these two agree and that `CONTRACT.md`'s `generator` meta stays the `<VERSION>` placeholder — do not hardcode a number there.

- [ ] **Step 7: Verify the kit tests pass**

```bash
PATH="$PWD/test/helpers/no-real-claude:$PATH" WORCA_HOME=.worca-cc-tmp \
  node --disable-warning=ExperimentalWarning --test test/deck-kit-sync.test.mjs test/deck-audit-dom.test.mjs test/deck-audit-kit.test.mjs
```

Expected: PASS. `deck-audit.js` is not in the kit's `SYNCED` list, so no `deck:sync` run is needed yet.

- [ ] **Step 8: Commit**

```bash
git add assets/deck-kit/deck-audit.js assets/deck-kit/VERSION assets/deck-kit/CONTRACT.md \
        agents/worca-cc-deck-builder.md agents/worca-cc-deck-system.md agents/worca-cc-deck-audit.md \
        test/deck-audit-dom.test.mjs
git commit -m "deck-kit: lower the measured type floors to 20px/36px, move the contrast pivot to 48px

The body floor and the contrast pivot were both 36-adjacent, so lowering type
alone would have handed every piece of body copy the relaxed 3:1 allowance with
nothing reported. The pivot follows the body floor instead."
```

---

### Task 2: Kit-owned `data-deck-anim` vocabulary

**Files:**
- Modify: `assets/deck-kit/deck-stage.js:1133-1157` (`_syncPrintPageRule` → `_syncDocumentSheet`) and its call sites
- Modify: `assets/deck-kit/CONTRACT.md` (new **Animation** section after **Reveals**)
- Modify: `agents/worca-cc-deck-builder.md`, `agents/worca-cc-deck-system.md`
- Modify: `docs/why-worca/deck-stage.js` (via `npm run deck:sync`, never by hand)
- Test: `test/deck-kit-sync.test.mjs`

**Interfaces:**
- Consumes: kit version `1.2.0` from Task 1 (do not bump again).
- Produces: the `data-deck-anim` attribute contract, consumed only by generated decks. No JS export changes.

**Why the document sheet and not the shadow sheet.** The `<section>` slides are **light-DOM** content slotted into the shadow stage, so shadow-DOM rules never reach them. That is exactly why `[data-deck-caption]` already lives in this injected `<style id="deck-stage-print-page">` rather than in the shadow sheet. The animation rules go in the same tag for the same reason.

- [ ] **Step 1: Write the failing tests**

Append to `test/deck-kit-sync.test.mjs`:

```javascript
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
  // The proof copy — what the audit measures and screenshots — carries `noscale`.
  assert.match(src, /deck-stage\[noscale\] \[data-deck-anim\][^']*animation: none !important/,
    'a screenshot of the proof copy must never catch an animation mid-flight');
  assert.match(src, /deck-stage\[noscale\] \[data-deck-anim\][^']*opacity: 1 !important/);
  // ...and the PDF.
  const printRules = src.match(/@media print \{ \[data-deck-anim\][^']*/);
  assert.ok(printRules, 'the print sheet has no [data-deck-anim] rule');
  for (const decl of ['animation: none', 'opacity: 1', 'transform: none']) {
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
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
PATH="$PWD/test/helpers/no-real-claude:$PATH" WORCA_HOME=.worca-cc-tmp \
  node --disable-warning=ExperimentalWarning --test test/deck-kit-sync.test.mjs
```

Expected: FAIL — four new tests, no `@keyframes deck-rise` anywhere in the kit.

- [ ] **Step 3: Add the vocabulary to the injected document sheet**

In `assets/deck-kit/deck-stage.js`, rename `_syncPrintPageRule()` to `_syncDocumentSheet()` (it has carried more than `@page` since the caption band landed) and update every call site:

```bash
grep -n "_syncPrintPageRule" assets/deck-kit/deck-stage.js
```

Keep the element id `deck-stage-print-page` unchanged — it is the dedupe key across mounts.

Then append to the `tag.textContent` expression, after the existing caption lines:

```javascript
        '[data-deck-caption] { display: none; } ' +
        '@media print { [data-deck-caption] { display: block; } } ' +
        // ── Slide animation, kit-owned ────────────────────────────────────────
        // Declared here, not in the deck's own <style>, for the caption band's
        // reason and one worse: a missed animation-fill-mode, or a still frame
        // taken mid-flight, yields BLANK SLIDES AT THE RIGHT PAGE COUNT — and the
        // page-count assertion is the only one the contract defines for the PDF,
        // so the failure passes every gate. The two final-state blocks at the
        // bottom make that unreachable rather than merely unlikely.
        '@keyframes deck-rise { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: none; } } ' +
        '@keyframes deck-draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } } ' +
        '@keyframes deck-wipe { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0); } } ' +
        '@keyframes deck-pop { from { opacity: 0; transform: scale(.92); } to { opacity: 1; transform: none; } } ' +
        '@keyframes deck-count { from { opacity: 0; } to { opacity: 1; } } ' +
        '[data-deck-anim] { animation-duration: .55s; animation-timing-function: cubic-bezier(.2,.8,.2,1); animation-fill-mode: both; } ' +
        '[data-deck-anim="rise"] { animation-name: deck-rise; } ' +
        '[data-deck-anim="draw"] { animation-name: deck-draw; } ' +
        '[data-deck-anim="wipe"] { animation-name: deck-wipe; } ' +
        '[data-deck-anim="pop"] { animation-name: deck-pop; } ' +
        '[data-deck-anim="count"] { animation-name: deck-count; } ' +
        // A tagged element that is ALSO a [data-step] waits for its reveal instead
        // of animating at mount: deck-enhance.js toggles .step-visible, and the
        // deck's own stylesheet owns whether an unrevealed step is hidden at all.
        '[data-step]:not(.step-visible)[data-deck-anim] { animation-play-state: paused; } ' +
        '@media (prefers-reduced-motion: reduce) { [data-deck-anim] { animation: none !important; } } ' +
        // FINAL STATE, unconditionally, in the two places a still frame is taken.
        // proof.html carries `noscale` and is what the audit measures and shoots.
        'deck-stage[noscale] [data-deck-anim] { animation: none !important; animation-play-state: running !important; '
          + 'opacity: 1 !important; transform: none !important; clip-path: none !important; stroke-dashoffset: 0 !important; } ' +
        '@media print { [data-deck-anim] { animation: none !important; opacity: 1 !important; transform: none !important; '
          + 'clip-path: none !important; stroke-dashoffset: 0 !important; } }';
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
PATH="$PWD/test/helpers/no-real-claude:$PATH" WORCA_HOME=.worca-cc-tmp \
  node --disable-warning=ExperimentalWarning --test test/deck-kit-sync.test.mjs
```

Expected: the three CSS tests PASS; `'the contract documents the animation vocabulary it now owns'` still FAILS (Step 5), and `'every synced kit file is byte-identical in docs/why-worca'` now FAILS because `deck-stage.js` changed (Step 6).

- [ ] **Step 5: Document the contract**

Insert into `assets/deck-kit/CONTRACT.md` immediately after the `## Reveals` section:

```markdown
## Animation

Tag any element with `data-deck-anim` and the kit animates it. One attribute is
the whole author surface:

| value | what it does |
|---|---|
| `rise` | fades up 24px — the default for a line or a block arriving |
| `draw` | draws an SVG stroke (`pathLength="1"` on the path) |
| `wipe` | wipes in from the left — bars, rules, timelines |
| `pop` | scales up from 92% — a single number or badge |
| `count` | fades in only; a digit tween is your own script's job |

**Never write your own `animation`, `@keyframes`, `animation-fill-mode` or
`transition` for a `[data-deck-anim]` element.** The kit owns all of it, for the
same reason it owns the caption band's visibility and harder: an animation that
starts at `opacity: 0` and loses its fill-mode — or that a still frame catches
mid-flight — renders **blank slides with the correct page count**, and the page
count is the only thing the PDF check can assert. `deck-stage.js` forces the
final state under `<deck-stage noscale>` (the proof copy the audit measures and
screenshots) and under `@media print` (the PDF), so neither still frame can catch
motion. Write your own rules and you are back to the silent failure.

Motion composes with reveals: an element that is both `[data-step]` and
`[data-deck-anim]` animates when its step reveals it, not at mount. Respect
`prefers-reduced-motion` is automatic — the kit disables the animations there.

Assign motion in `visual-system.md` per composition, not per slide. A deck where
every element rises is as undesigned as one where nothing moves.
```

- [ ] **Step 6: Sync the kit copy and verify byte-identity**

```bash
npm run deck:sync
git diff --stat docs/why-worca/
PATH="$PWD/test/helpers/no-real-claude:$PATH" WORCA_HOME=.worca-cc-tmp \
  node --disable-warning=ExperimentalWarning --test test/deck-kit-sync.test.mjs
```

Expected: `docs/why-worca/deck-stage.js` changes; all tests PASS. Never hand-edit the `docs/why-worca/` copy.

- [ ] **Step 7: Teach the two agents the vocabulary**

`agents/worca-cc-deck-builder.md` — add after the Reveals bullet:

```markdown
- **Animation is one attribute.** `data-deck-anim="rise|draw|wipe|pop|count"` on any element; the kit owns the keyframes, the reduced-motion fallback, and the final state the audit's screenshots and the PDF must show. **Never write your own `animation`, `@keyframes` or `transition` for a tagged element** — a lost fill-mode renders blank slides at the right page count, which passes every gate this pipeline has. Motion composes with `[data-step]`: a tagged step animates when it reveals.
```

`agents/worca-cc-deck-system.md` — add to the Compositions section:

```markdown
- `## Motion` — one line per composition naming which `data-deck-anim` value it uses, or `none`. At most two values across the deck, and the hero moment may have one of its own. A system where every composition rises is not a system.
```

- [ ] **Step 8: Run the deck suites and commit**

```bash
PATH="$PWD/test/helpers/no-real-claude:$PATH" WORCA_HOME=.worca-cc-tmp \
  node --disable-warning=ExperimentalWarning --test test/deck-kit-sync.test.mjs test/deck-audit-dom.test.mjs test/deck-enhance-boot.test.mjs test/deck-standalone-fonts.test.mjs
git add assets/deck-kit/deck-stage.js assets/deck-kit/CONTRACT.md docs/why-worca/deck-stage.js \
        agents/worca-cc-deck-builder.md agents/worca-cc-deck-system.md test/deck-kit-sync.test.mjs
git commit -m "deck-kit: a kit-owned data-deck-anim vocabulary that cannot ship blank slides

The keyframes, the reduced-motion fallback and — the point — the forced final
state under [noscale] and @media print all live in the injected document sheet,
so neither the audit's screenshots nor the PDF can catch an animation mid-flight."
```

---

### Task 3: The `deckBundle` Python script card

**Files:**
- Create: `scripts/deckBundle.meta.json`, `scripts/deck-bundle.py`
- Test: `test/deck-bundle-script.test.mjs` (new)
- Modify: `test/script-builtins.test.mjs:46`, `test/api-scripts.test.mjs:41`, `test/script-store.test.mjs:241`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: script key `deckBundle`, `order: 40`, runtime `python`, program `deck-bundle.py`. Ports: input `built` (md); outputs `bundle` (md, `when: "always"`), `findings` (md, `when: "blocking"`, **same filename as `bundle`**), `pass` (void, `when: "clean"`); verdict `deck-bundle-cycle{cycle}.json`. Task 4 wires exactly these port ids.

Three things about this sidecar are load-bearing:

1. **`bundle` and `findings` share one filename.** `runMock` throws if *any* declared non-void output is left unwritten, and `findings` is `when: "blocking"` so it has an allocated path even on a clean run. Sharing the template means one mock write satisfies both. This is the shipped `shell` card's own trick (`scripts/shell.meta.json` feeds `log` and `fail` from `shell-cycle{cycle}.md`), and `sharedFilenameRule` permits it because both ports are `md`.
2. **Do not declare an `await` input.** `AWAIT_PORT` is synthetic — `portsFnFor` appends it and `buildEnvelope` skips it (`p.id === AWAIT_ID || p.synthetic`). Declaring it by hand creates a second, real port.
3. **A `mock` block is mandatory.** `script-runner.mjs:458-463`: a card with no mock of its own **runs for real on a mock run**. Without one, `test/presentation-golden-run.test.mjs` would spawn Python on every CI run.

- [ ] **Step 1: Write the failing test**

Create `test/deck-bundle-script.test.mjs`:

```javascript
// test/deck-bundle-script.test.mjs — the deckBundle card's program, for real.
//
// Skipped when the host has no interpreter: the card is wired into the shipped
// Presentation workflow but build-standalone.mjs remains the fallback, so a
// python-less machine is a supported configuration, not a broken one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScriptExecution } from '../src/core/graph/script-runner.mjs';
import { loadScriptRegistry } from '../src/core/script-registry.mjs';
import { probePython } from '../src/core/graph/python-probe.mjs';

const REG = loadScriptRegistry({ userScriptsDir: null });
const META = REG.deckBundle;

// A deck whose inlined source CONTAINS a complete script tag pair, and an HTML
// comment that does too. Both are real: deck-stage.js:57 carries
// `<script src="deck-stage.js"></script>` in its header comment, and the kit's
// own bundler comments out the audio tag. A live-tag check that does not strip
// script bodies and HTML comments first reports a CORRECT bundle as broken.
const KIT_SRC = `/* usage:\n *   <script src="deck-stage.js"></script>\n */\nwindow.__kit = 1;\n`;

async function fixtureDeck() {
  const pdir = await mkdtemp(join(tmpdir(), 'worca-deckbundle-'));
  const deck = join(pdir, 'deck');
  await mkdir(deck, { recursive: true });
  await writeFile(join(deck, 'deck-stage.js'), KIT_SRC, 'utf8');
  await writeFile(join(deck, 'deck-enhance.js'), 'window.__enhance = 1;\n', 'utf8');
  // A 1x1 PNG the deck references, so the image branch is exercised.
  await writeFile(join(deck, 'logo.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  await writeFile(join(deck, 'deck.html'),
    '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><meta name="generator" content="OpenDeck 1.2.0">'
    + '<style>@font-face { font-family: X; src: url("logo.png"); }</style></head><body>\n'
    + '<!-- <script src="narration-audio.js"></script> -->\n'
    + '<deck-stage width="1920" height="1080"><section data-label="01"><h1>One</h1>'
    + '<img src="logo.png" alt="logo"></section></deck-stage>\n'
    + '<script src="deck-stage.js"></script>\n<script src="deck-enhance.js"></script>\n'
    + '</body></html>\n', 'utf8');
  return { pdir, deck };
}

function ctxFor(pdir) {
  const ports = { inputs: META.inputs, outputs: META.outputs };
  const outputs = {
    bundle: { path: join(pdir, 'deck-bundle-cycle1.md') },
    findings: { path: join(pdir, 'deck-bundle-cycle1.md') },
  };
  return {
    node: { id: 'n_bundle', kind: 'script', key: 'deckBundle' },
    ordinal: 1,
    ports,
    bindings: { built: { path: join(pdir, 'deck-manifest.md') } },
    outputs,
    verdict: { path: join(pdir, 'deck-bundle-cycle1.json') },
    pipelineDir: pdir,
    projectDir: pdir,
    script: { meta: META, runtime: META.runtime, file: META.file, params: {}, timeoutMs: 120000 },
    claudeOpts: {},
    onEvent: () => {},
  };
}

test('deckBundle inlines a deck into one file and reports it clean', async (t) => {
  const py = await probePython();
  if (!py.ok) return t.skip(`no python on this host: ${py.reason}`);

  const { pdir, deck } = await fixtureDeck();
  await writeFile(join(pdir, 'deck-manifest.md'), '# Deck manifest\nMode: live   Slides: 1\n', 'utf8');

  const res = await runScriptExecution(ctxFor(pdir));

  assert.deepEqual(res.verdict.issues, [], JSON.stringify(res.verdict));
  const out = await readFile(join(deck, 'deck.standalone.html'), 'utf8');
  assert.ok(out.includes('window.__kit = 1;'), 'deck-stage.js was not inlined');
  assert.ok(out.includes('window.__enhance = 1;'), 'deck-enhance.js was not inlined');
  assert.ok(out.includes('data:image/png;base64,'), 'the image was not embedded');
  assert.ok(!/<img[^>]+src=("|')logo\.png/.test(out), 'the img still points at a sibling');
});

// THE TRAP. The inlined kit source and the HTML comment each contain a COMPLETE
// `<script src="…"></script>` pair, so a naive live-tag search reports 1 on a
// correct bundle — measured against the real docs/why-worca standalone, which
// matches once. The check must strip HTML comments and inlined script bodies
// first, or the card blocks every successful run.
test('a correct bundle verifies clean even though its inlined source contains a full script tag', async (t) => {
  const py = await probePython();
  if (!py.ok) return t.skip(`no python on this host: ${py.reason}`);

  const { pdir, deck } = await fixtureDeck();
  await writeFile(join(pdir, 'deck-manifest.md'), '# Deck manifest\nMode: live   Slides: 1\n', 'utf8');
  const res = await runScriptExecution(ctxFor(pdir));

  const out = await readFile(join(deck, 'deck.standalone.html'), 'utf8');
  assert.ok(out.includes('<script src="deck-stage.js"></script>'),
    'the fixture no longer exercises the trap — the inlined comment is gone');
  assert.deepEqual(res.verdict.issues, [], 'a correct bundle must not be reported as non-standalone');
});

test('a deck that still reaches for a sibling it cannot inline is a blocking finding', async (t) => {
  const py = await probePython();
  if (!py.ok) return t.skip(`no python on this host: ${py.reason}`);

  const { pdir, deck } = await fixtureDeck();
  await writeFile(join(pdir, 'deck-manifest.md'), '# Deck manifest\nMode: live   Slides: 1\n', 'utf8');
  // A CDN reference: remote, so it cannot be inlined, and it makes the result
  // non-standalone. This is the builder mistake the loop exists to send back.
  const html = await readFile(join(deck, 'deck.html'), 'utf8');
  await writeFile(join(deck, 'deck.html'),
    html.replace('</body>', '<script src="https://cdn.example.com/x.js"></script>\n</body>'), 'utf8');

  const res = await runScriptExecution(ctxFor(pdir));
  assert.ok(res.verdict.issues.length > 0, 'a remote script must block');
  assert.ok(res.verdict.issues.some((i) => /cdn\.example\.com/.test(i.detail || '')),
    JSON.stringify(res.verdict.issues));
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
PATH="$PWD/test/helpers/no-real-claude:$PATH" WORCA_HOME=.worca-cc-tmp \
  node --disable-warning=ExperimentalWarning --test test/deck-bundle-script.test.mjs
```

Expected: FAIL — `REG.deckBundle` is `undefined`, so `META.inputs` throws `TypeError`.

- [ ] **Step 3: Write the sidecar**

Create `scripts/deckBundle.meta.json`:

```json
{
  "key": "deckBundle",
  "metaVersion": 2,
  "displayName": "Deck bundle",
  "description": "Inlines a built deck into one self-contained HTML file: every local script, stylesheet, image and font becomes a data URI. Verifies the result reaches for nothing beside it.",
  "domain": "presentation",
  "color": "green",
  "icon": "<path d=\"M4 7h16v13H4z\" fill=\"none\"/><path d=\"M4 7l2-3h12l2 3\" stroke-linejoin=\"round\" fill=\"none\"/><path d=\"M12 11v5M9.5 13.5L12 16l2.5-2.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" fill=\"none\"/>",
  "order": 40,
  "runtime": "python",
  "file": "deck-bundle.py",
  "timeoutMs": 300000,
  "inputs": [
    { "id": "built", "type": "md" }
  ],
  "outputs": [
    { "id": "bundle", "type": "md", "when": "always", "filename": "deck-bundle-cycle{cycle}.md",
      "artifactKind": "deck-bundle",
      "extraFiles": [{ "kind": "deck", "glob": "deck/deck*.html" }] },
    { "id": "findings", "type": "md", "when": "blocking", "filename": "deck-bundle-cycle{cycle}.md",
      "artifactKind": "deck-bundle" },
    { "id": "pass", "type": "void", "when": "clean" }
  ],
  "verdict": { "filename": "deck-bundle-cycle{cycle}.json" },
  "mock": {
    "summary": "1 deck bundled (mock): deck/deck.standalone.html.",
    "verdict": { "issues": [] },
    "outputs": {
      "bundle": { "text": "# Deck bundle — mock\n\n- deck/deck.standalone.html — self-contained\n\nNo blocking findings.\n" }
    }
  }
}
```

- [ ] **Step 4: Write the program**

Create `scripts/deck-bundle.py`:

```python
# scripts/deck-bundle.py — the `deckBundle` card: inline a built deck into ONE
# self-contained .html, then prove it reaches for nothing beside it.
#
# The headless twin of deck-export.js (which needs a browser and http) and of
# deck-kit/build-standalone.mjs (which stays in the kit as the fallback for hosts
# with no interpreter). Imports nothing from worca and nothing outside the
# standard library — it runs with WORCA_HOME stripped, on whatever interpreter
# the probe found — and must parse on python 3.8.
#
# stdout is protocol-reserved: the harness keeps a private handle for the result
# frame and points fd 1 at stderr, so print() goes to the run log.
import base64
import os
import re
import sys

MIME = {
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
    '.otf': 'font/otf', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
}

SCRIPT_TAG = re.compile(r'<script([^>]*?)\ssrc=("|\')([^"\']+)\2([^>]*?)>\s*</script\s*>', re.I)
SHEET_TAG = re.compile(r'<link([^>]*?)\shref=("|\')([^"\']+)\2([^>]*?)>', re.I)
IMG_SRC = re.compile(r'(<img[^>]*?\ssrc=)("|\')([^"\']+)\2', re.I)
CSS_URL = re.compile(r'url\(\s*("|\')?([^"\')]+)\1?\s*\)', re.I)

# Stripped BEFORE the live-reference check, and this is not cosmetic. The kit's
# own source carries `<script src="deck-stage.js"></script>` in a header comment
# (deck-stage.js:57) and the bundler comments the audio tag out, so a naive
# whole-tag search reports a CORRECT bundle as broken — measured: the real
# docs/why-worca standalone matches such a search exactly once. Strip HTML
# comments and the bodies of inlined (src-less) scripts, and what is left is
# genuinely live markup.
HTML_COMMENT = re.compile(r'<!--.*?-->', re.S)
INLINED_SCRIPT = re.compile(r'<script(?![^>]*\ssrc=)[^>]*>.*?</script\s*>', re.I | re.S)
LIVE_SCRIPT = re.compile(r'<script[^>]*\ssrc=("|\')[^"\']+\2[^>]*>\s*</script\s*>', re.I)
LIVE_SHEET = re.compile(r'<link[^>]*rel=("|\')?stylesheet', re.I)


def is_remote(url):
    return bool(re.match(r'^(?:[a-z][a-z0-9+.-]*:|//)', url.strip(), re.I))


def mime_for(path):
    return MIME.get(os.path.splitext(path.split('?')[0].split('#')[0])[1].lower(),
                    'application/octet-stream')


def local_path(base_dir, href):
    return os.path.join(base_dir, href.split('?')[0].split('#')[0].lstrip('/'))


def data_uri(base_dir, href):
    path = local_path(base_dir, href)
    with open(path, 'rb') as fh:
        raw = fh.read()
    return 'data:' + mime_for(href) + ';base64,' + base64.b64encode(raw).decode('ascii')


def read_text(path):
    with open(path, 'r', encoding='utf-8', errors='replace') as fh:
        return fh.read()


def inline_css_urls(css, base_dir, missing):
    """Every local url() in a stylesheet becomes a data URI (webfonts, sprites)."""
    def swap(m):
        href = m.group(2)
        if is_remote(href) or href.startswith('data:'):
            return m.group(0)
        try:
            return 'url("' + data_uri(base_dir, href) + '")'
        except OSError:
            missing.append(href)
            return m.group(0)
    return CSS_URL.sub(swap, css)


def bundle(html, base_dir, missing, remote):
    """Inline every local companion. Order matters: scripts and sheets first (they
    can themselves reference assets), then the document's own img/style urls."""

    def swap_script(m):
        href = m.group(3)
        if is_remote(href):
            remote.append(href)
            return m.group(0)
        try:
            src = read_text(local_path(base_dir, href))
        except OSError:
            missing.append(href)
            return m.group(0)
        # A payload containing `</script` would close the tag early; the escape is
        # invisible to JS inside a string or comment and is the standard one.
        return '<script>/* ' + href + ' */\n' + src.replace('</script', '<\\/script') + '\n</script>'

    def swap_sheet(m):
        attrs = (m.group(1) or '') + (m.group(4) or '')
        href = m.group(3)
        if 'stylesheet' not in attrs.lower():
            return m.group(0)
        if is_remote(href):
            remote.append(href)
            return m.group(0)
        try:
            css = read_text(local_path(base_dir, href))
        except OSError:
            missing.append(href)
            return m.group(0)
        return '<style>/* ' + href + ' */\n' + inline_css_urls(css, base_dir, missing) + '\n</style>'

    def swap_img(m):
        href = m.group(3)
        if is_remote(href) or href.startswith('data:'):
            return m.group(0)
        try:
            return m.group(1) + '"' + data_uri(base_dir, href) + '"'
        except OSError:
            missing.append(href)
            return m.group(0)

    out = SCRIPT_TAG.sub(swap_script, html)
    out = SHEET_TAG.sub(swap_sheet, out)
    out = IMG_SRC.sub(swap_img, out)
    # The deck's own <style> block: @font-face and background urls live here,
    # because CONTRACT.md puts every rule in one inline block.
    out = inline_css_urls(out, base_dir, missing)
    return out


def live_refs(doc):
    bare = INLINED_SCRIPT.sub('<script></script>', HTML_COMMENT.sub('', doc))
    return LIVE_SCRIPT.findall(bare), LIVE_SHEET.findall(bare)


def main(api):
    pdir = api.ctx.pipelineDir
    deck_dir = os.path.join(pdir, 'deck')
    source = os.path.join(deck_dir, 'deck.html')
    out_path = os.path.join(deck_dir, 'deck.standalone.html')

    issues = []
    if not os.path.isfile(source):
        issues.append({
            'severity': 'critical',
            'title': 'No deck to bundle',
            'detail': 'deck/deck.html does not exist in the pipeline directory.',
            'location': 'deck/deck.html',
        })
        return report(api, issues, None, 0)

    missing = []
    remote = []
    bundled = bundle(read_text(source), deck_dir, missing, remote)
    with open(out_path, 'w', encoding='utf-8') as fh:
        fh.write(bundled)
    size = os.path.getsize(out_path)
    print('bundled %s -> %s (%d bytes)' % (source, out_path, size))

    for href in sorted(set(remote)):
        issues.append({
            'severity': 'major',
            'title': 'The deck loads a remote asset, so it cannot be self-contained',
            'detail': 'deck.html references ' + href + '. CONTRACT.md forbids CDNs — they '
                      'fail silently under the artifact CSP. Copy the file into deck/ and '
                      'reference it relatively.',
            'location': 'deck/deck.html',
        })
    for href in sorted(set(missing)):
        issues.append({
            'severity': 'major',
            'title': 'A companion file the deck references is not on disk',
            'detail': 'deck.html references ' + href + ', which does not exist beside it, '
                      'so it could not be inlined.',
            'location': 'deck/' + href,
        })

    scripts, sheets = live_refs(bundled)
    if scripts or sheets:
        issues.append({
            'severity': 'major',
            'title': 'The bundle still reaches for a sibling file',
            'detail': '%d live <script src> and %d live stylesheet link(s) remain after '
                      'stripping HTML comments and inlined script bodies.' % (len(scripts), len(sheets)),
            'location': 'deck/deck.standalone.html',
        })

    return report(api, issues, out_path, size)


def report(api, issues, out_path, size):
    blocking = [i for i in issues if i['severity'] in ('critical', 'major')]
    summary = ('deck/deck.standalone.html — %d bytes, self-contained.' % size) if not blocking \
        else ('deck/deck.standalone.html — %d issue(s) block the deliverable.' % len(blocking))
    lines = ['# Deck bundle', '', summary, '']
    for i in issues:
        lines.append('- **[%s]** %s — %s' % (i['severity'], i['title'], i['detail']))
    if not issues:
        lines.append('No blocking findings.')
    body = '\n'.join(lines) + '\n'

    # `bundle` and `findings` share one filename, so this single write satisfies
    # both allocated paths whichever way the verdict goes.
    for port in ('bundle', 'findings'):
        p = api.outputs.get(port)
        path = p.get('path') if p else None
        if path:
            with open(path, 'w', encoding='utf-8') as fh:
                fh.write(body)

    return {'verdict': {'issues': issues, 'summary': summary}, 'summary': summary}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
PATH="$PWD/test/helpers/no-real-claude:$PATH" WORCA_HOME=.worca-cc-tmp \
  node --disable-warning=ExperimentalWarning --test test/deck-bundle-script.test.mjs
```

Expected: PASS (3 tests), or 3 skips on a host with no interpreter. If they skip, run `python3 -V` and confirm — a silent skip is not a pass.

- [ ] **Step 6: Update the three exact-set assertions**

`deckBundle` has `order: 40`, so it sorts after `gitDiff` (30) and before a user script with no `order` (`DEFAULT_ORDER` 999).

`test/script-builtins.test.mjs:45-46`:

```javascript
test('the built-in layer is exactly shell, js, py, gitDiff, deckBundle — normalized, ordered, and disjoint from the agent keys', () => {
  assert.deepEqual(Object.keys(REG), ['shell', 'js', 'py', 'gitDiff', 'deckBundle']);
```

`test/api-scripts.test.mjs:41`:

```javascript
  assert.deepEqual(scripts.map((s) => s.key), ['shell', 'js', 'py', 'gitDiff', 'deckBundle', 'lint']);
```

`test/script-store.test.mjs:241`:

```javascript
  assert.deepEqual(list.map((s) => s.key), ['shell', 'js', 'py', 'gitDiff', 'deckBundle', 'lint']);
```

- [ ] **Step 7: Verify the script layer suites pass**

```bash
PATH="$PWD/test/helpers/no-real-claude:$PATH" WORCA_HOME=.worca-cc-tmp \
  node --disable-warning=ExperimentalWarning --test \
  test/script-builtins.test.mjs test/script-registry.test.mjs test/script-store.test.mjs \
  test/api-scripts.test.mjs test/graph-script-meta.test.mjs test/deck-bundle-script.test.mjs
```

Expected: PASS. A `normalizeScriptMeta` error here means the sidecar is wrong — read the message, it names the rule.

- [ ] **Step 8: Commit**

```bash
git add scripts/deckBundle.meta.json scripts/deck-bundle.py test/deck-bundle-script.test.mjs \
        test/script-builtins.test.mjs test/api-scripts.test.mjs test/script-store.test.mjs
git commit -m "scripts: a built-in Python deckBundle card that inlines a deck into one file

The live-reference check strips HTML comments and inlined script bodies before
looking for a live tag. Without that a CORRECT bundle reports as broken: the
kit's own header comment carries a complete <script src=...></script> pair, and
the real docs/why-worca standalone matches a naive search exactly once."
```

---

### Task 4: Wire `n_bundle` into the workflow, refresh the seed

**Files:**
- Modify: `src/core/graph/presentation-workflow.mjs` (nodes, wires, `PRESENTATION_SHIPPED_FINGERPRINTS`)
- Modify: `src/core/db.mjs:61` (`SCHEMA_VERSION` 37 → 38)
- Modify: `test/helpers/graph-ports.mjs` (add the script layer)
- Modify: `test/graph-presentation-workflow.test.mjs`, `test/presentation-seed-refresh.test.mjs`

**Interfaces:**
- Consumes: script key `deckBundle` and its port ids `built` / `bundle` / `findings` / `pass` from Task 3.
- Produces: node id `n_bundle`, wires `w22`–`w25`, `n_or.config.arity = 4`, `SCHEMA_VERSION = 38`. Task 5 asserts `ordinals.n_bundle`.

**`realPortsFn()` cannot currently resolve a script node.** `test/helpers/graph-ports.mjs` builds `portsFnFor(realRegistryIndex())` with one argument, and `portsFnFor(agentsByKey, scriptsByKey = {})` takes a second. Until Step 1 lands, `validateGraph` on `n_bundle` returns `undefined` ports and every presentation-workflow test fails with an unknown-node error rather than the real problem.

- [ ] **Step 1: Give the test port source a script layer**

In `test/helpers/graph-ports.mjs`, add the import and two functions, and pass the scripts through:

```javascript
import { loadScriptRegistry } from '../../src/core/script-registry.mjs';
```

```javascript
/** The BUILT-IN script layer only: a developer's ~/.worca-cc/scripts must never
 *  change what the shipped graphs validate against. */
export function realScriptIndex() {
  return loadScriptRegistry({ userScriptsDir: null });
}

export function realPortsFn() {
  return portsFnFor(realRegistryIndex(), realScriptIndex());
}
```

Replace the existing one-argument `realPortsFn`. Every caller keeps its signature.

- [ ] **Step 2: Write the failing tests**

In `test/graph-presentation-workflow.test.mjs`, replace the loop test and add two:

```javascript
test('all four fix loops close on the or card and carry a cycle cap', () => {
  const { loopWireIds } = classifyLoops(GRAPH_PRESENTATION_WORKFLOW, realPortsFn());
  assert.deepEqual([...loopWireIds].sort(), ['w12', 'w14', 'w19', 'w25']);
  const cap = (id) => GRAPH_PRESENTATION_WORKFLOW.wires.find((w) => w.id === id).config.maxCycles;
  assert.equal(cap('w12'), 3);            // audit  -> builder
  assert.equal(cap('w14'), 3);            // review -> builder
  // An export or bundle finding re-runs builder + audit + review, so caps are lower.
  assert.equal(cap('w19'), 2);            // export -> builder
  assert.equal(cap('w25'), 2);            // bundle -> builder
});

test('the bundle step sits between the review and the export, and gates it', () => {
  const w = (id) => GRAPH_PRESENTATION_WORKFLOW.wires.find((x) => x.id === id);
  const node = (id) => GRAPH_PRESENTATION_WORKFLOW.nodes.find((n) => n.id === id);
  assert.equal(node('n_bundle').kind, 'script');
  assert.equal(node('n_bundle').key, 'deckBundle');
  // Gated on the clean review, so it runs ONCE — and it also takes `built` from
  // inside the fix loop, the shape graph-scheduler pins against re-firing.
  assert.deepEqual(w('w22').from, { node: 'n_review', port: 'pass' });
  assert.deepEqual(w('w22').to, { node: 'n_bundle', port: 'await' });
  assert.deepEqual(w('w23').from, { node: 'n_build', port: 'built' });
  // The export now waits on the bundle, not on the review: w16 is gone.
  assert.equal(GRAPH_PRESENTATION_WORKFLOW.wires.some((x) => x.id === 'w16'), false);
  assert.deepEqual(w('w24').from, { node: 'n_bundle', port: 'pass' });
  assert.deepEqual(w('w24').to, { node: 'n_export', port: 'await' });
});

test('the or card has a slot for every fix source', () => {
  const node = (id) => GRAPH_PRESENTATION_WORKFLOW.nodes.find((n) => n.id === id);
  const intoOr = GRAPH_PRESENTATION_WORKFLOW.wires.filter((w) => w.to.node === 'n_or');
  assert.equal(node('n_or').config.arity, intoOr.length,
    'an unwired or-input is an unwired required port (V9) at run start');
  assert.deepEqual(intoOr.map((w) => w.to.port).sort(), ['in1', 'in2', 'in3', 'in4']);
});
```

In `test/presentation-seed-refresh.test.mjs`, extend the stamped loop to include the version this release leaves behind:

```javascript
for (const stamped of [29, 30, 31, 35, 36, 37]) {
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
PATH="$PWD/test/helpers/no-real-claude:$PATH" WORCA_HOME=.worca-cc-tmp \
  node --disable-warning=ExperimentalWarning --test \
  test/graph-presentation-workflow.test.mjs test/presentation-seed-refresh.test.mjs
```

Expected: FAIL — `node('n_bundle')` is `undefined`; the loop ids are still three; the stamped-37 case keeps a stale graph because nothing re-enters the refresh.

- [ ] **Step 4: Add the node and rewire**

In `src/core/graph/presentation-workflow.mjs`, change `n_or`'s arity, shift the tail nodes right, and add `n_bundle`:

```javascript
    { id: 'n_bundle', kind: 'script', key: 'deckBundle', x: 2000, y: 200, config: {} },
    { id: 'n_export', kind: 'agent', key: 'deckExport', x: 2280, y: 200, config: {} },
    { id: 'n_or', kind: 'or', x: 1580, y: 430, config: { arity: 4 } },
    { id: 'n_end', kind: 'end', x: 2560, y: 200, config: {} },
```

Remove the `w16` wire and append:

```javascript
    // The bundle step runs ONCE, after the review is clean, and the export gates on
    // IT rather than on the review — so a deck whose companions could not be inlined
    // never reaches the deliverable check. It also takes `built` straight from the
    // builder: gated on `await`, so a fresh payload from inside the fix loop cannot
    // re-fire it (test/graph-scheduler.test.mjs pins exactly this shape).
    { id: 'w22', from: { node: 'n_review', port: 'pass' }, to: { node: 'n_bundle', port: 'await' } },
    { id: 'w23', from: { node: 'n_build', port: 'built' }, to: { node: 'n_bundle', port: 'built' } },
    { id: 'w24', from: { node: 'n_bundle', port: 'pass' }, to: { node: 'n_export', port: 'await' } },
    { id: 'w25', from: { node: 'n_bundle', port: 'findings' }, to: { node: 'n_or', port: 'in4' }, config: { maxCycles: 2 } },
```

- [ ] **Step 5: Append the outgoing fingerprint and bump the schema**

Append to `PRESENTATION_SHIPPED_FINGERPRINTS` (newest last), exactly this string:

```javascript
  // v2 — before the deckBundle card. The export step gated on n_review.pass (w16)
  // and the or card had arity 3.
  'n_audit,n_build,n_clarify,n_end,n_export,n_narr,n_or,n_review,n_system,n_task'
    + '|w1,w12,w14,w15,w16,w17,w18,w19,w2,w20,w21,w3,w4,w5,w6,w7,w8,w9',
```

Then `src/core/db.mjs:61`:

```javascript
export const SCHEMA_VERSION = 38;
```

**No `applySchemaV38` is needed.** `refreshPresentationSeed` is gated on `current < SCHEMA_VERSION`, so the bump alone re-enters it and rewires every pristine seed; the one-shot `applySchemaV36` seed must NOT move, or a user who deleted the workflow gets it back. Skip the fingerprint and existing rows read as user-edited and are left with a graph that no longer wires the sidecars — V9 at run start, remedy "re-wire by hand".

Verify the appended string is byte-exact:

```bash
node -e "
import('./src/core/graph/presentation-workflow.mjs').then((m) => {
  const fp = m.presentationGraphFingerprint(m.GRAPH_PRESENTATION_WORKFLOW);
  const list = m.PRESENTATION_SHIPPED_FINGERPRINTS;
  console.log('current:', fp);
  console.log('listed :', list.length, 'entries');
  console.log('current must NOT be listed:', !list.includes(fp));
});
"
```

Expected: the current fingerprint is **not** in the list (a listed current shape would rewrite the row on every open — `test/graph-presentation-workflow.test.mjs` asserts this).

- [ ] **Step 6: Run the tests to verify they pass**

```bash
PATH="$PWD/test/helpers/no-real-claude:$PATH" WORCA_HOME=.worca-cc-tmp \
  node --disable-warning=ExperimentalWarning --test \
  test/graph-presentation-workflow.test.mjs test/presentation-seed-refresh.test.mjs \
  test/db-migrate-v36.test.mjs test/db-migrate-v37.test.mjs test/graph-registry-ports.test.mjs \
  test/graph-scheduler.test.mjs test/mock-graph.test.mjs
```

Expected: PASS. A V9 "unwired required input" on `n_bundle` means the sidecar's port ids and the wires disagree — compare against Task 3's Interfaces block.

- [ ] **Step 7: Commit**

```bash
git add src/core/graph/presentation-workflow.mjs src/core/db.mjs test/helpers/graph-ports.mjs \
        test/graph-presentation-workflow.test.mjs test/presentation-seed-refresh.test.mjs
git commit -m "presentation: the deckBundle card gates the export step (schema V38)

The export now waits on the bundle rather than on the review, so a deck whose
companions could not be inlined never reaches the deliverable check. Outgoing
fingerprint appended and SCHEMA_VERSION bumped so existing pristine seeds are
rewired instead of failing V9 at run start."
```

---

### Task 5: Export-agent fallback, the mock, and the golden run

**Files:**
- Modify: `agents/worca-cc-deck-export.md:20-32` (section 1)
- Modify: `src/core/claude-runner.mjs:1619-1642` (`mockDeckExport`)
- Test: `test/presentation-golden-run.test.mjs`, `test/mock-deck-roles.test.mjs`

**Interfaces:**
- Consumes: `n_bundle` from Task 4; `deck/deck.standalone.html` written by Task 3's card.
- Produces: nothing downstream.

Two corrections ship here. The export agent must stop *building* the bundle and start *verifying* it, falling back only when it is absent — and its documented `grep` assertion is **wrong**: the live-tag search it says "must be 0" returns **1** on a correct bundle, because `deck-stage.js:57` carries a complete `<script src="deck-stage.js"></script>` pair in a comment. Measured against the real `docs/why-worca/why-worca.standalone.html`, which matches exactly once. As written, the step would block every successful export; it has never been caught because the golden run exercises the *mock*, which does not run the grep.

- [ ] **Step 1: Write the failing test**

In `test/presentation-golden-run.test.mjs`, add to the main test after the existing standalone assertions:

```javascript
  // The bundle card owns the single file now, and the export step gates on it.
  // Under the mock the card writes only its report, so the standalone comes from
  // the export agent's FALLBACK — the same branch a host with no interpreter
  // takes, which is exactly what is worth pinning here. The card's own program is
  // covered for real by test/deck-bundle-script.test.mjs.
  await access(join(dir, 'deck-bundle-cycle1.md'));
  assert.equal(ordinals.n_bundle, 1, 'the bundle step runs once, after a clean review');
  const bundleKinds = kinds.filter((k) => k.startsWith('deck-bundle:'));
  assert.deepEqual(bundleKinds, ['deck-bundle:deck-bundle-cycle1.md'], kinds.join('\n'));
```

Move the `ordinals` destructuring above this block if it is currently declared later in the test, so `ordinals.n_bundle` is in scope.

- [ ] **Step 2: Run the test to verify it fails**

```bash
PATH="$PWD/test/helpers/no-real-claude:$PATH" WORCA_HOME=.worca-cc-tmp \
  node --disable-warning=ExperimentalWarning --test test/presentation-golden-run.test.mjs
```

Expected: FAIL — no `deck-bundle-cycle1.md`, `ordinals.n_bundle` is `undefined`.

- [ ] **Step 3: Make the export mock fall back instead of always writing**

`src/core/claude-runner.mjs`, in `mockDeckExport`, replace the unconditional standalone write:

```javascript
  const src = await readFile(join(deckDir, 'deck.html'), 'utf8').catch(() => '<!DOCTYPE html>\n');
  // A real standalone inlines every companion; the mock mirrors the property the
  // golden run asserts, rather than the bundler's actual output.
  await writeFile(join(deckDir, 'deck.standalone.html'),
    src.replace(/<script src="([^"]+)"><\/script>/g, (_m2, f) => `<script>/* inlined ${f} */</script>`), 'utf8');
```

with:

```javascript
  const src = await readFile(join(deckDir, 'deck.html'), 'utf8').catch(() => '<!DOCTYPE html>\n');
  // FALLBACK ONLY, mirroring the real agent: the deckBundle card owns the single
  // file, and this step builds one itself only when the card left none — a host
  // with no python interpreter, or a mock run, where the card writes just its
  // report. A real standalone inlines every companion; the mock mirrors the
  // property the golden run asserts, not the bundler's actual output.
  const standalone = join(deckDir, 'deck.standalone.html');
  if (!existsSync(standalone)) {
    await writeFile(standalone,
      src.replace(/<script src="([^"]+)"><\/script>/g, (_m2, f) => `<script>/* inlined ${f} */</script>`), 'utf8');
  }
```

`existsSync` is **not** currently imported there — line 52 reads
`import { constants as FS, mkdtempSync, writeFileSync, rmSync } from 'node:fs';`.
Add it:

```javascript
import { constants as FS, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
PATH="$PWD/test/helpers/no-real-claude:$PATH" WORCA_HOME=.worca-cc-tmp \
  node --disable-warning=ExperimentalWarning --test \
  test/presentation-golden-run.test.mjs test/mock-deck-roles.test.mjs
```

Expected: PASS. If `nodeOf('deck/deck.standalone.html')` now fails, the file is attributed to whichever node wrote it — under the mock that is still `n_export`; leave the existing assertion as `n_export` and add a comment saying why.

- [ ] **Step 5: Rewrite section 1 of the export agent**

Replace `agents/worca-cc-deck-export.md` section `## 1. The standalone HTML` entirely with:

```markdown
## 1. The standalone HTML — verify, and build only if it is missing

The `deckBundle` card upstream of you writes `deck/deck.standalone.html`. Your job
is to confirm it exists and is genuinely self-contained. **Build one yourself only
when it is absent** — a host with no Python interpreter produces none, and that is
a supported configuration, not a failure:

```
node <pipelineDir>/deck-kit/build-standalone.mjs <pipelineDir>/deck/deck.html --out <pipelineDir>/deck/deck.standalone.html
```

Pass the deck explicitly — `deck/` holds two stage-mounting files and the bundler
refuses an ambiguous folder. Say in your report which path you took.

Then verify the file reaches for nothing beside it. **Strip HTML comments and the
bodies of inlined scripts FIRST**, then look for a live tag:

```bash
python3 - "$PWD/deck/deck.standalone.html" <<'PY'
import re, sys
doc = open(sys.argv[1], encoding='utf-8', errors='replace').read()
bare = re.sub(r'(?is)<script(?![^>]*\ssrc=)[^>]*>.*?</script\s*>', '',
              re.sub(r'(?s)<!--.*?-->', '', doc))
s = re.findall(r'(?i)<script[^>]*\ssrc=("|\')[^"\']+\1[^>]*>\s*</script\s*>', bare)
l = re.findall(r'(?i)<link[^>]*rel=("|\')?stylesheet', bare)
print('live scripts:', len(s), 'live stylesheets:', len(l))
sys.exit(1 if (s or l) else 0)
PY
```

Both counts must be 0. **A bare search of the whole document reports a CORRECT
bundle as broken**, and so does a whole-live-tag search that skips the stripping:
the inlined kit source carries `<script src="deck-stage.js"></script>` in a header
comment (`deck-stage.js:57`), and the bundler comments the audio tag out — the
real `docs/why-worca/why-worca.standalone.html` matches such a search exactly
once. Strip the comments and the inlined bodies and what is left is live markup.

If no interpreter is available for the check, fall back to node:

```bash
node -e 'const fs=require("fs");const d=fs.readFileSync(process.argv[1],"utf8");const b=d.replace(/<!--[\s\S]*?-->/g,"").replace(/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?<\/script\s*>/gi,"");const s=b.match(/<script[^>]*\ssrc=("|\x27)[^"\x27]+\1[^>]*>\s*<\/script\s*>/gi)||[];const l=b.match(/<link[^>]*rel=("|\x27)?stylesheet/gi)||[];console.log("live scripts:",s.length,"live stylesheets:",l.length);process.exit(s.length||l.length?1:0)' deck/deck.standalone.html
```

A missing `deck/deck.standalone.html` that you could not build either is
**critical**: nothing openable was produced. A file that still reaches for a
sibling is **major**, and it loops back to the builder.
```

- [ ] **Step 6: Verify the agent prompt's claims are true**

The prose now asserts a measured fact. Prove it rather than trusting it:

```bash
python3 - docs/why-worca/why-worca.standalone.html <<'PY'
import re, sys
doc = open(sys.argv[1], encoding='utf-8', errors='replace').read()
naive = re.findall(r'(?i)<script[^>]*\ssrc=("|\')[^"\']+\.js\1[^>]*>\s*</script\s*>', doc)
bare = re.sub(r'(?is)<script(?![^>]*\ssrc=)[^>]*>.*?</script\s*>', '',
              re.sub(r'(?s)<!--.*?-->', '', doc))
strict = re.findall(r'(?i)<script[^>]*\ssrc=("|\')[^"\']+\1[^>]*>\s*</script\s*>', bare)
print('naive on a CORRECT bundle:', len(naive), '(the agent doc claimed 0)')
print('after stripping          :', len(strict), '(must be 0)')
assert len(naive) > 0 and len(strict) == 0
PY
```

Expected: `naive: 1`, `after stripping: 0`.

- [ ] **Step 7: Run the whole suite**

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)|^✖ "
```

Expected: `fail 0`. If `test/seed-traces.test.mjs` drifts, the presentation graph is not in its golden set — check the failure names a `wf_presentation` trace before regenerating anything, and regenerate only with `UPDATE_SEED_TRACES=1` after reviewing the diff.

- [ ] **Step 8: Commit**

```bash
git add agents/worca-cc-deck-export.md src/core/claude-runner.mjs test/presentation-golden-run.test.mjs
git commit -m "deck-export: verify the bundle, build one only when it is missing

Also fixes the step's standalone check, which could never pass: the live-tag grep
it documented as \"must be 0\" returns 1 on a correct bundle, because the inlined
kit source carries a complete <script src=...></script> pair in a comment. The
check now strips HTML comments and inlined script bodies first."
```

---

## Self-review

**Spec coverage.** Section 1 → Task 1 (floors, pivot, all six prose sites, VERSION). Section 2 → Task 2 (vocabulary, fill-mode, noscale + print final state, reduced motion, CONTRACT, both agents, `deck:sync`, four tests). Section 3 → Task 3 (sidecar, program, live-tag check, three exact-set assertions). Section 4 → Task 4 (node, `w22`–`w25`, `w16` removed, arity 4, fingerprint, V38, the `realPortsFn` script layer the spec did not anticipate). Section 5 → Task 5 (fallback, mock, golden run) plus the spec's artifact-glob note, which needs no work — `deck-asset` is already non-browsable.

**Two corrections to the spec, made here rather than carried forward:**

1. The spec said the Python card should "assert zero live `<script src>` tags". Measured: that check returns **1** on a correct bundle and 1 on the real `docs/why-worca` standalone, because HTML comments and inlined kit source both contain complete tag pairs. Every task that touches the check strips comments and inlined bodies first. The same bug is live in `agents/worca-cc-deck-export.md` today and is fixed in Task 5.
2. The spec's sidecar had no `findings` port while Section 4 claimed findings "loop back through `n_or`". Task 3 declares `findings` sharing `bundle`'s filename (the shipped `shell` card's pattern, and required by `runMock`), and Task 4 widens `n_or` to arity 4 and wires `w25`.

**Placeholder scan.** No TBD/TODO. Every code step carries the real content; every command is runnable as written.

**Type consistency.** Port ids `built` / `bundle` / `findings` / `pass` are identical in Task 3's sidecar, Task 4's wires and Task 5's assertions. `deck-bundle-cycle{cycle}.md` is the one filename template for both md ports. `realScriptIndex()` / `realPortsFn()` are defined in Task 4 Step 1 and used in Task 4 Step 2. `_syncDocumentSheet` is renamed once, in Task 2, with a grep step for its call sites.
