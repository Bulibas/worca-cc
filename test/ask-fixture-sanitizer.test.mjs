// P1/T17: the fixture capture script (tools/ask-capture-fixtures.mjs). Its sanitiser's
// OUTPUT is checked where it lands: test/ask-events-fixtures.test.mjs asserts the
// committed fixtures carry no home path, real uuid or secret (ask-worca-design.md §12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLiveClaudeAllowed } from '../tools/ask-capture-fixtures.mjs';

// This script is the ONE thing in the repo that spawns the real claude CLI and
// spends money. It is not part of `npm test` and never runs in CI, but nothing
// stopped a stray `npm run ask:fixtures` either — so the capture is gated behind
// an explicit opt-in env var that no test, hook or CI job ever sets.
test('the live-claude capture refuses to run without an explicit opt-in', () => {
  assert.throws(() => assertLiveClaudeAllowed({}), /WORCA_ALLOW_LIVE_CLAUDE/);
  for (const v of ['', '0', 'false', 'true', 'yes']) {
    assert.throws(() => assertLiveClaudeAllowed({ WORCA_ALLOW_LIVE_CLAUDE: v }),
      /WORCA_ALLOW_LIVE_CLAUDE/, `"${v}" is not an opt-in`);
  }
  assert.doesNotThrow(() => assertLiveClaudeAllowed({ WORCA_ALLOW_LIVE_CLAUDE: '1' }));
});
