// test/terminal-line.test.mjs — the pipes-mode line editor (#573, D10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLineEditor, cellWidth } from '../ui/public/terminal-line.mjs';

test('echoes, edits and sends a line on Enter', () => {
  const ed = createLineEditor();
  assert.deepEqual(ed.feed('lsx'), { echo: 'lsx', send: '', interrupt: false });
  assert.deepEqual(ed.feed('\x7f'), { echo: '\b \b', send: '', interrupt: false });
  assert.deepEqual(ed.feed(' -la\r'), { echo: ' -la\r\n', send: 'ls -la\n', interrupt: false });
  assert.equal(ed.pending, '');
});

test('Ctrl+C asks for Stop and drops the line; Ctrl+U clears it; arrow keys are ignored', () => {
  const ed = createLineEditor();
  ed.feed('abc');
  assert.deepEqual(ed.feed('\x15'), { echo: '\b \b\b \b\b \b', send: '', interrupt: false });
  ed.feed('x\x1b[Ay');
  assert.equal(ed.pending, 'xy');
  assert.deepEqual(ed.feed('\x03'), { echo: '^C\r\n', send: '', interrupt: true });
  assert.equal(ed.pending, '');
});

test('a pasted multi-line text sends every line once, CRLF or not; Backspace removes a whole emoji', () => {
  const ed = createLineEditor();
  assert.equal(ed.feed('a\rb\r').send, 'a\nb\n');
  assert.equal(ed.feed('c\r\nd\r\n').send, 'c\nd\n');
  assert.equal(ed.feed('e\r').send + ed.feed('\nf\n').send, 'e\nf\n', 'a CRLF split across two feeds');
  ed.feed('x😀');
  ed.feed('\x7f');
  assert.equal(ed.pending, 'x');
});

test('Tab stays in the line; Ctrl+D sends EOF only on an empty line', () => {
  const ed = createLineEditor();
  assert.deepEqual(ed.feed('a\tb'), { echo: 'a b', send: '', interrupt: false });
  assert.equal(ed.feed('\x7f\x7f').echo, '\b \b\b \b', 'the Tab drew one cell, so it erases one');
  assert.equal(ed.pending, 'a');
  ed.feed('\tc');
  assert.equal(ed.feed('\r').send, 'a\tc\n');
  assert.deepEqual(ed.feed('x\x04'), { echo: 'x', send: '', interrupt: false }, 'mid-line Ctrl+D is ignored');
  ed.feed('\x15');
  assert.deepEqual(ed.feed('\x04'), { echo: '', send: '\x04', interrupt: false });
});

test('Backspace erases a whole cluster, as many cells as the terminal drew', () => {
  assert.equal(cellWidth('中'), 2);
  assert.equal(cellWidth('a'), 1);
  assert.equal(cellWidth('e\u0301'), 1, 'a combining accent takes no cell');
  const ed = createLineEditor();
  ed.feed('a中');
  assert.equal(ed.feed('\x7f').echo, '\b \b\b \b');
  assert.equal(ed.pending, 'a');
  ed.feed('e\u0301');
  assert.equal(ed.feed('\x7f').echo, '\b \b');
  assert.equal(ed.pending, 'a', 'the accent goes with its letter');
  ed.feed('👨\u200d👩');
  ed.feed('\x7f');
  assert.equal(ed.pending, 'a', 'a ZWJ sequence is one cluster');
  ed.feed('日本');
  assert.equal(ed.feed('\x15').echo, '\b \b'.repeat(5));
});

test('clear() drops a half-typed line and returns its erase', () => {
  const ed = createLineEditor();
  ed.feed('ls 中');
  assert.equal(ed.clear(), '\b \b'.repeat(5));
  assert.equal(ed.pending, '');
  assert.equal(ed.feed('\nx\r\n\n').send, '\nx\n\n', 'CRLF as one cluster, then a separate blank line');
});
