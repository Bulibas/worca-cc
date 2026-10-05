// test/ui-composer-shell.test.mjs — the composer view's markup contract (D3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = readFileSync(fileURLToPath(new URL('../ui/public/index.html', import.meta.url)), 'utf8');

test('every id the editor binds exists exactly once', () => {
  for (const id of ['gv-head', 'gv-name', 'gv-new', 'gv-autolayout', 'gv-save', 'gv-errors',
    'gv-canvas', 'gv-chip', 'gv-ins-rail', 'gv-ins-body', 'gv-ins-toggle', 'gv-ins-tabs', 'gv-agents-pane',
    'gv-agent-filter', 'gv-palette', 'gv-legend', 'gv-saved-list', 'gv-saved-count', 'gv-archived',
    'gv-dialog-host', 'gv-nav', 'gv-zoom-in', 'gv-zoom-out', 'gv-center']) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, `#${id} appears exactly once`);
  }
});
