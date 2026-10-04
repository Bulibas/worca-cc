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

test('the Commands list is gone: no rules for it, or for its toggle, remain', () => {
  assert.doesNotMatch(css, /\.term-(blocks?|cmds?|badge|out)\b/);
  assert.doesNotMatch(app, /[?&]terminal=|ensureBlock/);
});

test('the xterm host has no padding or border: the frame lives on .term-screen, outside what FitAddon measures', () => {
  assert.ok(css.includes('.term-host{flex:1;min-height:0;min-width:0;padding:0;border:0;}'));
  assert.match(css, /\.term-screen\{[^}]*display:flex;flex-direction:column;\}/);
});

test('phones: the Ask pill never covers the open terminal\'s input row', () => {
  const at = css.indexOf('@media (max-width:760px){ body.term-open .app{margin-right:0;}');
  const block = css.slice(at, css.indexOf('} }', at) + 3);
  assert.ok(at > 0 && block.includes('body.term-open .ask-dock>.ask-pill{display:none;}'), block);
});

test('every one of xterm\'s 16 ANSI colours has a token, and the dark tones of the base eight differ per theme', () => {
  for (const c of ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']) {
    assert.match(css, new RegExp(`--term-ansi-${c}:`), c);
    assert.match(css, new RegExp(`--term-ansi-bright-${c}:`), `bright ${c}`);
  }
  assert.ok(css.includes('--term-ansi-red:light-dark(var(--red-ink),var(--red));'));
  assert.doesNotMatch(css.slice(css.indexOf('.term-pane{'), css.indexOf('.term-pane[hidden]')), /#[0-9a-f]{3,8}\b/i, 'tokens only');
});

test('app.js: sendWs reports a dropped socket and the pane hears about it', () => {
  assert.ok(app.includes('if (!ws || !state.wsReady) return false;'));
  assert.ok(app.includes('if (terminalPane) terminalPane.onConnection(false);'));
});

test('the header has no toggle; the branch rows and the session picker are gone; the tab row hides', () => {
  assert.doesNotMatch(css, /\.term-wt\b/);
  assert.doesNotMatch(css, /\.term-sessions\b/);
  assert.ok(css.includes('.term-tabs[hidden]{display:none;}'));
});

test('the context is one line that fits a phone: the folder ellipsizes, an empty context takes no room', () => {
  assert.match(css, /\.term-folder\{[^}]*min-width:0;[^}]*text-overflow:ellipsis;white-space:nowrap;\}/);
  assert.ok(css.includes('.term-context:empty{display:none;}'));
  assert.doesNotMatch(css.slice(css.indexOf('.term-pane{'), css.indexOf('@media (max-width:760px){ body.term-open')), /#[0-9a-f]{3,8}\b/i, 'tokens only');
});
