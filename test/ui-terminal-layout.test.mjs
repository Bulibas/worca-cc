// test/ui-terminal-layout.test.mjs — the pane coexists with the Ask dock and toasts; no colour literals (#573).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../ui/public/style.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../ui/public/app.js', import.meta.url), 'utf8');

test('opening the pane moves the Ask dock and toasts left of it, and the page content with them', () => {
  assert.ok(css.includes('body.term-open .app{margin-right:var(--term-w,460px);}'));
  assert.ok(css.includes('body.term-open .ask-dock{right:var(--term-w,460px);}'));
  assert.ok(css.includes('body.term-open .toasts{right:calc(var(--term-w,460px) + 20px);}'));
  assert.match(css, /\.term-pane\{position:fixed;top:0;right:0;bottom:0;width:var\(--term-w,460px\);z-index:39;/);
});

test('phones: the pane overlays full width and nothing shifts', () => {
  assert.match(css, /@media \(max-width:760px\)\{[^}]*body\.term-open \.app\{margin-right:0;\}/);
});

test('app.js mounts the pane and routes term-* frames to it', () => {
  assert.ok(app.includes("import { createTerminalPane } from './terminal-pane.mjs';"));
  assert.ok(app.includes("if (typeof msg.type === 'string' && msg.type.startsWith('term-')) {"));
  assert.ok(app.includes('if (terminalPane) terminalPane.onContextChange();'));
});

test('Escape typed in the terminal is the shell\'s: the wizard and the three detail screens ignore it (D16)', () => {
  assert.equal(app.match(/if \(e\.target\?\.closest\?\.\('\.term-pane'\)\) return;/g)?.length, 4);
});

test('the Commands list actually hides: an author display rule needs its own [hidden] override', () => {
  assert.ok(css.includes('.term-blocks[hidden]{display:none;}'));
});
