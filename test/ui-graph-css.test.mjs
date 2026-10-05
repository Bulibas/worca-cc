// test/ui-graph-css.test.mjs — the CSS geometry contract: style.css may express
// canvas geometry ONLY through the --gv-* variables injectGeometry writes, so
// the box model can never drift from nodeSize/portAnchor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { injectGeometry, GEOMETRY_CSS_VARS } from '../src/shared/graph/geometry.mjs';

const css = readFileSync(fileURLToPath(new URL('../ui/public/style.css', import.meta.url)), 'utf8');

test('every --gv-* variable style.css uses is one injectGeometry writes, and vice versa', () => {
  const dom = new JSDOM('<!doctype html><body><div id="s"></div></body>');
  const el = dom.window.document.getElementById('s');
  injectGeometry(el);
  const written = new Set((el.getAttribute('style') || '').match(/--gv-[a-z0-9-]+/g) || []);
  const used = new Set(css.match(/--gv-[a-z0-9-]+/g) || []);
  assert.ok(written.size >= 10, `injectGeometry wrote ${written.size} vars`);
  assert.deepEqual([...used].sort(), [...written].sort(), 'style.css --gv-* set === injectGeometry set');
  assert.equal(Object.keys(GEOMETRY_CSS_VARS).length, written.size);
});
