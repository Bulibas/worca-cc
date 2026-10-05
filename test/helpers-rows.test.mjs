import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRows } from './helpers/rows.mjs';

test('checkRows runs every row and names every failing one', async () => {
  let ran = 0;
  await assert.rejects(checkRows([
    { name: 'first', run: () => { ran++; assert.equal(1, 2); } },
    { name: 'second', run: () => { ran++; } },
    { name: 'third', run: async () => { ran++; throw new Error('boom'); } },
  ]), (e) => e instanceof assert.AssertionError
    && /^2 of 3 rows failed:/.test(e.message)
    && /^- first: Expected values to be strictly equal:\n[\s\S]*1 !== 2/m.test(e.message)
    && /^- third: boom$/m.test(e.message)
    && !/second/.test(e.message));
  assert.equal(ran, 3, 'a failing row never stops the next');
});

test('checkRows resolves when every row passes, and refuses an empty table', async () => {
  await checkRows([{ name: 'a', run: () => {} }, { name: 'b', run: async () => {} }]);
  await assert.rejects(checkRows([]), /non-empty/);
});
