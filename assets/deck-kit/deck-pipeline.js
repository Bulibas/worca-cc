/* deck-pipeline.js — worca presentation-pipeline extension for <deck-stage>.
 * Registers the caption band and the kit-owned slide-animation vocabulary through
 * DeckStage.addDocumentStyle(), so upstream deck-stage.js stays unmodified.
 * Load AFTER deck-stage.js. */
(function () {
  var Stage = customElements.get('deck-stage');
  if (!Stage || !Stage.addDocumentStyle) {
    // Old kit (< OpenDeck 1.3.0) or deck-stage.js not loaded first: say so loudly.
    if (typeof console !== 'undefined') console.error('[deck-pipeline] needs OpenDeck >= 1.3.0 deck-stage.js loaded before it');
    return;
  }
  window.__DECK_PIPELINE = { version: 1 };
  Stage.addDocumentStyle('worca-pipeline',
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
        // SCOPED TO THE ACTIVE SLIDE, and that scope is what makes the motion
        // real. A non-active slide is `visibility:hidden; opacity:0` — still
        // RENDERED, so its animations run. Unscoped, every rise/wipe/pop on
        // slides 2..N played out ~550ms after load while invisible and, with
        // `animation-fill-mode: both`, sat frozen on its final frame by the time
        // the presenter arrived: the whole vocabulary was dead on every slide but
        // the one shown at load, and completely dead on a read-alone deck (no
        // [data-step] anywhere). _applyIndex moves [data-deck-active] on every
        // navigation, which adds animation-name to the arriving slide and drops
        // it from the leaving one — so the motion re-triggers, forwards and back.
        // Both halves of each pair: the tag can sit on the SECTION itself, which
        // a descendant combinator alone would never match.
        '[data-deck-active][data-deck-anim="rise"], [data-deck-active] [data-deck-anim="rise"] { animation-name: deck-rise; } ' +
        '[data-deck-active][data-deck-anim="draw"], [data-deck-active] [data-deck-anim="draw"] { animation-name: deck-draw; } ' +
        '[data-deck-active][data-deck-anim="wipe"], [data-deck-active] [data-deck-anim="wipe"] { animation-name: deck-wipe; } ' +
        '[data-deck-active][data-deck-anim="pop"], [data-deck-active] [data-deck-anim="pop"] { animation-name: deck-pop; } ' +
        '[data-deck-active][data-deck-anim="count"], [data-deck-active] [data-deck-anim="count"] { animation-name: deck-count; } ' +
        // A tagged element that is ALSO a [data-step] waits for its reveal instead
        // of animating at mount: deck-enhance.js toggles .step-visible, and the
        // deck's own stylesheet owns whether an unrevealed step is hidden at all.
        '[data-step]:not(.step-visible)[data-deck-anim] { animation-play-state: paused; } ' +
        '@media (prefers-reduced-motion: reduce) { [data-deck-anim] { animation: none !important; } } ' +
        // FINAL STATE, unconditionally, in the two places a still frame is taken.
        // proof.html carries `noscale` and is what the audit measures and shoots.
        //
        // [data-step] IS PART OF THE FINAL STATE. Covering only [data-deck-anim]
        // left the reveals out: deck-enhance's initSlide() -> applyStep(slide, 0)
        // strips .step-visible from every step on every slide, and CONTRACT hands
        // the hiding of an unrevealed step to the deck's own stylesheet
        // (`deck-stage [data-step]{opacity:0}`), which nothing here overrode. A
        // deck with reveals printed one page per slide carrying step-0 content
        // only — BLANK SLIDES AT THE RIGHT PAGE COUNT, the exact failure the
        // comment above says these two blocks make unreachable, and the page-count
        // assertion is the only PDF gate so it passed. It was internally
        // inconsistent too: a [data-step][data-deck-anim] element was rescued by
        // the opacity rule while its plain [data-step] sibling beside it was not,
        // so the PDF showed an arbitrary subset of each build.
        //
        // visibility, not just opacity: a deck is equally free to hide an
        // unrevealed step with `visibility:hidden`, and a still frame must not
        // depend on which of the two the builder reached for.
        'deck-stage[noscale] [data-deck-anim], deck-stage[noscale] [data-step] { animation: none !important; animation-play-state: running !important; opacity: 1 !important; visibility: visible !important; transform: none !important; clip-path: none !important; stroke-dashoffset: 0 !important; } ' +
        '@media print { [data-deck-anim], [data-step] { animation: none !important; opacity: 1 !important; visibility: visible !important; transform: none !important; clip-path: none !important; stroke-dashoffset: 0 !important; } }');
})();
