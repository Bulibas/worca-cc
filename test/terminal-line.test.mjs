// test/terminal-line.test.mjs — the pipes-mode line editor (#573, D10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLineEditor } from '../ui/public/terminal-line.mjs';

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
