// test/deck-audit-dom.test.mjs — deck-audit.js against a real DOM.
//
// The pure helpers (contrast, parseColor, words) are covered by
// test/deck-audit-kit.test.mjs; these pin the DOM-walking half, which is where
// three real presentation runs found the kit wrong:
//   · run() measured ONE slide, because deck-stage.js stamps `#1` into the URL
//     on mount and the audit's "no hash → every slide" branch never fired;
//   · a text-on-text collision was reported CLEAN (R1's only critical), because
//     no check looked at whether two boxes land on each other;
//   · a `Mode: both` deck has a printed caption layer that must not count as
//     live-surface words, or the 30-word cap can never be met.
//
// jsdom has no layout engine, so every rect is injected through `data-r`
// ("left,top,width,height") and scroll metrics through `data-scroll`
// ("scrollWidth,clientWidth"). Assertions filter by `check` so jsdom's default
// black-on-transparent contrast noise cannot mask the property under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const DeckAudit = require('../assets/deck-kit/deck-audit.js');

/** Build a document from slide markup and give every [data-r] element its box. */
function stage(...sections) {
  const dom = new JSDOM(
    `<!doctype html><body><deck-stage width="1920" height="1080" noscale>${sections.join('')}</deck-stage></body>`,
    { url: 'http://localhost/proof.html' },
  );
  const { window } = dom;
  for (const el of window.document.querySelectorAll('[data-r]')) {
    const [left, top, width, height] = el.getAttribute('data-r').split(',').map(Number);
    el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
    const scroll = el.getAttribute('data-scroll');
    const [sw, cw] = scroll ? scroll.split(',').map(Number) : [Math.round(width), Math.round(width)];
    Object.defineProperty(el, 'scrollWidth', { value: sw, configurable: true });
    Object.defineProperty(el, 'clientWidth', { value: cw, configurable: true });
  }
  // jsdom has no layout, so Range.getClientRects() — the real line boxes of a
  // text node — is always empty. Feed it the boxes the test declares in
  // `data-tr` ("l,t,w,h" per line box, ';'-separated), exactly as `data-r`
  // feeds getBoundingClientRect. Without a data-tr the range stays empty and
  // the audit falls back to the element box, which is the no-Range path.
  const makeRange = window.document.createRange.bind(window.document);
  window.document.createRange = () => {
    const range = makeRange();
    const select = range.selectNodeContents.bind(range);
    range.selectNodeContents = (node) => { range.__node = node; return select(node); };
    range.getClientRects = () => {
      const el = range.__node && range.__node.parentElement;
      const tr = el && el.getAttribute('data-tr');
      if (!tr) return [];
      return tr.split(';').map((s) => {
        const [left, top, width, height] = s.split(',').map(Number);
        return { left, top, width, height, right: left + width, bottom: top + height };
      });
    };
    return range;
  };
  return window;
}

const SLIDE_BOX = 'data-r="0,0,1920,1080"';
const checksOf = (slide, check) => slide.issues.filter((i) => i.check === check);

test('run() measures every slide even when the URL already carries a #N hash', () => {
  // deck-stage.js:_applyIndex does history.replaceState(null,'','#1') on mount,
  // and the contract loads deck-audit.js AFTER it — so a hash is ALWAYS present
  // by the time the audit runs, and honouring it audited slide 1 of N forever.
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01"><h1 data-r="40,40,800,90">One</h1></section>`,
    `<section ${SLIDE_BOX} data-label="02"><h1 data-r="40,40,800,90">Two</h1></section>`,
    `<section ${SLIDE_BOX} data-label="03"><h1 data-r="40,40,800,90">Three</h1></section>`,
  );
  win.location.hash = '#1';
  const report = DeckAudit.run(win.document, win);
  assert.equal(report.slideCount, 3);
  assert.equal(report.slides.length, 3, 'every slide is measured, hash or no hash');
  assert.deepEqual(report.slides.map((s) => s.slide), [1, 2, 3]);
  assert.deepEqual(report.slides.map((s) => s.label), ['01', '02', '03']);
});

test('overlaps: two non-nested text boxes landing on each other is a finding', () => {
  // R1's only critical: "the subtitle renders on top of the meta line — an
  // absolutely positioned footer under a centred overflowing stack". The audit
  // of that cycle reported 0 escapes and 0 clipped, because neither check looks
  // at two elements occupying the same place.
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01">`
    + `<p class="subtitle" data-r="160,820,1600,140" data-tr="160,880,900,60">A subtitle that grew</p>`
    + `<p class="meta" data-r="160,900,1600,60" data-tr="160,900,700,60">March 2026 · internal</p>`
    + `</section>`,
  );
  const [slide] = DeckAudit.run(win.document, win).slides;
  const hits = checksOf(slide, 'overlaps');
  assert.equal(hits.length, 1, JSON.stringify(slide.issues));
  assert.match(hits[0].selector, /p\.subtitle|p\.meta/);
  assert.match(hits[0].detail, /^text overlaps \S+ by \d+×\d+px$/,
    'the detail names the other element and the overlapping area');
});

