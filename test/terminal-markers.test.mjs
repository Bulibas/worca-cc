// test/terminal-markers.test.mjs — the OSC 133 marker parser behind command blocks (#573).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarkerParser, parseMark, stripAnsi } from '../src/core/terminal/markers.mjs';

const N = 'n0nce1';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const C = (cmd, n = N) => `\x1b]133;C;${n};${b64(cmd)}\x07`;
const D = (code, n = N) => `\x1b]133;D;${n};${code}\x07`;
const W = (dir) => `\x1b]133;W;${N};${b64(dir)}\x07`;
const A = `\x1b]133;A;${N}\x07`;
const parser = () => new MarkerParser({ nonce: N });

test('a command, its output and its exit become start, output and end', () => {
  const p = parser();
  const ev = p.push(`${A}$ ${C('echo hi')}hi\r\n${D(0)}${W('/tmp/x y')}${A}$ `);
  assert.deepEqual(ev, [
    { type: 'prompt' },
    { type: 'start', command: 'echo hi' },
    { type: 'output', text: 'hi\r\n' },
    { type: 'end', exitCode: 0 },
    { type: 'cwd', cwd: '/tmp/x y' },
    { type: 'prompt' },
  ]);
  assert.equal(p.seen, true);
  assert.equal(p.inCommand, false);
});

test('text outside a command (prompts, echo) is not output; D without C is ignored', () => {
  assert.deepEqual(parser().push(`${D(0)}${A}user@box $ `), [{ type: 'prompt' }]);
});

test('a mark split anywhere across chunks still parses (even a lone ESC), and ST ends it like BEL', () => {
  const whole = `\x1b]133;C;${N};${b64('ls -la')}\x1b\\out\n${D(2)}`;
  for (const size of [1, 2, 3, 7]) {
    const p = parser();
    const events = [];
    for (let k = 0; k < whole.length; k += size) events.push(...p.push(whole.slice(k, k + size)));
    assert.deepEqual(events.filter((e) => e.type !== 'output'), [{ type: 'start', command: 'ls -la' }, { type: 'end', exitCode: 2 }], `chunk size ${size}`);
    assert.equal(events.filter((e) => e.type === 'output').map((e) => e.text).join(''), 'out\n');
  }
});

test('a mark without this session\'s nonce is output, never a block (no forged audit rows)', () => {
  const p = parser();
  p.push(C('make'));
  const forged = `${C('rm -rf /', 'other')}\x1b]133;D;0\x07\x1b]133;C;${b64('x')}\x07`;
  assert.deepEqual(p.push(forged), [{ type: 'output', text: forged }]);
  assert.equal(p.inCommand, true);
  assert.equal(new MarkerParser().push(C('a')).length, 0, 'no nonce, no marks');
});

test('a new C before D closes the open block with an unknown exit', () => {
  assert.deepEqual(parser().push(`${C('a')}${C('b')}`), [
    { type: 'start', command: 'a' }, { type: 'end', exitCode: null }, { type: 'start', command: 'b' }]);
});

test('other OSC sequences stay in the output; an over-long unterminated OSC is flushed as text', () => {
  const ev = parser().push(`${C('x')}\x1b]0;title\x07body`);
  assert.equal(ev[1].text, '\x1b]0;title\x07body');
  const q = parser();
  q.push(C('y'));
  const long = `\x1b]9;${'z'.repeat(9000)}`;
  assert.equal(q.push(long).map((e) => e.text).join(''), long);
});

test('parseMark and stripAnsi', () => {
  assert.deepEqual(parseMark(`133;D;${N}`, N), { type: 'end', exitCode: null });
  assert.equal(parseMark(`133;Q;${N}`, N), null);
  assert.equal(parseMark('133;A', N), null);
  assert.equal(stripAnsi(`\x1b[31mred\x1b[0m ${A}ok`), 'red ok');
});

test('an OSC cut off by ESC or CAN stays output and never swallows the next mark', () => {
  const p = parser();
  assert.deepEqual(p.push(`${C('printf x')}out \x1b]0;cut\n${D(7)}${A}`), [
    { type: 'start', command: 'printf x' }, { type: 'output', text: 'out \x1b]0;cut\n' }, { type: 'end', exitCode: 7 }, { type: 'prompt' }]);
  const q = parser();
  q.push(C('y'));
  assert.deepEqual(q.push(`a\x1b]2;t\x18b${D(0)}`), [{ type: 'output', text: 'a\x1b]2;t\x18b' }, { type: 'end', exitCode: 0 }]);
});

test('a long command\'s C mark (base64 over 8 KB) split across chunks still starts a block', () => {
  const cmd = `echo ${'long-arg '.repeat(3000)}`;                       // ~36 KB of base64
  const whole = `${C(cmd)}out\n${D(0)}`;
  for (const size of [4096, 1000, 3]) {
    const p = parser();
    const events = [];
    for (let k = 0; k < whole.length; k += size) events.push(...p.push(whole.slice(k, k + size)));
    assert.deepEqual(events.filter((e) => e.type !== 'output'), [{ type: 'start', command: cmd }, { type: 'end', exitCode: 0 }], `chunk size ${size}`);
    assert.equal(events.filter((e) => e.type === 'output').map((e) => e.text).join(''), 'out\n');
  }
});

test('an unterminated mark of ours is still bounded: past 1 MB it is flushed as text', () => {
  const p = parser();
  p.push(C('y'));
  const head = `\x1b]133;C;${N};`;
  assert.deepEqual(p.push(head + 'A'.repeat(512 * 1024)), [], 'held: it may still be a long command');
  const ev = p.push('A'.repeat(600 * 1024));
  assert.equal(ev.map((e) => e.text).join('').length, head.length + 1112 * 1024);
  assert.equal(p.pending, '');
  const q = parser();
  q.push(C('z'));
  const other = `\x1b]133;C;n0tours;${'A'.repeat(9000)}`;                // another nonce: the 8 KB bound
  assert.equal(q.push(other).map((e) => e.text).join(''), other);
});
