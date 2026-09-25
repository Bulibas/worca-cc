/* deck-audit.js — mechanical slide audit for a <deck-stage> proof copy.
 * Load AFTER deck-stage.js in proof.html (noscale, every [data-step] revealed).
 * On DOMContentLoaded it forces each <section> visible in turn, measures, and
 * publishes:  window.__DECK_AUDIT  and  <script type="application/json"
 * id="deck-audit-report">. Facts only — no judgment:
 *   escapes   element box leaves the 1920×1080 slide box (1px tolerance)
 *   clipped   scrollWidth > clientWidth on an element that owns text
 *   overlaps  two non-nested text-owning boxes land on each other
 *   contrast  computed fg/bg ratio below 4.5:1 (< 48px text) or 3:1 (>= 48px)
 *   small     text below 20px
 *   body      p/li/blockquote text below 36px
 *   words     visible word count per slide, LIVE SURFACE ONLY
 *
 * Measurement waits for `document.fonts.ready` (capped) — at DOMContentLoaded
 * the text is still laid out in the fallback face, and every metric-dependent
 * check would be taken against glyphs the deck never renders.
 *
 * EVERY slide is measured on every load. The audit deliberately ignores
 * `location.hash`: deck-stage.js stamps `#<current>` into the URL from
 * _applyIndex on mount, and the contract loads this file after it, so a hash is
 * always present by the time this runs — honouring it silently audited slide 1
 * of N and reported the other N-1 as clean.
 *
 * A `[data-deck-caption]` subtree is the read-alone layer of a `Mode: both`
 * deck: prose that prints with the slide and is hidden on screen. It is not the
 * live surface, so it is excluded from every check and from the word count. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DeckAudit = api;
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    // .catch: runAndPublish is async, so anything run() throws became an UNHANDLED
    // REJECTION — invisible to the audit agent, which reads page errors. Rethrown
    // from a task so it surfaces as a page error the way it did when this was
    // synchronous, without making the listener itself reject.
    document.addEventListener('DOMContentLoaded', () => {
      api.runAndPublish(document, root).catch((err) => { setTimeout(() => { throw err; }, 0); });
    });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // The ONE canvas this kit audits. CONTRACT.md pins the builder to 1920×1080 and
  // the floors below (20px / 36px) are that canvas's numbers — the header used to
  // advertise a 1280 variant that was never implemented, so a 1280 proof measured
  // its escapes against a 1920-wide box (nothing could ever escape) while every
  // 20px label tripped `small` against the wrong floor. Audited loudly instead:
  // a stage that is not this size is reported, not silently mismeasured.
  const SLIDE = { w: 1920, h: 1080 };
  const TOL = 1;

  function parseColor(str) {
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/.exec(String(str || ''));
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  }
  function luminance({ r, g, b }) {
    const c = [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrastRatio(fg, bg) {
    const a = luminance(fg), b = luminance(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }
  /** Composite `fg` over `bg` by fg.a (bg treated as opaque). */
  function over(fg, bg) {
    const a = fg.a == null ? 1 : fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
  }
  /** A computed background-image's top-level LAYERS. Splitting on every comma is
   *  wrong twice over — `rgb(11, 11, 15)` and `url(a,b.png)` both carry commas
   *  that are not layer separators — so the split is paren-depth aware. */
  function splitTopLevel(str) {
    const s = String(str || '');
    const out = [];
    let depth = 0, start = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
    }
    out.push(s.slice(start));
    return out.map((l) => l.trim()).filter(Boolean);
  }
  const imageLayers = (cssImage) => splitTopLevel(cssImage);
  const GRADIENT = /^(?:repeating-)?(?:linear|radial|conic)-gradient\((.*)\)\s*$/i;
  // A gradient's argument list carries two kinds of colourless segment: the
  // leading geometry / interpolation head, and a bare position between two stops
  // (a colour HINT). Both are legitimately colourless; every OTHER segment has to
  // be a colour we can actually read, or the stop set is incomplete.
  //
  // Recognised by TOKEN, not by a prefix. An enumerated prefix list missed the
  // sized radial head — `radial-gradient(50% 50% at 50% 50%, …)` and
  // `radial-gradient(800px 400px at 20% 0%, …)`, which is what Figma's CSS export
  // writes and what every "glow" on a slide is — so the head fell through to
  // parseColor, failed, and took the whole stack to `null`. Silence on the only
  // blocking legibility gate: white-on-white certified clean, while the keyword
  // spelling of the same gradient was caught.
  const GEOMETRY_TOKEN = new RegExp('^(?:to|in|at|from|circle|ellipse|top|bottom|left|right|center'
    + '|closest-side|closest-corner|farthest-side|farthest-corner'
    + '|srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz|xyz-d50|xyz-d65'
    + '|oklab|oklch|lab|lch|hsl|hwb|longer|shorter|increasing|decreasing|hue'
    + '|[-+\\d.]+(?:deg|rad|grad|turn|%|px|em|rem|vw|vh|vmin|vmax|ch|ex|cm|mm|in|pt|pc)?)$', 'i');
  /** Is this whole segment geometry — a head, or a bare colour hint? A colour is
   *  never made only of geometry tokens, so this can never swallow one. */
  const isGeometry = (seg) => seg.split(/\s+/).filter(Boolean).every((t) => GEOMETRY_TOKEN.test(t));
  /** One entry PER LAYER — its stops — topmost layer first, or NULL when the
   *  declaration paints something this DOM cannot read. The distinction is the
   *  whole contract: `[]` means "paints nothing, keep walking", `null` means
   *  "unmeasurable, report nothing".
   *
   *  Per layer, not flattened. Pooling every layer's stops into one list meant
   *  layer n was never composited over layer n+1: each stop became an independent
   *  candidate over whatever sat below the WHOLE stack, so the bottom layer's raw
   *  colours vetoed the top layer covering them. The standard "dark scrim so the
   *  copy reads over a light ground" was reported 1.00:1 — a blocking failure on a
   *  slide that reads at ~14:1 — and an OPAQUE top layer could not hide the one
   *  underneath it.
   *
   *  Layer-aware, and it has to be. Scraping `rgba?\(…\)` out of the whole
   *  declaration read colours that are not grounds at all: an inline
   *  `url("data:image/svg+xml,…fill='rgb(250,250,250)'…")` — a mainstream deck
   *  idiom — handed back the fill colour of some shape inside the SVG and scored
   *  white copy on a near-black slide 1.04:1, a blocking false failure. It also
   *  made the unreadable-ground guard unreachable whenever a gradient sat ON a
   *  photo (`linear-gradient(…), url(hero.jpg)`): one readable layer was enough
   *  to stop the walk returning null, so adding a scrim flipped the gate from
   *  "skip, cannot measure" to "fail". ANY layer we cannot read poisons the whole
   *  stack, because it paints over everything below it.
   *
   *  Stops keep their alpha — a translucent stop is composited by the caller, not
   *  treated as solid. Measuring `rgba(0,0,0,.6)` as opaque black certified white
   *  copy on a white section CLEAN, which is the failure this gate exists for. */
  function imagePaint(cssImage) {
    const s = String(cssImage || '');
    if (!s || s === 'none') return [];
    const out = [];
    for (const layer of imageLayers(s)) {
      // `none` is a legal LAYER (`background-image: none, linear-gradient(…)`,
      // and what `var(--overlay, none)` resolves to). It paints nothing, which is
      // not the same as painting something unreadable — treating it as the latter
      // blinded the gate on a deck that was perfectly measurable.
      if (layer.toLowerCase() === 'none') continue;
      const g = GRADIENT.exec(layer);
      if (!g) return null;
      // EVERY stop, or none of them. Keeping only the tokens that happen to match
      // `rgba?(…)` silently dropped the ones that do not — `oklch()`, `lab()`,
      // `color(display-p3 …)`, `color-mix()`, a hex literal — and the caller then
      // took its worst-case minimum over an INCOMPLETE set. A dark-to-near-white
      // wash whose pale end was written in oklch reported CLEAN for white copy
      // that is invisible at that end, which is a false clean on the blocking
      // gate: strictly worse than the false failure this whole helper replaced.
      const stops = [];
      for (const seg of splitTopLevel(g[1])) {
        if (isGeometry(seg)) continue;                         // head, or a colour hint
        const c = parseColor(seg);
        if (!c) return null;                                   // a stop we cannot read
        stops.push(c);
      }
      if (!stops.length) return null;
      out.push(stops);
    }
    return out;
  }
  /** What is actually PAINTED behind `el`: every translucent ancestor ground
   *  composited over the next, down to the first opaque one — or to `fallback`.
   *  Returns the CANDIDATE grounds (a gradient paints more than one) or `null`
   *  when something paints a ground computed style cannot read.
   *
   *  Returning the first non-transparent ancestor raw measured a 45% scrim as if
   *  it were solid (`luminance` ignores alpha): white text over
   *  `rgba(0,0,0,.45)` on the white stage reported 21:1 when the painted ratio is
   *  about 3.4, under the floor. The audit is the blocking gate, so the
   *  illegible slide shipped. */
  function effectiveBackground(el, win, fallback, root) {
    // The paints between the text and the canvas, outermost LAST. Within one
    // element the background-IMAGE paints above the background-COLOR, so it is
    // pushed first — get that order wrong and a scrim is composited under the
    // thing it is scrimming.
    const paints = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const cs = win.getComputedStyle(node);
      // A background-IMAGE paints too. Reading only backgroundColor measured the
      // canonical dark ground — `section { background: linear-gradient(...) }` —
      // as fully transparent, fell through to the white STAGE_CANVAS, and scored
      // white copy 1.00:1: every heading and every line of body text on a slide
      // that renders perfectly became a blocking `contrast` finding, which burns
      // all three fix cycles on something the builder cannot resolve.
      const img = imagePaint(cs.backgroundImage);
      // An image whose paint CANNOT be read (a url() photo, a cross-fade) leaves
      // the ground unmeasurable. A ratio needs two colours; inventing one is what
      // produced the false failure above, so say "unknown" and let the caller
      // skip. This is the same portable signal the transparent-TEXT branch below
      // already trusts to mean "something other than `color` is painting here".
      if (img === null) return null;
      // ONE ENTRY PER LAYER, topmost first, so the composite below folds each
      // layer over the one beneath it. An opaque layer hides everything after it —
      // the rest of the stack AND this element's own background-color AND every
      // ancestor — so it ends the walk outright.
      let sealed = false;
      for (const layer of img) {
        paints.push(layer);
        if (layer.every((c) => c.a >= 1)) { sealed = true; break; }
      }
      if (sealed) break;
      // An UNREADABLE colour is not a transparent one. parseColor speaks
      // rgb()/rgba() only, and CSS Color 4 values keep their colour space when
      // computed (`oklch(0.15 0.02 260)` stays oklch in Chromium and in jsdom), so
      // a null parse was silently taken to mean "paints nothing": the walk fell
      // through to the white STAGE_CANVAS and every line on a perfectly-rendered
      // dark slide became a blocking contrast failure. Same false-block as the
      // gradient case this helper was written for, arriving via the other
      // property. `transparent` and the empty string are the only spellings that
      // genuinely paint nothing.
      const rawBg = String(cs.backgroundColor || '').trim();
      const c = parseColor(rawBg);
      if (!c && rawBg && rawBg.toLowerCase() !== 'transparent') return null;
      if (c && c.a > 0) {
        paints.push([c]);
        if (c.a >= 1) break;                     // opaque: nothing behind it shows
      }
      // The SLIDE is the last light-DOM layer that can paint behind its own text.
      // deck-stage.js paints `.canvas { background:#fff }` in SHADOW DOM and slots
      // the sections inside it, so a <deck-stage> or <body> ground sits BEHIND that
      // white canvas and never reaches the slide. Walking past the section read the
      // reference deck's `deck-stage{background:var(--dark)}` as the backdrop and
      // reported white-on-white as a clean ~21:1 — and `fallback` (STAGE_CANVAS),
      // which exists for exactly this, could never be reached. A false CLEAN on the
      // blocking gate ships the illegible slide, so this boundary is load-bearing.
      //
      // Known limit: a ground painted by a ::before/::after card (the CONTRACT
      // pattern, `section::before{position:absolute;inset:36px;background:…}`) is
      // still invisible here — pseudo-elements have no computed style to read in a
      // layout-free DOM, and the canonical one is a gradient, which has no
      // background-COLOR at all. Such a slide is measured against the section's own
      // ground, which is the conservative direction: it over-reports, never under.
      if (root && node === root) break;
    }
    // Composite bottom-up. A gradient contributes SEVERAL candidate grounds — the
    // audit cannot know which band of the wash a given line sits over — so the
    // result is a list; every other paint keeps it at one. Duplicates are dropped
    // so a many-stop gradient under a scrim cannot multiply out.
    let grounds = [fallback];
    for (let i = paints.length - 1; i >= 0; i--) {
      const seen = new Set();
      const next = [];
      for (const g of grounds) {
        for (const c of paints[i]) {
          const v = c.a >= 1 ? c : over(c, g);
          const k = Math.round(v.r) + ',' + Math.round(v.g) + ',' + Math.round(v.b);
          if (seen.has(k)) continue;
          seen.add(k);
          next.push(v);
        }
      }
      grounds = next;
    }
    return grounds;
  }
  const ownsText = (el) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
  const words = (text) => String(text || '').trim().split(/\s+/).filter(Boolean).length;

  const CAPTION = 'data-deck-caption';
  /** Words on the LIVE surface: every text node in the slide that is not inside
   *  a caption band and not inside something hidden.
   *
   *  Counted by walking rather than by subtracting captions from `innerText`:
   *  innerText ALREADY omits the caption in a real browser (it is display:none
   *  on screen) but not in a layout-free DOM, so subtraction is right in exactly
   *  one of the two and drives the count to zero in the other. */
  function liveWords(section, win) {
    // Concatenated first, counted once. Summing words() per TEXT NODE splits a
    // word an inline element interrupts — `Every <span>work</span>flow` counted
    // three where the slide reads two — and the 30-word cap is a blocking gate,
    // so a compliant slide with a couple of partial-word highlights cost a whole
    // fix cycle. Block-level children are joined with a space so copy in
    // neighbouring blocks does not fuse into one token instead.
    let text = '';
    (function walk(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) { text += child.textContent; continue; }
        if (child.nodeType !== 1) continue;
        if (child.hasAttribute && child.hasAttribute(CAPTION)) continue;
        const cs = win.getComputedStyle(child);
        if (cs.display === 'none') continue;
        // <br> computes to display:inline and has NO child nodes, so neither the
        // block rule below nor the recursion appended anything — and the words on
        // either side of it fused into one token. `Ship the deck<br>in one
        // afternoon` counted 5 against a 30-word cap the pipeline loops on, where
        // the slide plainly reads 6. innerText inserted a newline here; the walk
        // that replaced it has to say so itself.
        if (String(child.tagName || '').toLowerCase() === 'br') { text += ' '; continue; }
        const block = cs.display && !/^(inline|contents|none)$/.test(cs.display);
        if (block) text += ' ';
        walk(child);
        if (block) text += ' ';
      }
    })(section);
    return words(text);
  }
  /** Is `el` the caption band, or inside one? Walks to `root` exclusive. */
  function inCaption(el, root) {
    for (let n = el; n && n !== root; n = n.parentElement) {
      if (n.hasAttribute && n.hasAttribute(CAPTION)) return true;
    }
    return false;
  }

  /** Share of the font size a line of Latin text actually inks. A line box is
   *  taller than its glyphs by the leading and the descender space, and CSS
   *  splits half-leading evenly above and below — so the ink sits centred, about
   *  0.8em tall. Without this a 250px section numeral reaches 30px into the
   *  title below it and reads as a collision on a slide that is visually clean. */
  const INK = 0.8;
  function inkBand(r, fontPx) {
    const ink = Math.min(r.height, (fontPx || r.height) * INK);
    const pad = (r.height - ink) / 2;
    return { left: r.left, right: r.right, top: r.top + pad, bottom: r.bottom - pad };
  }

  /** The boxes an element's OWN text actually paints into: the line boxes of a
   *  Range over its direct text nodes. NOT the element's padding box — a
   *  compare cell whose single line of copy sits at the top of a tall box has
   *  800×250px of box and 700×60px of text, and the page folio in its empty
   *  bottom corner overlaps the former while touching none of the latter.
   *  Empty (a layout-free DOM, some print contexts) → the caller falls back to
   *  the element box, which errs toward reporting rather than toward silence. */
  function textBoxes(el, doc, fontPx) {
    const out = [];
    if (!doc || typeof doc.createRange !== 'function') return out;
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !n.textContent.trim()) continue;
      try {
        const range = doc.createRange();
        range.selectNodeContents(n);
        for (const r of Array.from(range.getClientRects() || [])) {
          if (r.width > 0 && r.height > 0) out.push(inkBand(r, fontPx));
        }
      } catch (e) { /* no usable Range here; the element box stands in */ }
    }
    return out;
  }

  const intersect = (a, b) => {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return w > TOL && h > TOL ? { w, h } : null;
  };

  /** Text that lands on other text. Only pairs that BOTH own text count, and
   *  the comparison is line box against line box (see textBoxes). Nested pairs
   *  are containment by design, never a collision. One issue per pair, naming
   *  the largest overlapping region found between them. */
  function overlapIssues(texts) {
    const out = [];
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i], b = texts[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        let worst = null;
        for (const ra of a.boxes) {
          for (const rb of b.boxes) {
            const hit = intersect(ra, rb);
            if (hit && (!worst || hit.w * hit.h > worst.w * worst.h)) worst = hit;
          }
        }
        if (!worst) continue;
        out.push({
          check: 'overlaps',
          selector: a.sel,
          detail: `text overlaps ${b.sel} by ${Math.round(worst.w)}×${Math.round(worst.h)}px`,
        });
      }
    }
    return out;
  }

  /** deck-stage.js paints `.canvas { background: #fff }`, and it lives in shadow
   *  DOM — unreachable from a light-DOM walk, so it is stated here instead. */
  const STAGE_CANVAS = Object.freeze({ r: 255, g: 255, b: 255, a: 1 });
  /** Is this element body copy — itself a p/li/blockquote, or wrapped in one
   *  within the slide? Walks to `root` exclusive. */
  function isBodyCopy(el, root) {
    for (let n = el; n && n !== root; n = n.parentElement) {
      if (!/^(p|li|blockquote)$/.test(String(n.tagName || '').toLowerCase())) continue;
      if (n === el) return true;
      // `<li><span>…</span></li>` IS the copy — the wrapper owns every word, and
      // requiring the text-owning element to be p/li/blockquote let 32px body copy
      // through clean. But a span carrying only PART of the line is an inline
      // accent: a meta label, a footnote marker, a <code> run. Applying the 36px
      // copy floor to every descendant made a designed 24px label a BLOCKING
      // finding on markup the deck renders as intended, and the audit is the
      // loop-back gate, so that costs a builder fix cycle on correct copy.
      const whole = String(n.textContent || '').trim();
      return !!whole && String(el.textContent || '').trim() === whole;
    }
    return false;
  }

  /** The reporting shape for an element: tag, #id, .classes. */
  function selectorFor(el) {
    return el.tagName.toLowerCase()
      + (el.id ? `#${el.id}` : '')
      + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '');
  }

  function auditSlide(section, index, win) {
    const slideRect = section.getBoundingClientRect();
    const box = { left: slideRect.left, top: slideRect.top, right: slideRect.left + SLIDE.w, bottom: slideRect.top + SLIDE.h };
    // What sits behind a slide that paints no ground of its own: the stage's
    // .canvas, which deck-stage.js paints #fff — in SHADOW DOM, where
    // effectiveBackground cannot walk. So white is the floor of this chain, not
    // black. `parseColor(...) || black` was dead code: an unstyled body computes
    // to `rgba(0,0,0,0)`, which parses FINE with a:0, leaving a transparent
    // black that luminance then reads as black — every dark-on-canvas element
    // became a contrast failure and white-on-white read as a clean 21:1.
    // effectiveBackground walks the ancestors — section and body included — so the
    // only thing left behind them is the stage canvas deck-stage paints in shadow
    // DOM, which no light-DOM walk can see.
    const fallbackBg = STAGE_CANVAS;
    const issues = [];
    let minFontPx = Infinity;
    const texts = [];
    // The SECTION itself is included: querySelectorAll('*') returns descendants
    // only, so a stray line of copy written straight into the <section> was
    // invisible to `small`, `body`, `contrast`, `clipped` and `overlaps` — the
    // one place a 20px line could hide from every legibility check.
    for (const el of [section, ...section.querySelectorAll('*')]) {
      // The caption band prints with the deck and never reaches the projector:
      // its geometry and its type are the print flow's business, not the
      // 1920×1080 slide's.
      if (inCaption(el, section)) continue;
      const cs = win.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const sel = selectorFor(el);
      if (r.right > box.right + TOL || r.bottom > box.bottom + TOL || r.left < box.left - TOL || r.top < box.top - TOL) {
        issues.push({ check: 'escapes', selector: sel, detail: `box ${Math.round(r.left - box.left)},${Math.round(r.top - box.top)} ${Math.round(r.width)}×${Math.round(r.height)} leaves the ${SLIDE.w}×${SLIDE.h} slide` });
      }
      if (ownsText(el)) {
        const px = parseFloat(cs.fontSize) || 0;
        // No line boxes (layout-free DOM, some print contexts) → the element box
        // stands in, raw: with no font-relative geometry there is nothing to
        // inset by, and erring toward reporting beats erring toward silence.
        const boxes = textBoxes(el, section.ownerDocument, px);
        texts.push({ el, sel, boxes: boxes.length ? boxes : [r] });
        if (el.scrollWidth > el.clientWidth + TOL) issues.push({ check: 'clipped', selector: sel, detail: `scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}` });
        minFontPx = Math.min(minFontPx, px);
        if (px < 20) issues.push({ check: 'small', selector: sel, detail: `${px}px text (floor 20px)` });
        // The floor follows the COPY, not the tag that happens to own the text
        // node: `<li><span>…</span></li>` is the usual shape, and requiring the
        // text-owning element itself to be p/li/blockquote let 32px body copy
        // through clean.
        if (px < 36 && isBodyCopy(el, section)) issues.push({ check: 'body', selector: sel, detail: `${px}px body text (floor 36px)` });
        const fg = parseColor(cs.color);
        if (fg && fg.a === 0) {
          // `color: transparent` paints no glyphs from `color`. The canonical
          // gradient headline (background:linear-gradient + background-clip:text)
          // relies on that and lets the BACKGROUND paint them — but parseColor
          // returns {a:0}, which is truthy, so over(fg,bg) collapsed to bg and
          // contrastRatio(bg,bg) reported 1.00:1 on a title that renders
          // perfectly. A ratio needs two colours; here there is one, so it is not
          // measurable and must not be reported as a failure.
          //
          // Text with a transparent colour and NOTHING painting it is genuinely
          // invisible, and that is still worth saying. background-clip is the
          // precise signal in a browser; a background IMAGE is the portable one
          // (a layout-free DOM does not honour background-clip), and either means
          // something other than `color` is doing the painting.
          const clip = String(cs.backgroundClip || cs.webkitBackgroundClip || '');
          const paintedByBackground = /(^|\s)text($|\s)/.test(clip)
            || (cs.backgroundImage && cs.backgroundImage !== 'none');
          if (!paintedByBackground) {
            issues.push({ check: 'contrast', selector: sel, detail: 'color is transparent and nothing paints the glyphs' });
          }
        } else if (fg) {
          const grounds = effectiveBackground(el, win, fallbackBg, section);
          // `null` = a ground this DOM cannot read (a url() photo, a cross-fade).
          // Not measurable, so not reportable: the blocking gate must never fail a
          // slide on a colour it had to invent.
          //
          // The WORST candidate a gradient passes through decides the verdict. The
          // audit cannot know which band of the ground a given line sits over, and
          // the pale end of a light->dark wash is exactly where white copy stops
          // being legible — so the dark deck stops being a false failure without
          // the gate going blind to the real one.
          let ratio = Infinity;
          for (const bg of (grounds || [])) ratio = Math.min(ratio, contrastRatio(over(fg, bg), bg));
          if (grounds) {
          // The pivot is the BODY FLOOR, not a number of its own. WCAG relaxes
          // contrast for large text, and with the body floor at 36px a pivot of 36
          // would hand every piece of body copy set at its floor the 3:1 allowance —
          // so lowering the type would quietly lower the contrast requirement too,
          // with nothing reported. 48px is where type is genuinely large.
          const floor = px >= 48 ? 3 : 4.5;
          if (ratio < floor) issues.push({ check: 'contrast', selector: sel, detail: `${ratio.toFixed(2)}:1 at ${px}px (floor ${floor}:1)` });
          }
        }
      }
    }
    for (const o of overlapIssues(texts)) issues.push(o);
    // THE CAPTION'S FIT, and only its fit — every other check still excludes the
    // band, which is not the live surface. The print sheet pins each slide to
    // exactly the design height with overflow:hidden (`!important` from the shadow
    // tree, so no author rule lifts it), and the band is a flow child: on a slide
    // whose content already fills the page it lays out past the bottom edge and is
    // clipped out of the PDF. Silently — which is why this measures it.
    //
    // Letting the slide grow instead is NOT the remedy: `break-after: page` then
    // prints a second page, and the export gate treats page-count != slide-count as
    // blocking and loops back to a builder that is forbidden to edit kit files. So
    // the kit reports a fit the BUILDER can fix: shorten the slide, or the caption.
    for (const cap of section.querySelectorAll(`[${CAPTION}]`)) {
      const prior = cap.getAttribute('style');
      // Revealed only to be measured: on screen the band is display:none and has no
      // box at all, so an unrevealed rect would always "fit".
      cap.setAttribute('style', `${prior ? `${prior.replace(/;\s*$/, '')};` : ''}display:block !important`);
      const r = cap.getBoundingClientRect();
      if (prior === null) cap.removeAttribute('style'); else cap.setAttribute('style', prior);
      if (!r || !r.height) continue;                    // no layout to judge (or empty band)
      if (r.bottom > box.bottom + TOL) {
        issues.push({
          check: 'caption', selector: selectorFor(cap),
          detail: `the caption band runs ${Math.round(r.bottom - box.bottom)}px past the printed page`
            + ' and would be clipped out of the PDF — shorten the slide or the caption',
        });
      }
    }
    return {
      slide: index + 1,
      label: section.getAttribute('data-label') || null,
      skipped: section.hasAttribute('data-deck-skip'),
      // A `Mode: both` deck puts its read-alone completeness in the caption band
      // precisely so the projected surface can stay under the 30-word cap.
      words: liveWords(section, win),
      minFontPx: minFontPx === Infinity ? null : minFontPx,
      issues,
    };
  }

  /** Make one slide measurable, changing as little as possible.
   *
   *  The stage stacks slides with `position:absolute; inset:0` and hides the
   *  inactive ones with `opacity:0; visibility:hidden` — so an inactive section
   *  ALREADY has layout, and only those two properties need overriding.
   *
   *  `display` is deliberately NOT forced. An important inline declaration beats
   *  the deck's own stylesheet, so writing `display:block !important` replaced
   *  the author's display: a `display:grid` two-column slide (the layout
   *  CONTRACT.md's own reference deck uses) was measured as stacked block flow,
   *  with every child box the full slide width instead of its track. That is a
   *  layout the deck never renders — `clipped` compared scrollWidth against the
   *  wrong box, and real overflow could pass as clean. Only a section with NO
   *  layout at all (computed `display:none`) gets block flow, because otherwise
   *  it cannot be measured at all.
   *
   *  The author's own inline style is saved and restored rather than deleted:
   *  the loop deselects every slide on each iteration, so `removeAttribute`
   *  stripped an inline ground from slides that had not been measured yet and
   *  `contrast` was then computed against the body background. */
  function forceVisible(section, on, win) {
    if (!on) {
      const prior = section.__deckAuditStyle;
      if (prior === undefined) return;                 // never forced; leave it alone
      if (prior === null) section.removeAttribute('style'); else section.setAttribute('style', prior);
      delete section.__deckAuditStyle;
      return;
    }
    if (section.__deckAuditStyle === undefined) section.__deckAuditStyle = section.getAttribute('style');
    const hidden = win && win.getComputedStyle(section).display === 'none';
    const prior = section.__deckAuditStyle;
    const base = prior ? `${prior.replace(/;\s*$/, '')};` : '';
    section.setAttribute('style',
      `${base}visibility:visible !important;opacity:1 !important${hidden ? ';display:block !important' : ''}`);
  }

  /** Measure EVERY slide. `location.hash` is deliberately not consulted — see
   *  the header: deck-stage.js has already stamped one in by the time this runs. */
  function run(doc, win) {
    const stage = doc.querySelector('deck-stage');
    const sections = stage ? Array.from(stage.querySelectorAll(':scope > section')) : [];
    const slides = [];
    // A stage authored at another size would be measured against the wrong box
    // and the wrong type floors, silently. Say so instead.
    // An ABSENT dimension is not unknown — it is deck-stage's own default, which
    // is this canvas. Requiring both attributes let `<deck-stage width="1280">`
    // (height defaulting to 1080) past the guard and measured it against the 1920
    // box, reporting no mismatch at all: the silent mismeasurement this exists to
    // prevent.
    const declared = stage && {
      w: parseInt(stage.getAttribute('width'), 10) || SLIDE.w,
      h: parseInt(stage.getAttribute('height'), 10) || SLIDE.h,
    };
    let canvasMismatch = declared && (declared.w !== SLIDE.w || declared.h !== SLIDE.h)
      ? `${declared.w}×${declared.h}` : null;
    let rendered = null;
    for (let i = 0; i < sections.length; i++) {
      sections.forEach((x, j) => forceVisible(x, j === i, win));
      if (i === 0) {
        const r0 = sections[0].getBoundingClientRect();
        rendered = { w: Math.round(r0.width), h: Math.round(r0.height) };
      }
      slides.push(auditSlide(sections[i], i, win));
    }
    // What the slide ACTUALLY measures, not just what it declares. Every geometry
    // check builds its box as `slideRect.left/top + SLIDE.w/SLIDE.h`, i.e. it
    // assumes the stage renders 1:1 — which holds only with `noscale`, and that is
    // prose in CONTRACT.md, not something the kit verified. On a scaled stage the
    // real box is smaller than the assumed one, so content hanging off the edge
    // lands inside it and `escapes` reports CLEAN on genuine overflow. A missing
    // attribute must not buy a clean verdict from the blocking gate.
    if (!canvasMismatch && rendered && rendered.w && rendered.h
      && (Math.abs(rendered.w - SLIDE.w) > 1 || Math.abs(rendered.h - SLIDE.h) > 1)) {
      canvasMismatch = `${rendered.w}×${rendered.h} rendered (design ${SLIDE.w}×${SLIDE.h})`
        + ' — the stage is scaled; render the proof with the `noscale` attribute';
    }
    sections.forEach((x) => forceVisible(x, false, win));
    // NOTHING MEASURED is not a clean deck. With no usable <deck-stage> — the
    // element never upgraded because deck-stage.js 404'd from the run folder, or
    // the builder emitted the wrong root — `sections` is empty, `declared` is null
    // so canvasMismatch never fires, and this returned {slideCount: 0, slides: []}:
    // a report the agent reads as "no issues", terminating the fix loop on a deck
    // no check ever looked at. Every other silent-mismeasurement path here is
    // reported; this one was not.
    const stageError = !stage
      ? 'no <deck-stage> element on the page — nothing was measured'
      : (sections.length === 0 ? '<deck-stage> holds no <section> slides — nothing was measured' : null);
    return {
      schema: 1, canvas: SLIDE, slideCount: sections.length, slides,
      ...(canvasMismatch ? { canvasMismatch } : {}),
      ...(stageError ? { stageError } : {}),
    };
  }

  /** Wait for webfonts before measuring, with a ceiling so a font that never
   *  arrives cannot hang the audit. Every metric-dependent check — clipped,
   *  escapes, overlaps, and the inkBand line boxes — depends on the glyphs
   *  actually in use: measured at DOMContentLoaded the text is still laid out in
   *  the FALLBACK face, so a title that fits in the real face but overflows in
   *  the fallback is reported as a blocking `major` and costs the builder a fix
   *  cycle on a slide that renders correctly. The inverse is just as reachable.
   *  A document with no font API (a layout-free DOM) resolves immediately. */
  function fontsReady(doc, timeoutMs) {
    const ready = doc && doc.fonts && doc.fonts.ready;
    if (!ready || typeof ready.then !== 'function') return Promise.resolve();
    // The ceiling timer is CLEARED when the fonts win. Left pending it is
    // invisible in a browser but keeps a Node event loop alive for the full
    // ceiling after the audit has already returned. And a REJECTING font promise
    // (a face that 404s) resolves here rather than propagating: the report is the
    // point of the run, and publishing it in the fallback face beats not
    // publishing it at all.
    let timer = null;
    const ceiling = new Promise((r) => { timer = setTimeout(r, timeoutMs); });
    return Promise.race([ready, ceiling])
      .catch(() => {})
      .then((v) => { if (timer !== null) clearTimeout(timer); return v; });
  }

  async function runAndPublish(doc, win, opts) {
    await fontsReady(doc, (opts && opts.fontTimeoutMs) || 5000);
    const report = run(doc, win);
    win.__DECK_AUDIT = report;
    let tag = doc.getElementById('deck-audit-report');
    if (!tag) { tag = doc.createElement('script'); tag.type = 'application/json'; tag.id = 'deck-audit-report'; doc.body.appendChild(tag); }
    tag.textContent = JSON.stringify(report);
    return report;
  }

  return { parseColor, luminance, contrastRatio, over, words, textBoxes, fontsReady, auditSlide, run, runAndPublish, SLIDE };
});
