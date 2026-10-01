// test/ui-running-pause-fixes.test.mjs — regressions around a PAUSED run's controls.
// The run card's Pause/Resume cluster and its branch chip went with the card (D14):
// Pause/Resume and Stop live in the run page's bar (`#run-detail .rd-pause` /
// `.rd-stop`), and the branch shows in the page header and Details. What is left
// here is CSS-as-text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = join(here, '../ui/public/style.css');

// (f) An author display rule defeats the UA [hidden] rule — it must be patched per
// class. The run page's Pause/Resume and Stop are display:flex and hide on a
// finished run (paintRdHeader), so each re-states [hidden].
test('(f) [hidden] hides the run page’s Pause/Resume and Stop despite their author display rules', () => {
  const css = readFileSync(cssPath, 'utf8');
  for (const cls of ['rd-pause', 'rd-stop']) {
    assert.match(css, new RegExp(`\\.${cls}\\{[^}]*display:\\s*flex`), `.${cls} is a flex row`);
    assert.match(css, new RegExp(`\\.${cls}\\[hidden\\]\\s*\\{[^}]*display:\\s*none`),
      `need .${cls}[hidden]{display:none;} — otherwise a finished run still shows it`);
  }
});

// (g) Dead rule: pause sat between resume and stop in the DOM, so this `+`
// selector could never match; its presence signals the broken margin scheme.
test('(g) dead adjacency rule .btn-resume.sm + .btn-stop.sm is gone', () => {
  const css = readFileSync(cssPath, 'utf8');
  assert.doesNotMatch(css, /\.btn-resume\.sm\s*\+\s*\.btn-stop\.sm/);
});
