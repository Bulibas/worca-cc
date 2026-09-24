# Presentation decks: smaller type, kit-owned motion, one-file deliverable

Date: 2026-09-24
Status: approved design, not yet implemented
Branch: `worca/default-20260917-105925` (rebased onto `dev` at `d2821e95`)

Lives in `plans/` beside the other `*-design.md` documents this repo's code
comments cite (`scripts-workbench-design.md`, `ask-worca-design.md`); `.gitignore`
excludes `docs/superpowers/`.

## The ask

Three changes to the presentation pipeline:

1. Presentation text **smaller** — physically smaller type, so more room is left
   for graphics.
2. **More graphics and animation** on the slides.
3. **Self-contained results, not a bunch of files** — and the self-containment
   done by a Python script, using the script-card functionality `dev` shipped in
   #463.

## Decisions taken (and what they rule out)

| Decision | Chosen | Rejected |
|---|---|---|
| "smaller text" | lower the audit's type floors | tightening the word cap instead |
| word cap | stays 30 | 12–15 |
| animation | kit owns a declarative vocabulary | builder authors its own `@keyframes` |
| "more graphics" | prose guidance in the agents only | a countable blocking audit gate |
| bundler | shipped Python script card, wired into the workflow | node bundler stays wired; whole export step in Python |
| Python-less host | `build-standalone.mjs` stays as a fallback | hard dependency; preflight refusal |

"More graphics" is deliberately **prose only**. No `figure` check is added to
`deck-audit.js`, and the reviewer keeps judging figures as taste.

## Section 1 — Type floors

Only two type numbers are measured anywhere. `slide title ≥ 72px` and
`icon beside text ≥ 60px` appear in `CONTRACT.md` and three agent prompts but
are **never checked** by `deck-audit.js`; they are guidance, and they stay
guidance.

### The measured changes — `assets/deck-kit/deck-audit.js`

| line | check | now | becomes |
|---|---|---|---|
| 297 | `small` | `if (px < 27)` | `if (px < 20)` |
| 302 | `body` | `if (px < 48 && isBodyCopy(…))` | `if (px < 36 && isBodyCopy(…))` |
| 327 | contrast pivot | `const floor = px >= 36 ? 3 : 4.5` | `const floor = px >= 48 ? 3 : 4.5` |

Line 327 is the one that is not obvious, and it must move or this change does
something the request did not ask for. The pivot encodes "large text may have
lower contrast" (WCAG's large-text allowance). With the body floor lowered to
36px, body copy set at exactly the floor would land on `px >= 36` and silently
inherit the **3:1** floor instead of 4.5:1 — smaller *and* lower-contrast text,
from one edit, with no finding raised. Raising the pivot to 48 keeps "large"
meaning genuinely large: 36px body copy keeps the real 4.5:1 requirement, and
only type at the old body floor and above gets the relaxed one.

Also update the two comments that restate the floors: `deck-audit.js:10-11`
(`small`/`body` header) and `:42-45` (the canvas note).

### The stated minimums

New wording, applied identically everywhere it appears:

> body text ≥ 36px, slide title ≥ 56px, icon beside text ≥ 44px.
> text contrast ≥ 4.5:1 (≥ 3:1 for text ≥ 48px).
> no text under 20px.
> ≤ 30 words on a live slide.

Sites:

- `assets/deck-kit/CONTRACT.md:91-93` — the Design-minimums list.
- `assets/deck-kit/CONTRACT.md:126-127` — the caption-band note restates the
  `27px` and `48px` floors; becomes `20px` / `36px`.
- `agents/worca-cc-deck-builder.md:18`.
- `agents/worca-cc-deck-system.md:15` — also says "the skill's minimums scale by
  1.5", which stops being true. Replace with the numbers and a sentence saying
  they are deliberately below the six-foot-test defaults to leave room for
  figures.
- `agents/worca-cc-deck-audit.md` — the `small`/`body` severity rows.

The word cap is untouched: `deck-audit.js:366` (`liveWords`) and the `> 30`
mapping in the audit agent stay exactly as they are.

## Section 2 — Kit-owned animation vocabulary

### Where it goes, and why there

`deck-stage.js` `_syncPrintPageRule()` (line ~1137) writes a single
**document-level** `<style id="deck-stage-print-page">`. That is the right home
and the only workable one: the `<section>` slides are **light-DOM** content
slotted into the shadow stage, so shadow-DOM rules do not reach them — which is
exactly why `[data-deck-caption]` already lives in this tag rather than in the
shadow sheet. The animation rules join it there.

Rename the method to `_syncDocumentSheet()` (it has not been only `@page` for a
while) and keep the element id stable.

