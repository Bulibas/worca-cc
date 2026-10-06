// test/helpers/rows.mjs — table tests that fail per row without t.test() subtests
// (subtests count as tests; the suite-reduction merges must not). Every row runs;
// one AssertionError at the end names every failing row by its original test title,
// each followed by that row's own error message. The message is built here, so it
// never depends on how node renders a deepEqual diff.
import assert from 'node:assert/strict';

export async function checkRows(rows) {
  assert.ok(Array.isArray(rows) && rows.length > 0, 'checkRows needs a non-empty array of rows');
  const failures = [];
  for (const { name, run } of rows) {
    try { await run(); } catch (e) { failures.push({ name, message: String(e?.message ?? e) }); }
  }
  if (failures.length === 0) return;
  const listed = failures.map(({ name, message }) => `- ${name}: ${message.replace(/\n(?=.)/g, '\n    ')}`);
  throw new assert.AssertionError({
    message: `${failures.length} of ${rows.length} rows failed:\n${listed.join('\n')}`,
    actual: failures.map((f) => f.name),
    expected: [],
    operator: 'checkRows',
  });
}
