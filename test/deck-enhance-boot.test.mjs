// deck-enhance.js boots its own notion of the active slide.
//
// `initAll()` hardcoded `activate(0)` and `currentIdx = 0`, and the `message`
// listener that syncs with deck-stage is registered AFTER that — by which point
// deck-stage (which the contract loads FIRST) has already broadcast its initial
// slideIndexChanged. Reload on `deck.html#7` — the hash deck-stage itself stamps
// on every nav — and the stage shows slide 7 while deck-enhance believes slide 1
// is active: `.is-active` lands on the wrong section, and ArrowRight
// stopImmediatePropagation()s to reveal [data-step] elements on an invisible
// slide, so the deck looks frozen for maxStep keypresses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const SRC = readFileSync(fileURLToPath(new URL('../assets/deck-kit/deck-enhance.js', import.meta.url)), 'utf8');

/** A mounted stage: seven slides, with deck-stage's own active marker on one. */
function boot({ hash = '', activeIndex = null, steps = 0 } = {}) {
  const sections = Array.from({ length: 7 }, (_, i) => {
    const active = i === activeIndex ? ' data-deck-active=""' : '';
    const reveals = i === 0 && steps
      ? Array.from({ length: steps }, (_, n) => `<p data-step="${n + 1}">r${n + 1}</p>`).join('')
      : '';
    return `<section data-label="0${i + 1}"${active}><h1>S${i + 1}</h1>${reveals}</section>`;
  }).join('');
  const dom = new JSDOM(
    `<!doctype html><body><deck-stage width="1920" height="1080">${sections}</deck-stage></body>`,
    { url: `http://localhost/deck.html${hash}`, runScripts: 'outside-only' },
  );
  dom.window.eval(SRC);
  return dom.window;
}

/** deck-enhance defers its boot (DOMContentLoaded, then a 50ms poll), so wait
 *  for it to actually wire up before asserting. */
async function booted(opts) {
  const win = boot(opts);
  for (let i = 0; i < 40 && !win.__deckEnhanceRan; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(win.__deckEnhanceRan, true, 'deck-enhance never booted in the harness');
  return win;
}

const activeLabels = (win) => [...win.document.querySelectorAll('section.is-active')]
  .map((s) => s.getAttribute('data-label'));

test('boot follows deck-stage\'s own active marker, not slide 1', async () => {
  const win = await booted({ hash: '#7', activeIndex: 6 });
  assert.deepEqual(activeLabels(win), ['07'], 'the stage is on slide 7, so deck-enhance must be too');
});

test('with no marker yet, boot follows the URL hash deck-stage restores from', async () => {
  const win = await booted({ hash: '#4' });
  assert.deepEqual(activeLabels(win), ['04']);
});

test('a bare load with no hash and no marker still starts on slide 1', async () => {
  const win = await booted();
  assert.deepEqual(activeLabels(win), ['01']);
});

test('an out-of-range hash falls back to slide 1 rather than nothing', async () => {
  const win = await booted({ hash: '#99' });
  assert.deepEqual(activeLabels(win), ['01']);
});

test('the step cursor starts on the slide actually showing, not on slide 1', async () => {
  // Slide 1 carries the reveals; the stage is on slide 7. An ArrowRight must
  // advance the SLIDE, not silently reveal steps on the hidden first one.
  const win = await booted({ hash: '#7', activeIndex: 6, steps: 3 });
  const ev = new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
  win.dispatchEvent(ev);
  const revealed = win.document.querySelectorAll('section[data-label="01"] .step-visible').length;
  assert.equal(revealed, 0, 'no step was revealed on the slide nobody can see');
});

// deck-stage re-broadcasts slideIndexChanged with the UNCHANGED index after a
// rail mutation (_toggleSkip, and _deleteSlide/_moveSlide via
// _applyIndex({broadcast:true})), so the popup's thumbnails re-pick. This handler
// treated every message as a slide change and unconditionally zeroed the visible
// slide's [data-step] reveals — so right-clicking a thumbnail and choosing Skip on
// some OTHER slide silently rewound the slide you were presenting.
//
// A reset is the deliberate exception: deck-stage re-applies with force so the
// reveals DO zero, and it says so by marking the message.
test('a re-broadcast of the same slide index does not rewind its reveals', async () => {
  const win = await booted({ activeIndex: 0, steps: 3 });
  const slide = win.document.querySelectorAll('section')[0];

  win.postMessage({ slideIndexChanged: 0, deckTotal: 7 }, '*');
  await new Promise((r) => setTimeout(r, 10));
  // Reveal two steps, then let an unrelated rail mutation re-broadcast slide 0.
  win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  const revealed = slide.querySelectorAll('[data-step].step-visible').length;
  assert.ok(revealed > 0, `steps revealed to begin with: ${revealed}`);

  win.postMessage({ slideIndexChanged: 0, deckTotal: 7 }, '*');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(slide.querySelectorAll('[data-step].step-visible').length, revealed,
    'an unrelated rail mutation leaves the reveals where they were');
});
