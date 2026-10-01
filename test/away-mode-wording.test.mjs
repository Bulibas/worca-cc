// test/away-mode-wording.test.mjs — spec §8 "Wording guard": Away mode UI text uses the glossary (wording §5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NIGHT_FIELDS, NIGHT_STRATEGIES } from '../src/core/night/config.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const BAD = [/\bnight\b/i, /\bgrace\b/i, /\beligible\b/i, /\bForce\b/, /\bstrategy\b/i, /\bdecisions?\b/i];
const EXEMPT = new Set([...NIGHT_FIELDS, ...NIGHT_STRATEGIES]);                 // stored keys and values
const scrub = (s) => s.replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\$\{[^}]*\}/g, '')                                                   // template expressions are code, not text
  .replace(/\[[\w-]+(?:="[^"]*")?\]/g, '')                                        // attribute selectors, e.g. [data-field="strategy"]
  .replace(/\s(?:class|id|name|for|data-[a-z-]+)="[^"]*"/g, '')                 // attribute values are identifiers
  .replace(/--night\b/g, '').replace(/\.?\bnight-[\w-]+/g, '');                 // the flag and night-* class tokens
const literals = (src) => (src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  .match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) || [])
  .map((s) => s.slice(1, -1))
  .filter((s) => !EXEMPT.has(s) && !/^[.#]?[a-z][\w.-]*$/.test(s));             // identifiers, selectors, event names
const slice = (html, from, to) => { const i = html.indexOf(from); assert.ok(i >= 0, `missing ${from}`); return html.slice(i, html.indexOf(to, i)); };
const check = (where, s) => { for (const bad of BAD) assert.doesNotMatch(scrub(s), bad, `${where}: ${s.slice(0, 120)}`); };

test('Away mode UI strings in index.html use the glossary words only', () => {
  const html = read('ui/public/index.html');
  check('settings card', slice(html, 'id="night-settings-card"', '</section>'));
  check('run bar', slice(html, 'rd-night-wrap', '</label>'));
  check('New-run toggle', slice(html, 'id="night-row"', '</label>'));
  check('decisions heading', slice(html, '<h3>Answers while you were away', '</h3>'));
});

test('Away mode strings in the form and the shared modules use the glossary words only', () => {
  for (const f of ['ui/public/night-mode-form.mjs', 'src/shared/away-mode/labels.mjs', 'src/shared/away-mode/describe.mjs']) {
    const ls = literals(read(f));
    assert.ok(ls.length > 10, `${f}: scanned`);
    for (const s of ls) check(f, s);
  }
});

test('Away mode strings on the app.js surfaces use the glossary words only', () => {
  // The project card, decisions list, pill, New-run hint and the guardrail pause copy live in app.js (Tasks 6–8).
  const app = read('ui/public/app.js');
  const fn = (name) => slice(app, `function ${name}(`, '\n}\n');
  for (const name of ['buildPdNightCard', 'paintNightDecisions', 'paintRdAwayPill', 'paintNewRunAwayHint', 'paintAwayStatus', 'paintNightFallback']) {
    for (const s of literals(fn(name))) check(`app.js ${name}`, s);
  }
  for (const line of app.split('\n').filter((l) => l.includes("pauseReason === 'night_guardrail'"))) for (const s of literals(line)) check('app.js guardrail pause', s);
});

test('the scanner itself catches the old wording', () => {
  const hits = literals("a('Grace (minutes)'); b.dataset.field = 'strategy'; el(doc, 'select', 'select night-strategy'); c('Night mode'); d(`${FIELD_LABELS.strategy.label}`); q('[data-field=\"strategy\"]');")
    .filter((s) => BAD.some((b) => b.test(scrub(s))));
  assert.deepEqual(hits, ['Grace (minutes)', 'Night mode']);
});

test('the Away mode info tip promises only what the code does', () => {
  const html = read('ui/public/index.html');
  const at = html.indexOf('aria-label="About Away mode"');
  const tip = html.slice(at, html.indexOf('</span>', at)).replace(/\s+/g, ' ');
  assert.match(tip, /While you're away, worca answers the questions your runs are waiting on\. You can see every answer and why it was chosen\. When worca wasn't sure, it marks the answer "please check"\./);
  // Rule-based answers (accepting a workflow, retrying a step) are not marked: never claim all of them are reviewed.
  assert.doesNotMatch(tip, /flagged|every answer is (checked|reviewed)/i);
});
