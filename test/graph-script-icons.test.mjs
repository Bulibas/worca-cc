// test/graph-script-icons.test.mjs — the fixed icon set a script picks from (script-wizard plan S9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCRIPT_ICONS, SCRIPT_GLYPH, iconNameOf, iconSvgOf } from '../src/shared/graph/script-icons.mjs';
import { sanitizeIcon } from '../src/shared/graph/manifest.mjs';

test('every fragment passes sanitizeIcon UNCHANGED and carries no colour of its own', () => {
  for (const { name, svg } of SCRIPT_ICONS) {
    assert.equal(sanitizeIcon(svg), svg, name);
    assert.ok(!/\b(fill|stroke)=/.test(svg), `${name}: colour comes from the tile`);
    assert.ok(svg.length < 600, name);
  }
  assert.equal(sanitizeIcon(SCRIPT_GLYPH), SCRIPT_GLYPH);
});

test('iconNameOf / iconSvgOf round-trip, and answer "" for anything outside the set', () => {
  for (const { name, svg } of SCRIPT_ICONS) {
    assert.equal(iconNameOf(svg), name);
    assert.equal(iconSvgOf(name), svg);
  }
  assert.equal(iconNameOf('<path d="M0 0"/>'), '');
  assert.equal(iconNameOf(''), '');
  assert.equal(iconSvgOf('nope'), '');
  assert.equal(iconNameOf(`  ${SCRIPT_ICONS[0].svg}\n`), 'terminal', 'whitespace around a saved fragment is not a different icon');
});
