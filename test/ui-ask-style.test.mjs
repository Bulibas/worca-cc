// test/ui-ask-style.test.mjs — raw style.css assertions for the Ask Worca
// section (spec §10.3). Same technique as ui-running-routing's ruleBody: anchored selector match, body capture stops at
// the first closing brace — hence the "no comments in rule bodies" house rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const css = readFileSync(fileURLToPath(new URL('../ui/public/style.css', import.meta.url)), 'utf8');

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp('(?:^|[\\s,}])' + escaped + '\\s*\\{([^}]*)\\}'));
  return m ? m[1].replace(/\s+/g, ' ') : null;
}

test('ui-ask-style: hidden twins exist for the hideable ask elements', () => {
  for (const sel of ['.ask-sheet[hidden]', '.ask-pill[hidden]', '.ask-jump[hidden]', '.ask-composer-msg[hidden]', '.ask-chips[hidden]',
    '.ask-mcp-btn[hidden]']) {   // shares display:inline-flex from .ask-scope-btn, so without the twin it never hides (jsdom cannot catch it)
    const body = ruleBody(sel);
    assert.ok(body, `${sel} twin exists`);
    assert.match(body, /display:none/);
  }
});