test('overlaps: a folio in the empty corner of a text box is not a collision', () => {
  // The real false positive this check must not produce: on slide 21 of a real
  // 43-slide run the page folio sits inside the BOX of a compare cell whose one
  // line of copy is at the top of that box. The boxes overlap by 38×40px; no
  // glyph touches another. "Bounding boxes overlap far more often than glyphs
  // do" — so the check measures the line boxes the text paints into, not the
  // element's padding box.
  const win = stage(
    `<section ${SLIDE_BOX} data-label="21">`
    + `<div class="split-cell is-gap" data-r="960,830,800,250" data-tr="1000,840,700,60">A line. It ends at the PR.</div>`
    + `<span class="folio" data-r="1700,1010,38,40" data-tr="1700,1010,38,40">21</span>`
    + `</section>`,
  );
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.deepEqual(checksOf(slide, 'overlaps'), [],
    'a box overlap with no glyph overlap is not a finding');
});

test('overlaps: a display numeral above a title is not a collision', () => {
  // Measured on slide 5 of a real 43-slide run, which is visually clean: a 250px
  // section numeral sits ABOVE the title. Its line box is ~300px tall because a
  // line box carries leading and descender space the glyphs never ink, so it
  // reaches 30px into the title's line box. Comparing raw line boxes called this
  // — and 20 more like it — a collision. The ink band each line actually paints
  // is about 0.8em, centred in the line box (CSS splits half-leading evenly).
  const win = stage(
    `<section ${SLIDE_BOX} data-label="05">`
    + `<div class="numeral" data-r="120,80,336,300" data-tr="120,80,336,300" style="font-size:250px">01</div>`
    + `<h2 class="title" data-r="120,350,900,290" data-tr="120,350,900,96" style="font-size:80px">The claim</h2>`
    + `</section>`,
  );
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.deepEqual(checksOf(slide, 'overlaps'), [], JSON.stringify(slide.issues));
});

test('overlaps: body copy genuinely set on top of body copy still reports', () => {
  // The positive control for the inset above: same 48px type, one line sitting
  // squarely on another. This is R1's critical — "the subtitle renders on top of
  // the meta line" — and it must survive any noise reduction.
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01">`
    + `<p class="subtitle" data-r="160,880,900,60" data-tr="160,880,900,60" style="font-size:48px">A subtitle that grew</p>`
    + `<p class="meta" data-r="160,890,700,60" data-tr="160,890,700,60" style="font-size:48px">March 2026</p>`
    + `</section>`,
  );
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.equal(checksOf(slide, 'overlaps').length, 1, JSON.stringify(slide.issues));
});

test('overlaps: with no line boxes available the element box is the fallback', () => {
  // Range.getClientRects() is empty in a layout-free DOM and in some print
  // contexts. Falling back to the element box keeps the check working rather
  // than silently passing everything, which is the failure mode that let a
  // text-on-text critical through in the first place.
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01">`
    + `<p class="a" data-r="160,820,900,140">stacked</p>`
    + `<p class="b" data-r="160,900,900,60">on top</p>`
    + `</section>`,
  );
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.equal(checksOf(slide, 'overlaps').length, 1, JSON.stringify(slide.issues));
});

test('overlaps: nested text and neighbours that merely sit side by side are clean', () => {
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01">`
    // <strong> is INSIDE <p>: its box is contained by design, never a collision.
    + `<p class="lead" data-r="160,200,1600,120">four of <strong data-r="400,200,200,120">six</strong> stages</p>`
    // Two columns that abut but do not overlap.
    + `<div class="col-a" data-r="160,400,780,300">left</div>`
    + `<div class="col-b" data-r="980,400,780,300">right</div>`
    + `</section>`,
  );
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.deepEqual(checksOf(slide, 'overlaps'), [], JSON.stringify(slide.issues));
});