### The vocabulary

Author side is one attribute, `data-deck-anim`, on any element:

| value | effect |
|---|---|
| `rise` | fade + translateY(24px) → 0 |
| `draw` | `stroke-dashoffset` 1 → 0 (SVG paths; pathLength="1") |
| `wipe` | `clip-path: inset(0 100% 0 0)` → `inset(0)` |
| `pop` | scale(.92) + fade in |
| `count` | fade in only — a number's own digit tween stays the author's job |

Kit-owned rules, in order:

```css
@keyframes deck-rise { from { opacity:0; transform:translateY(24px) } to { opacity:1; transform:none } }
/* …draw, wipe, pop, count… */

[data-deck-anim] { animation-duration:.55s; animation-timing-function:cubic-bezier(.2,.8,.2,1);
                   animation-fill-mode:both; }
[data-deck-anim="rise"] { animation-name:deck-rise }
/* …one per value… */

/* Composes with the existing [data-step] reveals: a tagged element that is also
   a step animates when the step reveals it, not at mount. */
[data-step]:not(.step-visible)[data-deck-anim] { animation-play-state:paused }

@media (prefers-reduced-motion: reduce) { [data-deck-anim] { animation:none } }

/* FINAL STATE, unconditionally, in the two places a still frame is taken. */
deck-stage[noscale] [data-deck-anim],
deck-stage[noscale] [data-deck-anim]::before,
deck-stage[noscale] [data-deck-anim]::after {
  animation:none !important; opacity:1 !important; transform:none !important;
  clip-path:none !important; stroke-dashoffset:0 !important;
}
@media print { [data-deck-anim] { /* the same five declarations */ } }
```

### Why the last two rules are the point of the whole section

The audit screenshots `proof.html` and the export prints the PDF. An authored
animation that starts at `opacity:0` and lacks `animation-fill-mode` — or that
is simply captured mid-flight — produces **blank slides with the correct page
count**. `CONTRACT.md` already records that a wrong page count is "silent and
total, and no screenshot reveals it"; blank pages at the right count are worse,
because the one PDF assertion the contract defines passes. `proof.html` carries
`noscale` and the print sheet is the kit's, so both still frames can be forced
to final state in one place the builder cannot forget. That is the entire reason
this is a kit change rather than a prompt change.

### Kit bookkeeping

- `assets/deck-kit/VERSION`: `1.1.0` → `1.2.0`. `deck.html`'s
  `<meta name="generator" content="OpenDeck <VERSION>">` reads this file, and
  `test/deck-kit-sync.test.mjs` asserts `CONTRACT.md`'s `Kit version: **x.y.z**`
  line matches it — so the contract's version line moves too.
