import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const DeckAudit = require('../assets/deck-kit/deck-audit.js');

test('contrast: black on white is 21:1, white on white is 1:1', () => {
  const black = DeckAudit.parseColor('rgb(0, 0, 0)'), white = DeckAudit.parseColor('rgb(255, 255, 255)');
  assert.equal(Math.round(DeckAudit.contrastRatio(black, white)), 21);
  assert.equal(DeckAudit.contrastRatio(white, white), 1);
});
test('parseColor reads rgba alpha and returns null for non-rgb strings', () => {
  assert.deepEqual(DeckAudit.parseColor('rgba(10, 20, 30, 0.5)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.equal(DeckAudit.parseColor('transparent'), null);
});
test('words counts whitespace-separated tokens', () => {
  assert.equal(DeckAudit.words('  one two\nthree  '), 3);
});