test('a [data-deck-caption] band is excluded from the live word count', () => {
  // Mode `both`: the live surface stays under 30 words and the caption carries
  // the read-alone completeness into the PDF. Counting it made the cap
  // unwinnable — 20/28, 10/28 and 32/43 slides over it on the three real runs.
  const win = stage(
    `<section ${SLIDE_BOX} data-label="07">`
    + `<h1 data-r="160,160,1600,120">Review is where the loop breaks</h1>`
    + `<p class="lead" data-r="160,320,1600,80">Four of six stages are unowned.</p>`
    + `<div data-deck-caption data-r="160,700,1600,300">`
    + `Anthropic's playbook names six stages of the software lifecycle and worca owns`
    + ` exactly two of them end to end today, which is the whole argument of this deck.`
    + `</div></section>`,
  );
  const [slide] = DeckAudit.run(win.document, win).slides;
  // "Review is where the loop breaks" (6) + "Four of six stages are unowned." (6).
  // The 28-word caption is print copy and must not appear in this number.
  assert.equal(slide.words, 12, 'the caption is not live-surface copy');
});

test('a hidden icon sprite contributes no words either', () => {
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01">`
    + `<svg style="display:none"><symbol id="i-gate"><title>gate marker</title></symbol></svg>`
    + `<h1 data-r="160,160,1600,120">Two owned stages</h1></section>`,
  );
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.equal(slide.words, 3, 'the sprite\'s <title> text is not on the slide');
});

test('a caption subtree is not measured for legibility either', () => {
  // Caption prose is print copy in a flowing document, not a fixed rectangle:
  // the 27px floor and the 48px body floor are live-surface rules.
  const win = stage(
    `<section ${SLIDE_BOX} data-label="07">`
    + `<h1 data-r="160,160,1600,120" style="font-size:72px">Title</h1>`
    + `<div data-deck-caption data-r="160,700,1600,300" style="font-size:20px">`
    + `<p data-r="160,700,1600,140" style="font-size:20px">Small print copy.</p></div>`
    + `</section>`,
  );
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.deepEqual(checksOf(slide, 'small'), [], 'the caption does not trip the 27px floor');
  assert.deepEqual(checksOf(slide, 'body'), [], 'the caption does not trip the 48px body floor');
  assert.equal(slide.minFontPx, 72, 'the smallest LIVE type is the 72px title');
});

test('a caption that escapes the slide box is not an escape either', () => {
  // The caption is laid out by the print flow, below the slide rectangle; only
  // live-surface geometry is measured against the 1920×1080 box.
  const win = stage(
    `<section ${SLIDE_BOX} data-label="07">`
    + `<h1 data-r="160,160,1600,120">Title</h1>`
    + `<div data-deck-caption data-r="160,1100,1600,400">Overflowing print prose.</div>`
    + `</section>`,
  );
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.deepEqual(checksOf(slide, 'escapes'), [], JSON.stringify(slide.issues));
});

test('live-surface checks still fire: escapes and clipped are unchanged', () => {
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01">`
    + `<p class="wide" data-r="160,1000,1900,140">leaves the slide</p>`
    + `<p class="nowrap" data-r="160,200,800,80" data-scroll="1980,800">clipped text</p>`
    + `</section>`,
  );
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.equal(checksOf(slide, 'escapes').length, 1);
  assert.equal(checksOf(slide, 'clipped').length, 1);
});

// forceVisible used to write `display:block !important` inline before measuring a
// slide. An important inline declaration beats the deck's own stylesheet, so a
// section the author set to `display:grid` (the two-column layout CONTRACT.md's
// own reference deck uses) was measured as stacked block flow — a layout the deck
// never renders, with every child box the full slide width instead of its track.
// Verified in real Chrome: computed display went grid -> block and a 1fr/820px
// pair became two 1648px blocks. Every escapes/overlaps/clipped number was then
// taken against the wrong geometry.
//
// The stage stacks slides with position+inset and hides them with opacity and
// visibility, so an inactive section already HAS layout: forcing display was
// never needed. These assertions watch the inline style AT MEASURE TIME, via the
// section's own rect stub — auditSlide reads it before anything else.
function styleAtMeasure(sectionHtml, extra = '') {
  const win = stage(sectionHtml);
  const seen = [];
  for (const sec of win.document.querySelectorAll('deck-stage > section')) {
    const rect = sec.getBoundingClientRect.bind(sec);
    sec.getBoundingClientRect = () => { seen.push(sec.getAttribute('style') || ''); return rect(); };
  }
  DeckAudit.run(win.document, win);
  return { seen, win, extra };
}

test('the audit never forces display on a slide that already has layout', () => {
  const { seen } = styleAtMeasure(
    `<section ${SLIDE_BOX} data-label="01" style="display:grid;grid-template-columns:1fr 820px">`
    + `<h1 data-r="136,112,700,226">Left</h1><p data-r="900,112,820,280">Right</p></section>`,
  );
  // The section's rect is read more than once now that it is measured as an
  // element too; every reading must see the same forced style.
  assert.ok(seen.length >= 1);
  for (const style of seen) {
    assert.doesNotMatch(style, /display:\s*block/, 'block flow must not replace the author grid');
    assert.match(style, /display:\s*grid/, 'and the author display is still in force');
    assert.match(style, /visibility:\s*visible/, 'visibility is what actually needed forcing');
  }
});