- `CONTRACT.md` gains an **Animation** section next to **Reveals**, stating the
  five values, that the kit owns the keyframes, and that a deck must never write
  its own `animation` rule for a `[data-deck-anim]` element (same prohibition
  shape as the caption band's).
- `agents/worca-cc-deck-builder.md` gains the vocabulary and the "one attribute,
  never your own keyframes" rule; `agents/worca-cc-deck-system.md` assigns
  motion per composition so it is a system decision, not a per-slide whim.
- `npm run deck:sync` (now `node tools/deck-sync.mjs`) re-copies `deck-stage.js`
  into `docs/why-worca/`; `test/deck-kit-sync.test.mjs` asserts byte-identity
  and fails otherwise.

### New tests

In `test/deck-kit-sync.test.mjs`, mirroring the existing caption-band and
font-reveal regression tests:

- the injected sheet declares `animation-fill-mode: both` for `[data-deck-anim]`;
- the sheet forces final state under `deck-stage[noscale]` **and** under
  `@media print` (both, explicitly — this is the blank-slide guard);
- `prefers-reduced-motion: reduce` disables the animations.

A DOM test in `test/deck-audit-dom.test.mjs` asserts a `[data-deck-anim]`
element inside a `noscale` stage measures as visible, so the audit cannot report
an animated figure as `contrast`-transparent.

## Section 3 — The Python bundler card

### Files

`scripts/deckBundle.meta.json`:

```json
{
  "key": "deckBundle",
  "metaVersion": 2,
  "displayName": "Deck bundle",
  "description": "Inlines a built deck into one self-contained HTML file.",
  "domain": "presentation",
  "runtime": "python",
  "file": "deck-bundle.py",
  "inputs":  [{ "id": "built", "type": "md" }],
  "outputs": [{ "id": "bundle", "type": "md", "when": "always",
                "filename": "deck-bundle-cycle{cycle}.md",
                "artifactKind": "deck-bundle",
                "extraFiles": [{ "kind": "deck", "glob": "deck/deck*.html" }] },
              { "id": "findings", "type": "md", "when": "blocking",
                "filename": "deck-bundle-findings-cycle{cycle}.md",
                "artifactKind": "deck-bundle" },
              { "id": "pass", "type": "void", "when": "clean" }],
  "verdict": { "filename": "deck-bundle-cycle{cycle}.json" }
}
```

Two notes for the implementer:

- **Do not declare an `await` input.** `AWAIT_PORT` is synthetic: the engine adds
  it when a wire targets it, and `buildEnvelope` skips it explicitly
  (`p.id === AWAIT_ID || p.synthetic`). Declaring it by hand would be a second,
  real port.
- Keys are unique across scripts **and** agents (`script-registry.mjs`), so
  `deckBundle` must not collide with an agent key — it does not.
- `extraFiles` on a script's output port is indexed because the rebase moved the
  `_indexExtraFiles` sweep in `orchestrator._afterExecution` to run *before* the
  `nc.kind === 'script'` early return. That ordering is load-bearing here.

`scripts/deck-bundle.py` — `def main(api)`, stdlib only, parses and runs on
Python 3.8 (no `match`, no `X | Y`, no `str.removeprefix`), per
`src/core/graph/worca_script.py`'s own constraints:

1. `pdir = api.ctx.pipelineDir`; deck at `<pdir>/deck/deck.html`.
2. Inline every local `<script src="…">`, same-origin `<link rel=stylesheet>`
   and the `url()` assets inside them, `<img src>`, and `@font-face` files, as
   `data:` URIs.
3. Write `<pdir>/deck/deck.standalone.html`.
4. Write the report to `api.outputs.bundle.path`; return
   `{'outputs': …, 'verdict': …, 'summary': …}`.

`stdout` is protocol-reserved — the harness reserves fd 1 and points it at
stderr — so the script uses `api.log(...)`/`print` freely for the run log and
never writes the frame itself.

### Self-verification, with the live-tag regex

The script must assert its own output is genuinely standalone using a **whole
live tag** match, opening tag *and* closing tag:

```python
LIVE_SCRIPT = re.compile(
    r'<script[^>]*\ssrc=("|\')[^"\']+\.js\1[^>]*>\s*</script\s*>', re.I)
LIVE_SHEET  = re.compile(r'<link[^>]*rel=("|\')?stylesheet', re.I)
```

A bare `<script src=` substring search **matches on every correct bundle** and
would fail every successful export: the kit's own source is inlined verbatim and
its comments and string literals contain that text (`deck-stage.js`'s usage
example alone has one). `agents/worca-cc-deck-export.md` already documents this
trap for the shell equivalent; the Python check repeats the rule, not the bug.

Non-zero matches → a blocking verdict on the `findings` port, which loops back
through `n_or` to the builder. A remaining live `<script src>` usually means the
deck reached for a CDN, which *is* a builder fix — so the loop is the right
destination rather than a dead end.

## Section 4 — Workflow rewiring and migration

Add one node and four wires to `GRAPH_PRESENTATION_WORKFLOW`, and widen the `or`:

```
n_bundle  { kind: 'script', key: 'deckBundle', x: 2000, y: 200 }   // n_export/n_end shift right
n_or      config.arity: 3 -> 4                                     // in4 is the bundle's

w22  n_review.pass      -> n_bundle.await   // runs once, after the review is clean
w23  n_build.built      -> n_bundle.built   // the manifest names the slide count
w24  n_bundle.pass      -> n_export.await   // export gates on the bundle, not the review
w25  n_bundle.findings  -> n_or.in4         // { maxCycles: 2 }, like the export's w19
```

`w16` (`n_review.pass -> n_export.await`) is **replaced** by `w24`, so the export
step now waits on the bundle. `w17` (`n_build.built -> n_export.built`) and `w18`
(`n_task.task -> n_export.task`) are unchanged.

`n_or`'s arity lives in `config`, and the fingerprint deliberately ignores
`config` — so the arity change does **not** alter the fingerprint and would not,
by itself, reach an existing install. It rides along with the node/wire change,
which does. Worth knowing because the reverse case (a config-only release) is
documented in `presentation-workflow.mjs` as a no-op for existing rows.

`n_bundle` is gated on `await` and also takes `built` from inside the fix loop —
the exact shape `test/graph-scheduler.test.mjs`'s "a node gated on await does not
re-fire on a fresh payload from inside the loop" pins. That test exists because
`n_export` had this shape and re-fired; the new node inherits the fixed
behaviour, and the test already covers it.

### Migration — the documented procedure

`presentation-workflow.mjs` states the whole rule: *"Whenever the constant's
shape changes, append the OUTGOING fingerprint here and bump SCHEMA_VERSION."*

1. Append the current fingerprint to `PRESENTATION_SHIPPED_FINGERPRINTS`:
   ```
   n_audit,n_build,n_clarify,n_end,n_export,n_narr,n_or,n_review,n_system,n_task
   |w1,w12,w14,w15,w16,w17,w18,w19,w2,w20,w21,w3,w4,w5,w6,w7,w8,w9
   ```
2. `SCHEMA_VERSION` 37 → **38** in `src/core/db.mjs`. No new
   `applySchemaV38` is needed: `refreshPresentationSeed` is gated on
   `current < SCHEMA_VERSION`, so the bump alone re-enters it and rewires every
   pristine seed. Skip the fingerprint and existing rows read as user-edited and
   are left alone; skip the bump and no existing install re-enters — either way
   those installs keep a graph that no longer wires the sidecars and fail V9 at
   run start.
3. `test/presentation-seed-refresh.test.mjs`: extend the stamped-version loop
   (now `[29, 30, 31, 35, 36]`) with `37`, and move the
   "already at the seed's own version" stamp if the seed rung changes (it does
   not — the seed stays V36).

## Section 5 — The self-contained result

### The fallback (the approved shape)

```
n_review.pass -> n_bundle (python) -> deck/deck.standalone.html
                      |
                      | no interpreter, or the card errors
                      v
n_export: standalone absent? -> node deck-kit/build-standalone.mjs
                                then assert the deliverable exists
```

`agents/worca-cc-deck-export.md` changes from "run the bundler" to "verify the
bundle; build it yourself only if it is missing". `build-standalone.mjs` stays in
the kit, and `test/deck-kit-sync.test.mjs`'s "the kit carries the headless
bundler agents actually run" assertion stays valid. The PDF stays with headless
Chrome in the export agent, unchanged.

A Python-less host therefore degrades to exactly today's behaviour instead of
failing a run after the narrative, system and build steps have already spent
tokens.

### Why the run stops being "a bunch of files"

Mostly already true on this branch and worth stating so it is not re-solved:
`deck-asset` is in `NON_BROWSABLE_KINDS` (`src/shared/artifact-kinds.mjs`), so
the kit scripts, webfonts and `proof.html` stay **indexed** — the raw-bytes route
resolves `rel` only among indexed rows, so unindexing them would 404
`deck.html`'s own `<script src>` and `@font-face` — while never appearing as a
row anyone is asked to open. Screenshots collapse behind one summary row at
`BULK_ARTIFACT_THRESHOLD`.

What this work adds is that the **thing you open is one file**: the Artifacts tab
shows the manifest, `deck.standalone.html` and `deck.pdf`, and the standalone
HTML now genuinely needs nothing beside it.

## Testing

| area | test |
|---|---|
| floors | `test/deck-audit-dom.test.mjs` — 20px passes `small`, 19px fails; 36px body passes, 35px fails; 36px text keeps the 4.5:1 floor and 48px gets 3:1 |
| contrast pivot | a 36px node at 3.5:1 must be reported (the regression the pivot move prevents) |
| animation | `test/deck-kit-sync.test.mjs` — fill-mode, `[noscale]` final state, print final state, reduced-motion |
| kit sync | existing byte-identity test, after `npm run deck:sync` |
| script card | `test/graph-script-meta.mjs` shape; a bench-style run of `deck-bundle.py` over a fixture deck asserting zero live tags remain |
| live-tag regex | a fixture whose inlined source *contains* the text `<script src=` must still verify clean — the trap the substring search falls into |
| workflow | `test/graph-presentation-workflow.test.mjs` — the new fingerprint, `n_bundle` validates against the real sidecars, `assertRunnableWorkflow` passes |
| migration | `test/presentation-seed-refresh.test.mjs` — a DB stamped 37 holding the prior shape is rewired |
| golden run | `test/presentation-golden-run.test.mjs` — the trace gains `n_bundle` |
| fallback | export agent finds no standalone and builds one; asserts the deliverable exists either way |

## Risks and non-goals

- **Lower floors weaken the legibility gate the audit exists to enforce.** This
  is the explicit request, taken with eyes open; the contrast pivot move is the
  part that keeps it from quietly becoming two regressions instead of one.
- **Motion cannot be verified by the audit.** Stills are all it sees. The kit's
  final-state rules are what make that safe; the reviewer still cannot judge
  whether an animation helps.
- **Not in scope:** any `figure`/graphics audit gate, changes to the word cap,
  and replacing the PDF path.
