# OpenDeck kit — builder contract

Kit version: **1.1.0**

The deck builder authors exactly two HTML files and copies the kit scripts flat
beside them. It never edits a kit script.

## Files to write (all under the pipeline directory)

- `deck/deck.html` — the deck.
- `deck/proof.html` — the proof copy the audit measures.
- `deck-manifest.md` — one row per slide.
- any images/fonts the deck needs, in `deck/`.

Copy `deck-stage.js`, `deck-enhance.js`, `deck-export.js`, `deck-audit.js` from
the staged `deck-kit/` in the pipeline directory **flat** into `deck/`. The
engine stages the kit there before the first node runs (`requiresAssets`), so
never hunt the filesystem for it, and never edit a kit file.

## Deliverables — the single files a human opens

**Every path below is absolute.** An agent's working directory is the
project worktree, never the run folder, so a cwd-relative `deck/deck.html`
either ENOENTs or — worse — resolves against a `deck/` that happens to exist
in the user's own repository.

**The export step owns these, not the builder.** It runs once, after the audit
and the review are both clean; the builder has no signal for "this is the final
cycle", so building them there rebuilt them on every fix pass.

`deck.html` needs its companion scripts beside it, so it is **not** something to
send anyone. The export step produces both standalone forms:

- `deck/deck.standalone.html` — one self-contained file, nav and `[data-step]`
  builds intact, opens offline in any browser:

  ```
  node <pipelineDir>/deck-kit/build-standalone.mjs \
    <pipelineDir>/deck/deck.html --out <pipelineDir>/deck/deck.standalone.html
  ```

  Pass the deck explicitly: `deck/` holds two stage-mounting files and the
  bundler's no-argument mode refuses an ambiguous folder.

- `deck/deck.pdf` — the universal document. `deck-stage.js` injects
  `@page { size: <width>px <height>px; margin: 0 }` plus `print-color-adjust:
  exact` from `connectedCallback`, so the page must finish mounting before the
  print — give the virtual-time budget room:

  ```
  "$CHROME" --headless=new --disable-gpu --no-pdf-header-footer \
    --virtual-time-budget=10000 \
    --print-to-pdf=<pipelineDir>/deck/deck.pdf "file://<pipelineDir>/deck/deck.html"
  ```

  Resolve `$CHROME` from the first that exists: `google-chrome`, `chromium`,
  `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  `/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`.

**Assert the PDF's page count equals the slide count** (minus `data-deck-skip`
slides, which the print sheet hides). A mismatch means `@page` did not apply and
every slide is cropped onto Letter — the failure is silent and total, and no
screenshot reveals it. A wrong count or a missing file is a blocking finding
that loops back to the builder — never a clean verdict.

## `deck.html`

- `<!DOCTYPE html>`, `<meta name="generator" content="OpenDeck <VERSION>">`, where `<VERSION>` is the
contents of `deck-kit/VERSION` in the pipeline directory — never a literal, or the
deck and the manifest's `Kit:` line disagree the moment the kit is bumped.
- `<deck-stage width="1920" height="1080">` with **one `<section data-label="…">`
  per slide** and nothing else inside the stage.
- `<script src="deck-stage.js">`, `<script src="deck-enhance.js">`,
  `<script src="deck-export.js">` after the stage.
- Styles in one `<style>` block. Fonts: system stacks or `@font-face` files
  copied into `deck/` — no CDNs (they fail silently under the artifact CSP).

  Worth knowing: the in-app viewer frames a deck with `sandbox="allow-scripts"`
  and no `allow-same-origin`, so its `@font-face` requests are CORS-mode from an
  opaque origin and the localhost-only guard refuses them. A PREVIEWED deck
  therefore renders in fallback type. That is cosmetic and deliberate — the PDF
  and the standalone HTML, which are what anyone is actually sent, embed their
  fonts. Prefer a system stack for anything that must look right in the preview.

## Design minimums (canvas 1920×1080 — fixed)

`deck-audit.js` measures against 1920×1080 and the floors below are that
canvas's numbers. A stage authored at any other size is reported as
`canvasMismatch` and audited as a blocking finding rather than mismeasured.

- body text ≥ 48px, slide title ≥ 72px, icon beside text ≥ 60px.
- text contrast ≥ 4.5:1 (≥ 3:1 for text ≥ 36px).
- no text under 27px.
- ≤ 30 words on a live slide.

## Reveals

`[data-step="1"]`, `[data-step="2"]`… — `deck-enhance.js` steps them with ←/→
and advances the slide only when none are left. **Read-alone decks use no
`data-step` at all** (everything visible).

## The caption band — `Mode: both` and read-alone decks

A projected slide has a 30-word budget; a document has to be complete. A deck
that must do both carries the completeness in a caption band:

```html
<section data-label="07 · Review">
  <h1>Review is where the loop breaks</h1>
  <p class="lead">Four of six stages are unowned.</p>

  <div data-deck-caption>
    Anthropic's playbook names six stages. worca owns plan and implement end to
    end; review, deploy, operate and learn have no engine behind them today.
  </div>
</section>
```

- **The kit owns its visibility.** `deck-stage.js` injects
  `[data-deck-caption]{display:none}` plus a print override into the same
  `<head>` sheet as `@page`. Never restate those rules, and never rely on your
  own — a forgotten rule is silent in both directions (captions on the
  projector, or no captions in the PDF).
- **The audit excludes it entirely** — from the word count and from every
  geometry and legibility check. The caption is print copy in a flowing
  document, not a fixed rectangle: the 1920×1080 box, the 27px floor and the
  48px body floor are live-surface rules.
- **It is not speaker notes.** Notes are for the presenter and never print;
  the caption is what a reader gets instead of the narration.
- **Live-only decks use no caption band.** The mode decides: `live` has none,
  `read-alone` and `both` have one on every slide that carries an argument.

## Speaker notes

`<script type="application/json" id="speaker-notes">["note for slide 1", …]</script>`
— one string per slide, in order. This is the kit's real mechanism
(`deck-stage.js` `_loadNotes`); `data-speaker-notes` attributes are not read.
The kit parses them, exposes the array as `deckStageEl.notes`, and sends the
current slide's note with every `slideIndexChanged` message, so a presenter view
can render it without re-parsing the document. The block may sit anywhere — it is
re-read on `slotchange`, not only at mount.

## Icons

One inline `<svg style="display:none">` sprite of `<symbol id="…">`, used with
`<svg><use href="#…"/></svg>`, colored with `currentColor`. No icon fonts, no
external icon URLs.

## Cutting a slide

A slide cut late gets `data-deck-skip` on its `<section>` (dimmed in the rail,
skipped in navigation, hidden at print). Never delete a section in a fix cycle.

## `proof.html`

The **same** `<section>` markup and `<style>`,
`<deck-stage width="1920" height="1080" noscale>`, every `[data-step]` element
also given `class="step-visible"`, **no** `deck-enhance.js`, and
`<script src="deck-audit.js">` last. This is what the audit measures — all
fragments visible at once is the worst case for overflow.

`deck-audit.js` measures **every slide in one load** and ignores the URL hash
(deck-stage.js stamps one in on mount, so honouring it audited slide 1 and
reported the rest clean). Its checks are `escapes`, `clipped`, `overlaps`,
`contrast`, `small`, `body` and a per-slide live-surface `words` count.