test('a slide the author really hid still gets block flow, or it cannot be measured', () => {
  const { seen } = styleAtMeasure(
    `<section ${SLIDE_BOX} data-label="01" style="display:none">`
    + `<h1 data-r="136,112,700,226">Hidden</h1></section>`,
  );
  assert.match(seen[0], /display:\s*block/, 'display:none has no layout at all — override it');
});

test('the audit restores the author inline style instead of deleting it', () => {
  // removeAttribute('style') wiped a ground set inline, and the loop deselects
  // every slide on each iteration — so slide 2 lost its background before it was
  // measured and `contrast` was computed against the body instead.
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01" style="background:rgb(255,255,255)"><h1 data-r="40,40,800,90">One</h1></section>`,
    `<section ${SLIDE_BOX} data-label="02" style="background:rgb(17,17,17)"><h1 data-r="40,40,800,90">Two</h1></section>`,
  );
  DeckAudit.run(win.document, win);
  const [a, b] = win.document.querySelectorAll('deck-stage > section');
  assert.equal(a.getAttribute('style'), 'background:rgb(255,255,255)');
  assert.equal(b.getAttribute('style'), 'background:rgb(17,17,17)');
});

test('a slide with no inline style of its own ends up with none', () => {
  const win = stage(`<section ${SLIDE_BOX} data-label="01"><h1 data-r="40,40,800,90">One</h1></section>`);
  DeckAudit.run(win.document, win);
  assert.equal(win.document.querySelector('deck-stage > section').hasAttribute('style'), false);
});

// runAndPublish measured at DOMContentLoaded, when webfont FILES have not
// loaded yet — so every metric-dependent check (clipped, escapes, overlaps, and
// the inkBand line boxes) was taken against fallback glyph metrics. A title that
// fits in the real face but overflows in the fallback is then a blocking `major`
// and costs the builder a fix cycle on a slide that renders correctly; the
// inverse — real overflow reported clean — is equally reachable. One real run's
// audit worked around it by hand, reporting it had "re-measured after
// document.fonts.ready".
test('runAndPublish waits for the document fonts before measuring', async () => {
  const win = stage(`<section ${SLIDE_BOX} data-label="01"><h1 data-r="40,40,800,90">One</h1></section>`);
  let released = null;
  let measuredBeforeRelease = false;
  win.document.fonts = { ready: new Promise((r) => { released = r; }) };

  const done = DeckAudit.runAndPublish(win.document, win);
  await new Promise((r) => setTimeout(r, 10));
  measuredBeforeRelease = !!win.document.getElementById('deck-audit-report');
  assert.equal(measuredBeforeRelease, false, 'nothing is measured while the fonts are still loading');

  released();
  const report = await done;
  assert.equal(report.slides.length, 1);
  assert.ok(win.document.getElementById('deck-audit-report'), 'and the report is published after');
});

test('a document with no font API still publishes', async () => {
  const win = stage(`<section ${SLIDE_BOX} data-label="01"><h1 data-r="40,40,800,90">One</h1></section>`);
  delete win.document.fonts;
  const report = await DeckAudit.runAndPublish(win.document, win);
  assert.equal(report.slides.length, 1);
  assert.ok(win.document.getElementById('deck-audit-report'));
});

test('a font promise that never settles cannot hang the audit forever', async () => {
  const win = stage(`<section ${SLIDE_BOX} data-label="01"><h1 data-r="40,40,800,90">One</h1></section>`);
  win.document.fonts = { ready: new Promise(() => {}) };          // never resolves
  const report = await DeckAudit.runAndPublish(win.document, win, { fontTimeoutMs: 20 });
  assert.equal(report.slides.length, 1, 'measured anyway once the timeout elapsed');
});

// A slide that sets no background of its own sits on the stage's canvas, which
// deck-stage.js paints `#fff` — in SHADOW DOM, where effectiveBackground cannot
// walk. The fallback was `parseColor(body.backgroundColor) || opaque black`, but
// an unstyled body computes to `rgba(0,0,0,0)`, which PARSES FINE with a:0, so
// the `||` never fired and the fallback was a transparent black that luminance
// then treats as black. Every dark-on-canvas element read as a contrast failure,
// and genuinely invisible white-on-white text read as a clean 21:1.
const UNSTYLED_BODY = 'rgba(0, 0, 0, 0)';

