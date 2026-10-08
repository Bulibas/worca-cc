// test/ui-ask-style.test.mjs — raw style.css assertions for the Ask Worca
// section (spec §10.3). Same technique as ui-running-routing's ruleBody: anchored selector match, body capture stops at
// the first closing brace — hence the "no comments in rule bodies" house rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('../ui/public/style.css', import.meta.url)), 'utf8');

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp('(?:^|[\\s,}])' + escaped + '\\s*\\{([^}]*)\\}'));
  return m ? m[1].replace(/\s+/g, ' ') : null;
}

test('ui-ask-style: hidden twins exist for the hideable ask elements', () => {
  for (const sel of ['.ask-sheet[hidden]', '.ask-pill[hidden]', '.ask-jump[hidden]', '.ask-composer-msg[hidden]', '.ask-chips[hidden]',
    '.ask-mcp-btn[hidden]', '.ask-agent-btn[hidden]']) {   // shares display:inline-flex from .ask-scope-btn, so without the twin it never hides (jsdom cannot catch it)
    const body = ruleBody(sel);
    assert.ok(body, `${sel} twin exists`);
    assert.match(body, /display:none/);
  }
});

test('ui-ask-style: the launcher is a 48px round button in the dock corner, out of the flex flow', () => {
  const body = ruleBody('.ask-pill');
  assert.ok(body, '.ask-pill rule exists');
  assert.match(body, /position:absolute/);
  assert.match(body, /width:48px/);
  assert.match(body, /height:48px/);
  assert.match(body, /border-radius:50%/);
  assert.match(body, /right:24px/);
  assert.match(body, /bottom:calc\(24px \+ env\(safe-area-inset-bottom,0px\)\)/);
  assert.match(ruleBody('.ask-pill-mark'), /width:26px/);
  assert.match(ruleBody('.ask-pill-label'), /clip|1px/, 'the label is visually hidden, not removed');
});

test('ui-ask-style: hover lifts, press shrinks, the tooltip is hover-gated', () => {
  assert.match(ruleBody('.ask-pill:hover'), /translateY\(-2px\) scale\(1\.04\)/);
  assert.match(ruleBody('.ask-pill:active'), /scale\(\.94\)/);
  assert.match(css, /@media \(hover: ?none\)\s*\{[^}]*\.ask-tip\{display:none/);
  assert.match(ruleBody('.ask-tip'), /pointer-events:none/);
  assert.match(ruleBody('.ask-tip.is-shown'), /opacity:1/);
});

test('ui-ask-style: thinking ring — conic violet, 1.6s spin, static under reduced motion; no label shimmer left', () => {
  assert.doesNotMatch(css, /\.ask-pill\.is-live \.ask-pill-label/, 'the label shimmer rules are gone');
  const ring = ruleBody('.ask-pill::before');
  assert.ok(ring, 'the ring is a pseudo-element');
  assert.match(ring, /conic-gradient\([^)]*var\(--violet\)/);
  assert.match(css, /\.ask-pill\.is-live::before\{[^}]*animation:ask-ring 1\.6s linear infinite/);
  assert.match(css, /prefers-reduced-motion: reduce\)\{[^@]*\.ask-pill\.is-live::before\{animation:none;/, 'pseudo-elements do not inherit the dock blanket, so the ring is named');
  assert.match(css, /prefers-reduced-motion: reduce\)\{[^@]*\.ask-pill\.is-live::before\{animation:none;[^}]*background:var\(--violet\)/, 'a static solid ring');
});

test('ui-ask-style: pop-in on reappear and the unread dot are covered by reduced motion', () => {
  assert.match(css, /@keyframes ask-pill-pop\{from\{opacity:0;transform:scale\(\.6\)\}/);
  assert.match(ruleBody('.ask-pill'), /animation:ask-pill-pop \.22s cubic-bezier\(\.34,1\.56,\.64,1\)/);
  const dot = ruleBody('.ask-pill.has-unread::after');
  assert.match(dot, /width:10px/);
  assert.match(dot, /var\(--violet\)/);
  assert.match(dot, /0 0 0 2px var\(--panel\)/);
  assert.match(dot, /animation:ask-dot-in/);
  // The dock blanket (.ask-dock *{animation:none !important}) reaches the button; the dot and the ring are
  // pseudo-elements, which do not inherit it, so they are named in the reduced-motion block.
  assert.match(css, /\.ask-dock \*\{animation:none !important;\}/);
  assert.match(css, /prefers-reduced-motion: reduce\)\{[^@]*\.ask-pill\.has-unread::after\{animation:none;/);
});

test('ui-ask-style: phone offsets are 16px; the terminal rule still hides the button', () => {
  assert.match(css, /@media \(max-width:760px\)\{\s*\.ask-pill\{right:16px;bottom:calc\(16px \+ env\(safe-area-inset-bottom,0px\)\);\}/);
  assert.ok(css.includes('body.term-open .ask-dock>.ask-pill{display:none;}'));
});

test('ui-ask-style: toasts stay above the corner button', () => {
  const clearance = Number(css.match(/--ask-dock-clearance:(\d+)px/)[1]);
  assert.match(ruleBody('.toasts'), /bottom:calc\(var\(--ask-dock-clearance\) \+ env\(safe-area-inset-bottom,0px\)\)/);
  assert.ok(clearance >= 24 + 48, `toasts' bottom edge (${clearance}px) clears the button's top edge (72px)`);
});
