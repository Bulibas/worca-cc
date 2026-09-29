// test/ask-panel-drop.test.mjs — drag-and-drop onto the sheet and file paste
// into the composer both feed the same addFiles() the "+" button uses. jsdom
// has no DataTransfer: a plain object carrying `types`/`files` is pinned onto
// the event with defineProperty, the way the composer suite injects input.files.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makePanel } from './helpers/ask-panel-harness.mjs';

const mkFile = (ctx, name, content, type = 'text/plain') => new ctx.window.File([content], name, { type });

function fire(ctx, target, type, data) {
  const ev = new ctx.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: data, configurable: true });
  target.dispatchEvent(ev);
  return ev;
}

function paste(ctx, target, data) {
  const ev = new ctx.window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', { value: data, configurable: true });
  target.dispatchEvent(ev);
  return ev;
}

const fileDrag = (files) => ({ types: ['Files'], files });
const sheetOf = (ctx) => ctx.doc.querySelector('[data-ask-sheet]');
const overlayOf = (ctx) => ctx.doc.querySelector('[data-ask-drop]');

test('ask-panel-drop: a file drop on the sheet attaches chips and cancels the browser default', async () => {
  const ctx = makePanel();
  ctx.panel.open();
  const sheet = sheetOf(ctx);
  const data = fileDrag([mkFile(ctx, 'a.md', 'one'), mkFile(ctx, 'b.txt', 'two')]);
  assert.equal(fire(ctx, sheet, 'dragenter', data).defaultPrevented, true);
  assert.equal(fire(ctx, sheet, 'dragover', data).defaultPrevented, true, 'dragover must be cancelled or drop never fires');
  // dropped on a child: the whole sheet is the target
  const drop = fire(ctx, ctx.doc.querySelector('.ask-transcript'), 'drop', data);
  assert.equal(drop.defaultPrevented, true, 'the browser must not open the file in the tab');
  await ctx.tick(); await ctx.tick();
  assert.deepEqual([...ctx.doc.querySelectorAll('.ask-chip-name')].map((n) => n.textContent), ['a.md', 'b.txt']);
});

test('ask-panel-drop: a dropped file runs through the same validation as the "+" button', async () => {
  const ctx = makePanel();
  ctx.panel.open();
  const data = fileDrag([mkFile(ctx, 'evil.exe', 'x')]);
  fire(ctx, sheetOf(ctx), 'dragenter', data);
  fire(ctx, sheetOf(ctx), 'drop', data);
  await ctx.tick(); await ctx.tick();
  assert.equal(ctx.doc.querySelector('.ask-chip'), null);
  assert.match(ctx.doc.querySelector('.ask-composer-msg').textContent, /attachment type not allowed: evil\.exe/);
});

test('ask-panel-drop: a non-file drag is ignored — no overlay, no preventDefault, no chips', async () => {
  const ctx = makePanel();
  ctx.panel.open();
  const sheet = sheetOf(ctx);
  const data = { types: ['text/plain'], files: [] };
  assert.equal(fire(ctx, sheet, 'dragenter', data).defaultPrevented, false);
  assert.equal(overlayOf(ctx).hidden, true, 'no overlay for a text/element drag');
  assert.equal(fire(ctx, sheet, 'dragover', data).defaultPrevented, false, 'list reordering keeps its own drop handling');
  assert.equal(fire(ctx, sheet, 'drop', data).defaultPrevented, false);
  await ctx.tick(); await ctx.tick();
  assert.equal(ctx.doc.querySelector('.ask-chip'), null);
});

test('ask-panel-drop: the overlay shows on a file dragenter, survives crossing children, hides on leave/drop/dragend', () => {
  const ctx = makePanel();
  ctx.panel.open();
  const sheet = sheetOf(ctx);
  const overlay = overlayOf(ctx);
  assert.ok(overlay, 'the sheet carries a drop overlay');
  assert.equal(overlay.hidden, true, 'hidden at rest');
  assert.match(overlay.textContent, /Drop files to attach/);
  const data = fileDrag([]);
  const child = ctx.doc.querySelector('.ask-transcript');
  fire(ctx, sheet, 'dragenter', data);
  assert.equal(overlay.hidden, false, 'shown while files hover the sheet');
  assert.ok(sheet.classList.contains('is-dropping'));
  // entering a child fires dragenter(child) before dragleave(sheet): no flicker
  fire(ctx, child, 'dragenter', data);
  fire(ctx, sheet, 'dragleave', data);
  assert.equal(overlay.hidden, false, 'crossing into a child keeps the overlay up');
  fire(ctx, child, 'dragleave', data);
  assert.equal(overlay.hidden, true, 'leaving the sheet entirely hides it');
  assert.ok(!sheet.classList.contains('is-dropping'));

  fire(ctx, sheet, 'dragenter', data);
  fire(ctx, sheet, 'drop', data);
  assert.equal(overlay.hidden, true, 'a drop hides it');

  fire(ctx, sheet, 'dragenter', data);
  fire(ctx, child, 'dragenter', data);
  fire(ctx, sheet, 'dragend', data);
  assert.equal(overlay.hidden, true, 'dragend resets it');
  fire(ctx, sheet, 'dragenter', data);
  assert.equal(overlay.hidden, false, 'the depth counter restarts clean after a reset');
  fire(ctx, sheet, 'dragleave', data);
  assert.equal(overlay.hidden, true);
});

test('ask-panel-drop: a paste with files attaches them and cancels the default', async () => {
  const ctx = makePanel();
  ctx.panel.open();
  const input = ctx.doc.querySelector('textarea.ask-input');
  const ev = paste(ctx, input, { types: ['Files'], files: [mkFile(ctx, 'notes.md', 'hello')], getData: () => '' });
  assert.equal(ev.defaultPrevented, true);
  await ctx.tick(); await ctx.tick();
  assert.match(ctx.doc.querySelector('.ask-chip').textContent, /notes\.md/);
  assert.equal(input.value, '', 'nothing is typed into the draft');
});

test('ask-panel-drop: repeated generic "image.png" pastes get unique names, so the dedupe does not replace them', async () => {
  const ctx = makePanel();
  ctx.panel.open();
  const input = ctx.doc.querySelector('textarea.ask-input');
  const png = () => mkFile(ctx, 'image.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png');
  paste(ctx, input, { types: ['Files'], files: [png()] });
  await ctx.tick(); await ctx.tick();
  paste(ctx, input, { types: ['Files'], files: [png()] });
  await ctx.tick(); await ctx.tick();
  const names = [...ctx.doc.querySelectorAll('.ask-chip-name')].map((n) => n.textContent);
  assert.equal(names.length, 2, 'both screenshots stay attached');
  assert.notEqual(names[0], names[1]);
  for (const n of names) assert.match(n, /^pasted-.+\.png$/);
});

test('ask-panel-drop: a plain-text paste is untouched', async () => {
  const ctx = makePanel();
  ctx.panel.open();
  const input = ctx.doc.querySelector('textarea.ask-input');
  const ev = paste(ctx, input, { types: ['text/plain'], files: [], getData: () => 'hello' });
  assert.equal(ev.defaultPrevented, false, 'the native text paste goes ahead');
  await ctx.tick(); await ctx.tick();
  assert.equal(ctx.doc.querySelector('.ask-chip'), null);
  assert.equal(ctx.doc.querySelector('.ask-composer-msg').hidden, true, 'no error either');
});