test('an unbacked slide is measured against the white canvas, not against black', () => {
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01">`
    + `<h1 data-r="40,40,800,90" style="color:rgb(17,17,17);font-size:72px">Dark on the canvas</h1>`
    + `</section>`,
  );
  win.document.body.style.backgroundColor = UNSTYLED_BODY;
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.deepEqual(checksOf(slide, 'contrast'), [], 'dark text on a white canvas is not a contrast failure');
});

test('white text on the white canvas IS a contrast failure', () => {
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01">`
    + `<h1 data-r="40,40,800,90" style="color:rgb(255,255,255);font-size:72px">Invisible</h1>`
    + `</section>`,
  );
  win.document.body.style.backgroundColor = UNSTYLED_BODY;
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.equal(checksOf(slide, 'contrast').length, 1, 'white on white must not read as 21:1');
});

test('a slide that paints its own dark ground still wins over the canvas', () => {
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01" style="background-color:rgb(17,17,17)">`
    + `<h1 data-r="40,40,800,90" style="color:rgb(255,255,255);font-size:72px">Light on dark</h1>`
    + `</section>`,
  );
  win.document.body.style.backgroundColor = UNSTYLED_BODY;
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.deepEqual(checksOf(slide, 'contrast'), [], JSON.stringify(slide.issues));
});

// The 48px body floor required the TEXT-OWNING element to be p/li/blockquote, but
// the usual shape wraps the copy: <li><span>…</span></li>. The <li> owns no direct
// text and the <span> fails the tag test, so 32px body copy passed clean — only
// the 27px `small` floor still fired, and that one it clears.
test('the body floor applies to copy wrapped inside a p or li', () => {
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01">`
    + `<ul data-r="40,200,800,300"><li data-r="40,200,800,60">`
    + `<span data-r="40,200,800,60" style="font-size:32px">Wrapped body copy</span></li></ul>`
    + `<p data-r="40,400,800,60"><em data-r="40,400,800,60" style="font-size:32px">Also wrapped</em></p>`
    + `</section>`,
  );
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.equal(checksOf(slide, 'body').length, 2, JSON.stringify(slide.issues));
});

test('a heading nested in a non-body element is not held to the body floor', () => {
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01">`
    + `<div data-r="40,40,800,90"><span data-r="40,40,800,90" style="font-size:36px">Kicker</span></div>`
    + `</section>`,
  );
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.deepEqual(checksOf(slide, 'body'), [], 'only p/li/blockquote copy carries the 36px floor');
});

// firstOpaque returned any colour with a > 0 and handed it to effectiveBackground
// as the fallback — but `luminance` ignores alpha, so a translucent ground was
// measured as if it were fully opaque, and a translucent ancestor was composited
// over that same translucent value instead of over the canvas behind it.
// A `rgba(0,0,0,.45)` scrim over the white stage with white text resolves to pure
// black and reports a clean 21:1, when as PAINTED it is mid-grey and the real
// ratio is about 3.4 — under the floor. The audit is the blocking gate, so that
// ships an illegible slide.
test('a translucent ground is composited over the canvas, not treated as opaque', () => {
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01" style="background-color:rgba(0,0,0,0.45)">`
    + `<p data-r="40,40,800,90" style="color:rgb(255,255,255);font-size:30px">Over a scrim</p>`
    + `</section>`,
  );
  win.document.body.style.backgroundColor = 'rgba(0, 0, 0, 0)';
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.equal(checksOf(slide, 'contrast').length, 1,
    'white on a 45% scrim over white is ~3.4:1 and must be reported');
});

test('a fully opaque ground is still measured as itself', () => {
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01" style="background-color:rgb(0,0,0)">`
    + `<p data-r="40,40,800,90" style="color:rgb(255,255,255);font-size:30px">On real black</p>`
    + `</section>`,
  );
  win.document.body.style.backgroundColor = 'rgba(0, 0, 0, 0)';
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.deepEqual(checksOf(slide, 'contrast'), [], 'white on black is 21:1');
});

// liveWords summed words() PER TEXT NODE, so an inline element splitting a word
// without surrounding whitespace counted twice: `Every <span>work</span>flow` is
// two words, not three. The 30-word cap is a blocking gate, so a compliant slide
// with a couple of partial-word highlights cost a whole fix cycle.
test('an inline span splitting a word does not inflate the word count', () => {
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01">`
    + `<h1 data-r="40,40,800,90">Every <span>work</span>flow is a loop</h1></section>`,
  );
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.equal(slide.words, 5, 'Every / workflow / is / a / loop');
});

test('words separated by real whitespace across elements still count separately', () => {
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01">`
    + `<h1 data-r="40,40,800,90">One <em>two</em> three</h1>`
    + `<p data-r="40,200,800,60">four five</p></section>`,
  );
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.equal(slide.words, 5);
});

