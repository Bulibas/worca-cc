// test/abort-classify.test.mjs
// isAbort must classify by the AbortError NAME every abort/stop site sets —
// never by sniffing the message, or a genuine CLI failure that merely MENTIONS
// "aborted"/"stopped" is silently treated as a user stop (no terminal error
// line, no recovery, wrong decomposed abort-on-first-failure detection).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAbort } from '../src/core/run-harness.mjs';
import { checkRows } from './helpers/rows.mjs';

test('isAbort classifies by AbortError name, never by message; null/undefined are not aborts', async () => {
  await checkRows([
    { name: 'an AbortError-named error is an abort', run: () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      assert.equal(isAbort(e), true);
    } },
    { name: 'a real failure that merely mentions "aborted"/"stopped" is NOT an abort', run: () => {
      assert.equal(isAbort(new Error('claude exited with code 1: FetchError: the operation was aborted')), false);
      assert.equal(isAbort(new Error('MCP server stopped unexpectedly')), false);
    } },
    { name: 'null/undefined are not aborts', run: () => {
      assert.equal(isAbort(null), false);
      assert.equal(isAbort(undefined), false);
    } },
  ]);
});
