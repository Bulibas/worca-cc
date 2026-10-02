// #555: results go through ui/public/feedback.mjs (notify / withButton / fieldError / cardAlert).
// This ratchet blocks NEW ad-hoc `.hint` / `.form-msg` status writers; the ceilings only go down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PUB = join(ROOT, 'ui/public');
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === 'vendor' ? [] : walk(p)) : /\.(m?js)$/.test(n) ? [p] : []; });
// Line-based on purpose: a block-comment regex treats a "/*" inside a string ('**/secrets/**',
// 'text/*') as a comment opener and blanks hundreds of live lines (app.js:22070 → 471 lines).
const strip = (s) => s.split('\n').map((l) => (/^\s*(\/\/|\/\*|\*)/.test(l) ? '' : l.replace(/\s\/\/\s.*$/, ''))).join('\n');

// What an ad-hoc status writer looks like.
const WRITERS = [
  /className\s*=\s*[`'"][^`'"]*\b(?:form-msg|hint)\b[^`'"]*(?:\b(?:ok|err|warn)\b|\$\{)/g,   // msg.className = 'hint err' / `form-msg${…}`
  /classList\.(?:add|toggle)\(\s*['"](?:ok|err|warn)['"]/g,                                   // line.classList.add('err')
  /\bh\(\s*doc\s*,\s*['"][a-z]+['"]\s*,\s*['"][^'"]*\b(?:hint|form-msg)\b[^'"]*\b(?:ok|err|warn)\b/g, // h(doc,'p','hint err')
  /\bfunction\s+set\w*Msg\s*\(/g,                                                             // a new set*Msg setter
];

// Measured after the #555 migration. Lower a number when you remove a writer; never raise one.
const CEILING = {
  'ui/public/app.js': 52,
  'ui/public/ask-panel.mjs': 1,
  'ui/public/branch-sync.mjs': 1,
  'ui/public/bridge-view.mjs': 2,
  'ui/public/chat-settings-view.mjs': 2,
  'ui/public/credentials-view.mjs': 1,
  'ui/public/guardrails-view.mjs': 1,
  'ui/public/mcp-definition-form.mjs': 1,
  'ui/public/mcp-view.mjs': 7,
  'ui/public/models-view.mjs': 1,
  'ui/public/plugins-view.mjs': 5,
  'ui/public/schedules-view.mjs': 1,
  'ui/public/source-pane.mjs': 1,
  'ui/public/stats-view.mjs': 3,
  'ui/public/team-metrics-surfaces.mjs': 3,
  'ui/public/team-metrics-view.mjs': 1,
  'ui/public/team-policy-view.mjs': 3,
  'ui/public/ui-level.mjs': 1,
  'ui/public/workspace-map-view.mjs': 2,
};

const counts = () => Object.fromEntries(walk(PUB)
  .filter((f) => !f.endsWith('/feedback.mjs'))
  .map((f) => [relative(ROOT, f), WRITERS.reduce((n, re) => n + (strip(readFileSync(f, 'utf8')).match(re) || []).length, 0)])
  .filter(([, n]) => n > 0));

test('#555: no new ad-hoc .hint / .form-msg status writers (use feedback.mjs)', () => {
  const over = Object.entries(counts())
    .filter(([f, n]) => n > (CEILING[f] ?? 0))
    .map(([f, n]) => `${f}: ${n} status writers (ceiling ${CEILING[f] ?? 0}) — report results with notify/withButton/fieldError/cardAlert from ui/public/feedback.mjs`);
  assert.deepEqual(over, []);
});

test('#555: the ceilings are tight (lower them when writers go away)', () => {
  const now = counts();
  const loose = Object.entries(CEILING).filter(([f, c]) => (now[f] ?? 0) < c).map(([f, c]) => `${f}: ceiling ${c}, now ${now[f] ?? 0}`);
  assert.deepEqual(loose, []);
});