// querySelectorAll('*') returns descendants only, never the <section> itself, so
// text owned DIRECTLY by the section was invisible to every legibility check —
// a stray 20px line before the heading passed `small`, `body` and `contrast`.
test('text owned directly by the section is measured too', () => {
  const win = stage(
    `<section ${SLIDE_BOX} data-label="03" style="font-size:19px;color:rgb(250,250,250)">`
    + `Rough numbers, Q3<h1 data-r="40,200,800,90" style="font-size:72px">Cost</h1></section>`,
  );
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.equal(checksOf(slide, 'small').length, 1, JSON.stringify(slide.issues));
  assert.match(checksOf(slide, 'small')[0].selector, /^section/);
});

// SLIDE is pinned to 1920×1080 and the 27/48px floors are that canvas's numbers.
// A stage authored at another size was measured against the wrong box (nothing
// could escape a 1920-wide box on a 1280 slide) and the wrong type floors —
// silently. The report now says so.
test('a stage authored at another size is reported, not silently mismeasured', () => {
  const dom = new JSDOM(
    '<!doctype html><body><deck-stage width="1280" height="720" noscale>'
    + `<section data-r="0,0,1280,720" data-label="01"><h1 data-r="40,40,600,60">One</h1></section>`
    + '</deck-stage></body>', { url: 'http://localhost/proof.html' },
  );
  for (const el of dom.window.document.querySelectorAll('[data-r]')) {
    const [left, top, width, height] = el.getAttribute('data-r').split(',').map(Number);
    el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height });
  }
  const report = DeckAudit.run(dom.window.document, dom.window);
  assert.equal(report.canvasMismatch, '1280×720');
  assert.deepEqual(report.canvas, { w: 1920, h: 1080 }, 'and it says what it measured against');
});

test('the shipped 1920x1080 canvas reports no mismatch', () => {
  const win = stage(`<section ${SLIDE_BOX} data-label="01"><h1 data-r="40,40,800,90">One</h1></section>`);
  assert.equal(DeckAudit.run(win.document, win).canvasMismatch, undefined);
});

// The slide is the LAST light-DOM layer that can paint behind its own text.
// deck-stage.js paints `.canvas { background:#fff }` in SHADOW DOM and slots the
// sections inside it, so a <deck-stage> or <body> ground is BEHIND that white
// canvas and never reaches the slide. The reference deck sets
// `deck-stage{background:var(--dark)}` (why-worca.html:52) exactly this way — so
// walking past the section reported white-on-dark ~21:1 clean for a slide that
// renders white-on-white, and the STAGE_CANVAS fallback that exists to catch it
// was unreachable. This is the dangerous direction: the audit is the blocking
// gate, so a clean verdict ships the illegible slide.
test('a dark <deck-stage> ground is behind the shadow canvas and never backs a slide', () => {
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01">`
    + `<h1 data-r="40,40,800,90" style="color:rgb(255,255,255);font-size:72px">Invisible</h1>`
    + `</section>`,
  );
  win.document.body.style.backgroundColor = UNSTYLED_BODY;
  win.document.querySelector('deck-stage').style.backgroundColor = 'rgb(20,20,25)';
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.equal(checksOf(slide, 'contrast').length, 1,
    'white text is measured against the white canvas, not the host ground');
});

test('...and a slide that paints its own ground is unaffected by the host', () => {
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01" style="background-color:rgb(17,17,17)">`
    + `<h1 data-r="40,40,800,90" style="color:rgb(255,255,255);font-size:72px">Light on dark</h1>`
    + `</section>`,
  );
  win.document.body.style.backgroundColor = UNSTYLED_BODY;
  win.document.querySelector('deck-stage').style.backgroundColor = 'rgb(255,255,255)';
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.deepEqual(checksOf(slide, 'contrast'), [], 'the slide ground wins, as before');
});

// <br> computes to display:inline and has no child nodes, so the walk appended
// no separator on either side and the words either side fused into one token:
// `<h1>Ship the deck<br>in one afternoon</h1>` counted 5 where the slide reads 6.
// <br> in a headline is ubiquitous, so every one silently bought the builder an
// extra word against a cap the pipeline loops on.
test('a <br> separates words rather than fusing them', () => {
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01">`
    + `<h1 data-r="40,40,800,90" style="font-size:72px">Ship the deck<br>in one afternoon</h1>`
    + `</section>`,
  );
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.equal(slide.words, 6, '"deck" and "in" are two words, not "deckin"');
});

