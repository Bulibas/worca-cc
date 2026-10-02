// The Actions UI is a new surface: its hints, muted badge and placeholders must use --ink-2, not the
// house --ink-3 grey (2.58–2.8:1 in light), so `npm run verify:theme` passes without new baseline keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../ui/public/style.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../ui/public/app.js', import.meta.url), 'utf8');
const view = readFileSync(new URL('../ui/public/actions-view.mjs', import.meta.url), 'utf8');

test('Actions hints use --ink-2 and the failure hint keeps its red', () => {
  const hint = css.indexOf('.act-card .hint,.act-hint{color:var(--ink-2)}');
  const fail = css.indexOf('.act-exit.fail{color:var(--red-ink)}');
  assert.ok(hint >= 0, 'missing the Actions hint colour rule');
  assert.ok(fail > hint, '.act-exit.fail must come after the hint rule so "Setup failed" stays red');
});

test('hints outside a card carry act-hint', () => {
  assert.match(app, /p\.className = 'hint act-hint';\s*p\.textContent = 'Actions are available once the run finishes\.'/);
  assert.match(view, /h\(doc, 'p', 'hint act-hint', r\.data\?\.error \|\| 'Could not load actions\.'\)/);
});

test('the muted act-state badge and the editor placeholders use --ink-2', () => {
  assert.ok(css.includes('.act-card .act-state.badge{background:var(--field);color:var(--ink-2)}'));
  assert.ok(css.includes('.actions-config .input::placeholder{color:var(--ink-2)}'));
});

// The config editors emit ac-* classes; without layout rules labels, hints and controls run together.
const rule = (sel) => {
  const i = css.indexOf(`${sel}{`);
  return i < 0 ? '' : css.slice(i + sel.length + 1, css.indexOf('}', i));
};

test('stacked Actions panels keep the 18px gap', () => {
  assert.match(rule('.actions-config,.act-view'), /gap:18px/);
});

test('the config editor lays out its fields, rows and built-in toggles', () => {
  assert.match(rule('.ac-field'), /display:flex;flex-direction:column/);
  assert.match(rule('.ac-field-label'), /font-weight:600/);
  assert.match(rule('.ac-action-head,.ac-stack-head'), /display:flex/);
  assert.match(rule('.ac-env-row,.ac-step-env-row'), /display:flex/);
  assert.match(rule('.ac-builtin'), /display:flex/);
  assert.match(rule('.ac-builtin-note'), /margin-left:auto/);
  assert.match(rule('.ac-foot'), /display:flex/);
});

test('editor hints and muted text use --ink-2 on the new surface', () => {
  assert.match(rule('.ac-field-hint,.ac-card-sub,.actions-config .muted,.ac-placeholders'), /color:var\(--ink-2\)/);
});