// The copy floor follows the COPY. A `<li><span>…</span></li>` wrapper IS the
// copy and must be measured — but applying the floor to EVERY descendant of a
// p/li/blockquote turned a designed 24px meta label, a footnote marker or a
// <code> run into a blocking `body` finding on markup the deck renders as
// intended. The audit is the loop-back gate, so that costs a real fix cycle.
test('a small inline inside body copy is not itself body copy', () => {
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01">`
    + `<li data-r="40,200,800,60" style="font-size:52px">`
    + `<span data-r="40,200,120,30" style="font-size:24px">3 min</span> Read the deck`
    + `</li></section>`,
  );
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.deepEqual(slide.issues.filter((i) => i.check === 'body'), [],
    'the 24px label is a design choice inside 52px copy, not undersized copy');
});

test('...but a wrapper that carries ALL the copy still has to meet the floor', () => {
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01">`
    + `<li data-r="40,200,800,60"><span data-r="40,200,800,60" style="font-size:32px">Read the deck in one sitting</span></li>`
    + `</section>`,
  );
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.equal(slide.issues.filter((i) => i.check === 'body').length, 1,
    '32px copy in a span wrapper is still 32px copy');
});

// fontsReady raced doc.fonts.ready against a setTimeout and never cleared it, so
// the timer stayed pending for the full ceiling after the fonts had already won.
// In a browser that is invisible; in Node — the bundler and these tests — it keeps
// the event loop alive 5 s past the end of the audit.
test('fontsReady clears its ceiling timer once the fonts win', async () => {
  const win = stage(`<section ${SLIDE_BOX} data-label="01"><h1 data-r="40,40,800,90">One</h1></section>`);
  const live = new Set();
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms) => { const t = realSet(fn, ms); live.add(t); return t; };
  globalThis.clearTimeout = (t) => { live.delete(t); return realClear(t); };
  try {
    win.document.fonts = { ready: Promise.resolve() };
    await DeckAudit.runAndPublish(win.document, win, { fontTimeoutMs: 30000 });
    assert.equal(live.size, 0, 'no 30s timer is left pending after the audit returns');
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
});

// A font API that REJECTS (a face that 404s) must not take the audit down with
// it: the report is the whole point of the run, and publishing it late is better
// than not at all.
test('a rejecting font promise still publishes a report', async () => {
  const win = stage(`<section ${SLIDE_BOX} data-label="01"><h1 data-r="40,40,800,90">One</h1></section>`);
  win.document.fonts = { ready: Promise.reject(new Error('face 404')) };
  const report = await DeckAudit.runAndPublish(win.document, win, { fontTimeoutMs: 20 });
  assert.equal(report.slides.length, 1, 'measured anyway');
  assert.ok(win.document.getElementById('deck-audit-report'), 'and published');
});

// The escape box is `slideRect.left/top + SLIDE.w/SLIDE.h` — it assumes the stage
// renders 1:1. Nothing verified that: `noscale` on proof.html is prose in
// CONTRACT.md, and a builder that omits it gets a scaled stage whose real box is
// smaller than the design box, so content hanging off the edge lands INSIDE the
// assumed box and the escape check reports clean. The audit is the blocking gate,
// so one missing attribute buys a false CLEAN on real overflow. canvasMismatch is
// the channel that already exists for "every number here is measured against the
// wrong box", and the agent is told to stop on it.
test('a scaled stage is reported as a canvas mismatch, not silently mismeasured', () => {
  const win = stage(
    `<section data-r="0,0,960,540" data-label="01">`
    + `<h1 data-r="40,40,800,90" style="font-size:72px">Half size</h1>`
    + `</section>`,
  );
  const report = DeckAudit.run(win.document, win);
  assert.ok(report.canvasMismatch, 'the report says the box is not the design box');
  assert.match(report.canvasMismatch, /960/, `names the rendered size: ${report.canvasMismatch}`);
});

test('a 1:1 stage reports no mismatch', () => {
  const win = stage(`<section ${SLIDE_BOX} data-label="01"><h1 data-r="40,40,800,90">One</h1></section>`);
  const report = DeckAudit.run(win.document, win);
  assert.equal(report.canvasMismatch, undefined, 'nothing to report at design size');
});

// `declared.w && declared.h` meant a stage declaring only ONE dimension fell
// through the guard entirely: <deck-stage width="1280"> (height defaulting to
// 1080) was measured against the 1920 box and reported `canvasMismatch: (none)` —
// exactly the silent mismeasurement the check exists to prevent. The absent
// attribute is not "unknown", it is deck-stage's own default.
test('a half-declared canvas is still a mismatch', () => {
  const win = stage(`<section data-r="0,0,1280,1080" data-label="01"><h1 data-r="40,40,800,90">One</h1></section>`);
  win.document.querySelector('deck-stage').setAttribute('width', '1280');
  win.document.querySelector('deck-stage').removeAttribute('height');
  const report = DeckAudit.run(win.document, win);
  assert.ok(report.canvasMismatch, 'a declared 1280 width is a mismatch even with no height');
  assert.match(report.canvasMismatch, /1280/, report.canvasMismatch || '(none)');
});

// `color: transparent` paints no glyphs from `color` — the canonical gradient
// headline (background:linear-gradient + background-clip:text) relies on exactly
// that, and the BACKGROUND paints the glyphs instead. parseColor returns {a:0},
// which is truthy, so over(fg,bg) collapsed to bg and contrastRatio(bg,bg)
// reported 1.00:1 — a blocking finding on a title that renders perfectly, from
// the gate the fix loop runs on.
test('a gradient-clipped headline is not a 1.00:1 contrast failure', () => {
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01" style="background-color:rgb(255,255,255)">`
    + `<h1 data-r="40,40,800,90" style="font-size:72px;color:transparent;`
    + `background-image:linear-gradient(90deg,rgb(255,0,0),rgb(0,0,255))">Gradient</h1>`
    + `</section>`,
  );
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.deepEqual(checksOf(slide, 'contrast'), [],
    'a ratio needs two colours; text painted by its own background has one');
});

// ...but transparent text with NOTHING painting it really is invisible.
test('transparent text with no background painting it is still reported', () => {
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01" style="background-color:rgb(255,255,255)">`
    + `<h1 data-r="40,40,800,90" style="font-size:72px;color:transparent">Invisible</h1>`
    + `</section>`,
  );
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.equal(checksOf(slide, 'contrast').length, 1, 'genuinely unpainted text is a finding');
});

// With no usable <deck-stage> — deck-stage.js 404'd from the run folder, or the
// builder emitted the wrong root — sections is [], `declared` is null so
// canvasMismatch never fires, and run() returns {slideCount: 0, slides: []}: a
// CLEAN report on a deck nothing measured. Every other silent-mismeasurement path
// in this file is deliberately reported; this was the one that wasn't, and it
// terminates the fix loop.
test('a page with no usable deck-stage reports that, instead of a clean empty run', () => {
  const dom = new JSDOM('<!doctype html><body><main><section>not a deck</section></main></body>',
    { url: 'http://localhost/proof.html' });
  const report = DeckAudit.run(dom.window.document, dom.window);
  assert.equal(report.slideCount, 0);
  assert.ok(report.stageError, 'the report says nothing was measurable');
  assert.match(report.stageError, /deck-stage/, report.stageError || '(none)');
});

test('a deck-stage holding no sections is reported too', () => {
  const win = stage('');
  const report = DeckAudit.run(win.document, win);
  assert.ok(report.stageError, 'an empty stage is not a clean deck');
});

// The caption band is the READ-ALONE layer: hidden on screen, printed with the
// slide. The print sheet pins every slide to exactly the design height with
// overflow:hidden (and `!important` from the shadow tree, so no author rule lifts
// it), so on a slide whose content already fills the page the band lays out past
// the bottom edge and is clipped out of the PDF — silently, because every other
// check deliberately excludes captions.
//
// Letting the slide GROW instead is not the answer: `break-after: page` then
// prints a second page, and the export gate makes page-count != slide-count a
// blocking major that loops back to a builder forbidden from editing kit files —
// an unfixable loop. So the kit measures the fit and SAYS so, which the builder
// can act on by shortening the slide or the caption.
test('a caption band that will not fit the printed page is reported', () => {
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01">`
    + `<h1 data-r="40,40,1600,900" style="font-size:72px">Full slide</h1>`
    + `<div data-deck-caption data-r="40,960,1600,260">The read-alone prose that will not fit.</div>`
    + `</section>`,
  );
  const [slide] = DeckAudit.run(win.document, win).slides;
  const found = slide.issues.filter((i) => i.check === 'caption');
  assert.equal(found.length, 1, `the clipped band is reported: ${JSON.stringify(slide.issues)}`);
  assert.match(found[0].detail, /caption/i, found[0].detail);
});

test('a caption band that fits is not reported', () => {
  const win = stage(
    `<section ${SLIDE_BOX} data-label="01">`
    + `<h1 data-r="40,40,1600,300" style="font-size:72px">Short slide</h1>`
    + `<div data-deck-caption data-r="40,400,1600,260">Plenty of room.</div>`
    + `</section>`,
  );
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.deepEqual(slide.issues.filter((i) => i.check === 'caption'), []);
});

test('a deck with no caption band is unaffected', () => {
  const win = stage(`<section ${SLIDE_BOX} data-label="01"><h1 data-r="40,40,800,90">One</h1></section>`);
  const [slide] = DeckAudit.run(win.document, win).slides;
  assert.deepEqual(slide.issues.filter((i) => i.check === 'caption'), []);
});

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
