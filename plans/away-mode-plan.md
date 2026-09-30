# Away mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the confusing "night mode" configuration into "Away mode": one mental model, plain wording on every surface from one shared summary generator, the two behaviour changes of the spec, and Ask Worca tools to read and change it.

**Architecture:** Activation math moves to `src/shared/away-mode/` (served to the browser and imported by the server), next to a new pure summary generator and a labels module. Every surface (Settings card, project card, run switch, New-run toggle, decisions list, CLI, Ask Worca) renders text from those two modules. Stored keys, layering and endpoints stay; a read endpoint `GET /api/away-mode` and three Ask tools plus one card are added.

**Tech Stack:** Node ESM, `node:test`, jsdom UI tests, Express (`ui/server.mjs`), vanilla DOM (`ui/public/*.mjs`), SQLite via `node:sqlite`.

**Spec:** `plans/away-mode-design.md` (behaviour, architecture, tests). Copy: `plans/away-mode-wording.md` §3 and §5 (exact strings; the spec wins where they differ, e.g. tool names).

## Global Constraints

- Feature name in anything the developer reads: **Away mode**. Never "night", "grace", "eligible", "Force", "strategy", "decided/decisions" in Away mode UI strings (glossary: `plans/away-mode-wording.md` §5). Exceptions: the `--night` flag name itself, stored keys, code identifiers, DB table names.
- No migration: stored keys `nightMode`, `nightModeToggle`, `project_config.extra.nightMode`, `night.*` policy keys, `night_decisions` stay byte-compatible.
- Layering per field stays project > user > team, empty = inherit (`src/core/night/config.mjs`).
- `src/shared/**` modules must import nothing from `src/core/**` or `ui/**` (they are served to the browser at `/src/shared`).
- Tool names: `get_away_mode`, `set_away_now`, `set_run_away_mode`, `propose_away_mode_change`.
- Test command for one file: `PATH="$PWD/test/helpers/no-real-claude:$PATH" WORCA_HOME=.worca-cc-test node --disable-warning=ExperimentalWarning --test <file>`. Full suite: `npm test`.
- Commits: one per task, message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push.

## Review Focus

1. **A run started before this change** has `night.optIn` false and, with `enabled: true`, was answered by day; after it waits. Expect: it waits by day, and the run page pill says "waiting for you" (Task 1 test "unmarked run with Which runs = All runs waits by day").
2. **Away hours that wrap midnight** (22:00–07:00) at exactly the start/end minute. Expect: 22:00 counts as away, 07:00 as here; summary "They end at 07:00" (Task 3 test "boundary minutes").
3. **Time zone unset or invalid in the browser** (`timeZone: null`, or a zone the browser lacks). Expect: the summary uses the browser zone and names it; it never throws (Task 3 test "unknown zone").
4. **Ask Worca flips a finished run's switch.** Expect: a chat notice "Could not change Away mode on this run: the run is done", no state change (Task 10 test).
5. **The form's live summary with a half-typed away hour** (start set, end empty). Expect: the summary treats hours as not set here and says what is inherited; saving sends `__unset: ['window']` as today (Task 5 test "half-typed hours").

---

### Task 1: Shared activation math and the two behaviour changes

**Files:**
- Create: `src/shared/away-mode/activation.mjs`
- Modify: `src/core/night/activation.mjs` (becomes a re-export)
- Modify: `src/core/run-harness.mjs` (`_nightSnapshot` ~3886, `_nightArm` ~3650)
- Test: `test/night-activation.test.mjs`, `test/night-harness.test.mjs`, `test/night-mode-integration.test.mjs`

**Interfaces:**
- Produces: `src/shared/away-mode/activation.mjs` exporting `parseWindow`, `inWindow(w, tz, now)`, `msUntilWindowStart(w, tz, now)`, `nightAnchorMs(config, now, since)`, `nightState({config, toggle, optIn, override, now}) → {eligible, active, graceOn, wakeOn}`, `decideDelayMs({state, config, openedAt, now}) → number|null`. Same names and signatures as today.
- Produces: run snapshot `state.night` = `{optIn, override, decisions, flagged, openedAt}` where `openedAt` is an ISO string of the open question's arm time or `null`.

- [ ] **Step 1: Write the failing truth-table tests** — append to `test/night-activation.test.mjs`:

```js
// Away mode precedence (plans/away-mode-design.md §3.1).
const W = { ...NIGHT_DEFAULTS, window: '22:00-07:00', timeZone: 'UTC', graceMinutes: 30 };
const DAY = at('2026-09-28T15:00:00Z'); const NIGHT = at('2026-09-28T23:00:00Z');
const st = (o) => nightState({ config: W, toggle: 'auto', optIn: false, override: 'auto', ...o });

test('by day, only a MARKED run gets the waited-N-minutes rule', () => {
  assert.equal(st({ now: DAY, optIn: true }).graceOn, true);
  assert.equal(st({ now: DAY, optIn: false, config: { ...W, enabled: true } }).graceOn, false, 'All runs does not answer unmarked runs by day');
  assert.equal(st({ now: DAY, optIn: false, config: { ...W, enabled: true } }).active, false);
});

test('"I\'m away now" answers every run, marked or not, with or without All runs', () => {
  const s = st({ now: DAY, toggle: 'on', optIn: false, config: { ...W, enabled: false } });
  assert.deepEqual([s.eligible, s.active], [true, true]);
});

test('inside away hours: All runs answers unmarked runs; Only marked does not', () => {
  assert.equal(st({ now: NIGHT, config: { ...W, enabled: true } }).active, true);
  assert.equal(st({ now: NIGHT, config: { ...W, enabled: false } }).eligible, false);
  assert.equal(st({ now: NIGHT, optIn: true }).active, true);
});

test('precedence: run Never > run Answer now > Paused > I\'m away now', () => {
  assert.equal(st({ now: NIGHT, override: 'off', toggle: 'on', optIn: true }).eligible, false);
  assert.equal(st({ now: DAY, override: 'on', toggle: 'off' }).active, true);
  assert.equal(st({ now: NIGHT, toggle: 'off', optIn: true, config: { ...W, enabled: true } }).active, false);
  assert.equal(st({ now: NIGHT, toggle: 'off', optIn: true }).graceOn, false, 'paused: marked runs wait too');
});

test('boundary minutes: 22:00 is away, 07:00 is here', () => {
  assert.equal(inWindow('22:00-07:00', 'UTC', at('2026-09-28T22:00:00Z')), true);
  assert.equal(inWindow('22:00-07:00', 'UTC', at('2026-09-29T07:00:00Z')), false);
});
```

Add `import { NIGHT_DEFAULTS } from '../src/core/night/config.mjs';` at the top if the file does not import it yet.

- [ ] **Step 2: Run to verify failures**

Run: `node --test test/night-activation.test.mjs`
Expected: FAIL on the first four new tests (`graceOn` true for the unmarked run with `enabled`, `toggle 'on'` not eligible, paused marked run `graceOn` true).

- [ ] **Step 3: Move the module and apply the rules.** `git mv src/core/night/activation.mjs src/shared/away-mode/activation.mjs`, then replace its `nightState` with:

```js
/**
 * Away mode precedence (plans/away-mode-design.md §3.1). `optIn` = the run was MARKED at start.
 * @returns {{eligible:boolean, active:boolean, graceOn:boolean, wakeOn:boolean}}
 *   graceOn: the by-day "waited N minutes" rule applies (marked runs only); wakeOn: arm for the next away-hours start.
 */
export function nightState({ config, toggle = 'auto', optIn = false, override = 'auto', now }) {
  const off = { eligible: false, active: false, graceOn: false, wakeOn: false };
  if (override === 'off') return off;                                        // 1. Never on this run
  if (override === 'on') return { eligible: true, active: true, graceOn: false, wakeOn: false };   // 2. Answer for me now
  if (toggle === 'off') return off;                                          // 3. Paused
  if (toggle === 'on') return { eligible: true, active: true, graceOn: false, wakeOn: false };     // 4. I'm away now: every run
  const allowed = config.enabled === true || optIn === true;
  if (!allowed) return off;
  const away = inWindow(config.window, config.timeZone, now);                // 5. inside away hours
  return { eligible: true, active: away, graceOn: optIn === true && config.graceMinutes != null, wakeOn: true };
}
```

Change the file header comment to `// src/shared/away-mode/activation.mjs — Away mode activation math. Pure; \`now\` is passed in. Shared by server and browser.` Then create `src/core/night/activation.mjs`:

```js
// src/core/night/activation.mjs — re-export: the math lives in src/shared so the browser can use it.
export * from '../../shared/away-mode/activation.mjs';
```

- [ ] **Step 4: Run activation tests**

Run: `node --test test/night-activation.test.mjs`
Expected: PASS. If an older test asserts the removed behaviour (an unmarked run with `enabled` gets `graceOn`, or `toggle 'on'` needs eligibility), update its expectation to the §3.1 table and say so in the commit message.

- [ ] **Step 5: Add `openedAt` to the run snapshot.** In `src/core/run-harness.mjs`, `_nightSnapshot()`:

```js
  _nightSnapshot() {
    const opened = this._night.q && this.pendingQuestion?.id === this._night.q.id && this._night.openedAt != null
      ? new Date(this._night.openedAt).toISOString() : null;
    return { optIn: this._night.optIn, override: this._night.override, decisions: this._night.count, flagged: this._night.flagged, openedAt: opened };
  }
```

At the end of `_nightArm(q)` (after the timer is set, and also on the early `delay == null` return path) add `this.state.night = this._nightSnapshot(); this._emit('state', this.getState());` only when `q` was passed (a newly opened ask), so the pill learns the arm time. In `_ask`'s `finally`, after `this._nightCancel(id);`, add `if (this._night) this.state.night = this._nightSnapshot();`.

- [ ] **Step 6: Update harness tests to mark their runs.** Tests in `test/night-harness.test.mjs` and `test/night-mode-integration.test.mjs` that rely on the grace timer with `enabled: true` and no opt-in now must mark the run: add `nightMode: true` to their `createOrchestrator({...})` options (or the run's start request in the integration test). Add one test:

```js
test('an unmarked run with Which runs = All runs waits by day', async () => {
  await setNightMode({ enabled: true, graceMinutes: 1, window: '22:00-07:00', timeZone: 'UTC' });
  const clock = fakeClock(Date.parse('2026-09-27T12:00:00Z'));
  const orch = createOrchestrator({ projectDir: '/tmp/night-h40', nightClock: clock });
  orch._ask({ id: 'c40', kind: 'clarify', questions: Q }).catch(() => {});
  await clock.tick(10 * 60_000);
  assert.equal(orch.pendingQuestion?.id, 'c40');
  assert.equal(orch.state.night.openedAt, new Date(Date.parse('2026-09-27T12:00:00Z')).toISOString());
});
```

Tests that assert `state.night` with `deepEqual` gain `openedAt: null`.

- [ ] **Step 7: Run the night suites**

Run: `PATH="$PWD/test/helpers/no-real-claude:$PATH" WORCA_HOME=.worca-cc-test node --disable-warning=ExperimentalWarning --test test/night*.test.mjs test/*night*.test.mjs test/ui-night-mode.test.mjs`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A src/shared/away-mode src/core/night/activation.mjs src/core/run-harness.mjs test
git commit -m "Away mode: shared activation math; by-day rule for marked runs only; I'm away now covers every run"
```

---

### Task 2: Labels module

**Files:**
- Create: `src/shared/away-mode/labels.mjs`
- Test: `test/away-mode-labels.test.mjs`

**Interfaces:**
- Produces: `KIND_LABELS` (object kind → label), `METHOD_OPTIONS` (array `[{value, label, hint}]`), `CRITERIA_LABELS` (object), `FIELD_LABELS` (object field → `{label, hint}`), `RUN_SWITCH_OPTIONS` (array `[{value, label, tip}]`), `STATUS_ACTIONS` (object toggle → `[{mode, label, tip}]`), `kindLabel(kind)`, `pillText(state, minutes)`.

- [ ] **Step 1: Write the failing test** `test/away-mode-labels.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KIND_LABELS, METHOD_OPTIONS, CRITERIA_LABELS, FIELD_LABELS, RUN_SWITCH_OPTIONS, STATUS_ACTIONS, kindLabel, pillText } from '../src/shared/away-mode/labels.mjs';
import { NIGHT_KINDS, NIGHT_STRATEGIES, NIGHT_CRITERIA, NIGHT_FIELDS } from '../src/core/night/config.mjs';

test('every kind, method, criterion and field has a plain label', () => {
  for (const k of NIGHT_KINDS) assert.ok(KIND_LABELS[k], k);
  assert.deepEqual(METHOD_OPTIONS.map((m) => m.value).sort(), [...NIGHT_STRATEGIES].sort());
  for (const c of NIGHT_CRITERIA) assert.ok(CRITERIA_LABELS[c], c);
  for (const f of NIGHT_FIELDS) assert.ok(FIELD_LABELS[f]?.label, f);
});

test('labels use the glossary words only', () => {
  const all = JSON.stringify({ KIND_LABELS, METHOD_OPTIONS, CRITERIA_LABELS, FIELD_LABELS, RUN_SWITCH_OPTIONS, STATUS_ACTIONS });
  for (const bad of [/\bnight\b/i, /\bgrace\b/i, /\beligible\b/i, /\bforce\b/i, /\bstrategy\b/i]) assert.doesNotMatch(all, bad);
});

test('run switch, status actions and pill wording', () => {
  assert.deepEqual(RUN_SWITCH_OPTIONS.map((o) => [o.value, o.label]), [['auto', 'As set up'], ['on', 'Answer for me now'], ['off', 'Never on this run']]);
  assert.deepEqual(STATUS_ACTIONS.auto.map((a) => a.label), ["I'm away now", 'Pause away mode']);
  assert.deepEqual(STATUS_ACTIONS.on.map((a) => a.label), ["I'm back"]);
  assert.deepEqual(STATUS_ACTIONS.off.map((a) => a.label), ['Turn away mode back on']);
  assert.equal(kindLabel('gate'), 'Fix again or continue, in a review loop');
  assert.equal(pillText('after', 12), 'answers after 12 min');
  assert.equal(pillText('now'), 'answering');
});
```

- [ ] **Step 2: Run** `node --test test/away-mode-labels.test.mjs` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `src/shared/away-mode/labels.mjs` (strings from `plans/away-mode-wording.md` §3.1 D–F, §3.3, §3.1 B):

```js
// src/shared/away-mode/labels.mjs — the plain words for every Away mode setting and state.
// Zero imports: served to the browser at /src/shared. Copy: plans/away-mode-wording.md §3.

export const KIND_LABELS = Object.freeze({
  clarify: 'Clarifying questions before planning',
  questions: 'Questions an agent asks mid-step',
  form: 'Input forms',
  gate: 'Fix again or continue, in a review loop',
  workflow: 'Approving a proposed workflow',
  recovery: 'A step failed: retry or give up',
});
export const kindLabel = (k) => KIND_LABELS[k] || String(k);

export const METHOD_OPTIONS = Object.freeze([
  { value: 'mixed', label: 'Trust the agent when it is sure, otherwise weigh the options', hint: '' },
  { value: 'weights', label: "Always trust the agent's recommendation", hint: '' },
  { value: 'analysis', label: 'Always weigh the options', hint: 'A separate read-only review scores each option.' },
]);

export const CRITERIA_LABELS = Object.freeze({
  matchesMemory: 'Matches what you decided before',
  reversible: 'Easy to undo',
  smallestScope: 'Changes the least',
  codebaseConventions: "Follows the codebase's conventions",
  cost: 'Costs the least',
});

export const FIELD_LABELS = Object.freeze({
  enabled: { label: 'Which runs', hint: '' },
  window: { label: 'Away hours', hint: 'During these hours you count as away. worca answers on the runs allowed below.' },
  timeZone: { label: 'Time zone', hint: "Hours are read in this zone. Empty = this computer's zone." },
  graceMinutes: { label: 'Marked runs by day', hint: 'Outside away hours, a marked run is still answered once a question has waited this long. Unmarked runs are never answered by day.' },
  strategy: { label: 'Method', hint: 'Answers below the bar are still given, but flagged for you.' },
  minConfidence: { label: 'Trust the agent only if it is at least', hint: 'Below this, worca weighs the options instead (or flags the answer).' },
  minMargin: { label: '…and its choice leads the next one by', hint: 'A close call is not trusted.' },
  criteria: { label: 'What matters when weighing options', hint: '0 = ignore, 10 = decisive' },
  neverDecide: { label: 'Always wait for me on…', hint: 'Ticked kinds are never answered by worca, even while you are away. The run pauses on them.' },
  spendCapUsd: { label: 'Pause everything at', hint: 'Counted from the start of the current away stretch, across all projects. Not set = no cap.' },
  maxDecisions: { label: 'Pause a run after', hint: 'When worca has answered this many times on one run, the run pauses and waits for you.' },
  maxExtraCycles: { label: 'Extra fix rounds in a review loop', hint: 'When critical issues remain, worca may ask for this many more fix rounds. After that it continues and flags it.' },
  allowCostCapOverride: { label: "May exceed the team's cost cap", hint: "Off: a run pauses at the team's soft cost cap while you are away. On: worca keeps going and flags it." },
});

export const WHICH_RUNS_OPTIONS = Object.freeze([
  { value: false, label: 'Only runs I marked', hint: 'Mark a run when you start it (New run → "Mark this run", or --night). Other runs wait for you.' },
  { value: true, label: 'All runs', hint: 'Every run is answered while you are away, marked or not.' },
]);

export const RUN_SWITCH_OPTIONS = Object.freeze([
  { value: 'auto', label: 'As set up', tip: 'Follows Settings and whether you marked this run.' },
  { value: 'on', label: 'Answer for me now', tip: "worca answers this run's questions from now on, at any hour, even if away mode is paused." },
  { value: 'off', label: 'Never on this run', tip: 'worca never answers on this run, whatever the settings.' },
]);
export const RUN_SWITCH_TIP = 'Overrides Settings › Away mode for this run only.';

export const STATUS_ACTIONS = Object.freeze({
  auto: [
    { mode: 'on', label: "I'm away now", tip: 'worca answers on every run from now until you click "I\'m back".' },
    { mode: 'off', label: 'Pause away mode', tip: 'worca answers nothing, on any run, until you turn it back on. Your away hours are kept.' },
  ],
  on: [{ mode: 'auto', label: "I'm back", tip: 'Go back to following your away hours.' }],
  off: [{ mode: 'auto', label: 'Turn away mode back on', tip: 'Go back to following your away hours.' }],
});

/** Run page pill: `now` | `wait` | `after` | `never`. */
export function pillText(state, minutes = 0) {
  switch (state) {
    case 'now': return 'answering';
    case 'after': return `answers after ${Math.max(1, Math.round(minutes))} min`;
    case 'never': return 'never';
    default: return 'waiting for you';
  }
}
```

- [ ] **Step 4: Run** `node --test test/away-mode-labels.test.mjs` — Expected: PASS.

- [ ] **Step 5: Commit** `git add src/shared/away-mode/labels.mjs test/away-mode-labels.test.mjs && git commit -m "Away mode: plain labels for every setting, kind and state"`

---

### Task 3: Summary generator

**Files:**
- Create: `src/shared/away-mode/describe.mjs`
- Test: `test/away-mode-describe.test.mjs`

**Interfaces:**
- Consumes: Task 1 `inWindow`, `msUntilWindowStart`, `nightState`, `decideDelayMs`; Task 2 `kindLabel`, `pillText`.
- Produces:
  - `describeAwayMode({config, toggle, now, localZone?, projectName?}) → {status: 'here'|'away-hours'|'away-now'|'paused'|'no-hours', lines: string[]}` — the card summary (proposal §3.1 A lines 1–4).
  - `describeRun({config, toggle, now, run: {optIn, override, openedAt, done}}) → {state: 'now'|'wait'|'after'|'never', pill: string, reason: string, minutes?: number}`.
  - `describeNewRun({config, toggle}) → string` — the New-run hint (proposal §3.4).
  - `describeChange(beforeConfig, afterConfig, {toggle, now}) → {before: string[], after: string[]}` — lines 2–3 before and after (for the card).
  - `fmtHHMM(ms, tz)` helper.
- `config` is a resolved Away mode config (the shape of `resolveNightConfig().config`).

- [ ] **Step 1: Write the failing tests** `test/away-mode-describe.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeAwayMode, describeRun, describeNewRun, describeChange } from '../src/shared/away-mode/describe.mjs';
import { NIGHT_DEFAULTS } from '../src/core/night/config.mjs';

const at = (iso) => Date.parse(iso);
const C = { ...NIGHT_DEFAULTS, window: '22:00-07:00', timeZone: 'UTC', graceMinutes: 30, enabled: false };
const base = { config: C, toggle: 'auto', localZone: 'UTC' };

test('worked example at 15:00 (proposal §3.1 A)', () => {
  const d = describeAwayMode({ ...base, now: at('2026-09-28T15:00:00Z') });
  assert.equal(d.status, 'here');
  assert.deepEqual(d.lines, [
    'Right now it is 15:00. You count as here. Next away hours start at 22:00.',
    'From 22:00 to 07:00, worca answers questions on runs you marked. Other runs wait for you.',
    'Outside those hours, a marked run is answered once a question has waited 30 minutes. Unmarked runs always wait.',
  ]);
});

test('the four cells: 15:00 / 23:00 × marked / unmarked', () => {
  const run = (iso, optIn) => describeRun({ config: C, toggle: 'auto', now: at(iso), run: { optIn, override: 'auto', openedAt: iso, done: false } });
  assert.deepEqual([run('2026-09-28T15:00:00Z', true).state, run('2026-09-28T15:00:00Z', true).minutes], ['after', 30]);
  assert.equal(run('2026-09-28T15:00:00Z', false).state, 'wait');
  assert.equal(run('2026-09-28T23:00:00Z', true).state, 'now');
  assert.equal(run('2026-09-28T23:00:00Z', false).state, 'wait');
});

test('status variants', () => {
  const now = at('2026-09-28T23:00:00Z');
  assert.match(describeAwayMode({ ...base, now }).lines[0], /You count as away \(your away hours\)\. They end at 07:00\./);
  assert.match(describeAwayMode({ ...base, now, toggle: 'on' }).lines[0], /because you said "I'm away now"/);
  assert.match(describeAwayMode({ ...base, now, toggle: 'off' }).lines[0], /^Away mode is paused\./);
  assert.match(describeAwayMode({ ...base, now, config: { ...C, window: null } }).lines[0], /^No away hours are set\./);
  assert.equal(describeAwayMode({ ...base, now, config: { ...C, enabled: true } }).lines[1], 'From 22:00 to 07:00, worca answers questions on all runs.');
  assert.equal(describeAwayMode({ ...base, now, config: { ...C, graceMinutes: null } }).lines[2], 'Outside those hours, every run waits for you.');
  assert.equal(describeAwayMode({ ...base, now, config: { ...C, neverDecide: ['gate', 'recovery'] } }).lines[3],
    'Fix again or continue, in a review loop and A step failed: retry or give up always wait for you, even when you are away.');
});

test('boundary minutes', () => {
  assert.equal(describeAwayMode({ ...base, now: at('2026-09-28T22:00:00Z') }).status, 'away-hours');
  assert.equal(describeAwayMode({ ...base, now: at('2026-09-29T07:00:00Z') }).status, 'here');
});

test('unknown zone: falls back to the local zone, names it, never throws', () => {
  const d = describeAwayMode({ ...base, config: { ...C, timeZone: 'Mars/Olympus' }, localZone: 'UTC', now: at('2026-09-28T15:00:00Z') });
  assert.match(d.lines[0], /15:00 UTC/);
});

test('run switch states', () => {
  const r = (o) => describeRun({ config: C, toggle: 'auto', now: at('2026-09-28T15:00:00Z'), run: { optIn: false, override: 'auto', openedAt: null, done: false, ...o } });
  assert.equal(r({ override: 'off' }).pill, 'never');
  assert.equal(r({ override: 'on' }).pill, 'answering');
  assert.equal(r({ done: true }).state, 'never');
});

test('New-run hint variants', () => {
  assert.match(describeNewRun({ config: C, toggle: 'auto' }), /^While you are away \(Settings › Away mode: 22:00–07:00, or "I'm away now"\)/);
  assert.match(describeNewRun({ config: { ...C, enabled: true }, toggle: 'auto' }), /already allow every run/);
  assert.match(describeNewRun({ config: C, toggle: 'off' }), /^Away mode is paused/);
});

test('before/after for a card', () => {
  const d = describeChange(C, { ...C, enabled: true }, { toggle: 'auto', now: at('2026-09-28T15:00:00Z') });
  assert.match(d.before[0], /runs you marked/);
  assert.match(d.after[0], /all runs/);
});

test('never throws on junk', () => {
  assert.doesNotThrow(() => describeAwayMode({ config: null, toggle: undefined, now: NaN }));
  assert.deepEqual(describeAwayMode({ config: null, toggle: 'auto', now: 0 }).lines, ['Away mode settings could not be read.']);
});
```

- [ ] **Step 2: Run** `node --test test/away-mode-describe.test.mjs` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `src/shared/away-mode/describe.mjs`:

```js
// src/shared/away-mode/describe.mjs — the ONE source of Away mode's plain-English text: the Settings
// card summary, the project card, the run page pill, the New-run hint, Ask Worca and its card.
// Pure; `now` is passed in. Copy: plans/away-mode-wording.md §3.1 A, §3.3, §3.4.
import { inWindow, msUntilWindowStart, nightState, decideDelayMs, parseWindow } from './activation.mjs';
import { kindLabel, pillText } from './labels.mjs';

const MIN = 60_000;

function zoneOk(tz) {
  if (!tz) return false;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch { return false; }
}
/** The zone the hours are read in: the configured one when valid, else the local one. */
function zoneOf(config, localZone) {
  return zoneOk(config.timeZone) ? config.timeZone : (localZone || Intl.DateTimeFormat().resolvedOptions().timeZone);
}
export function fmtHHMM(ms, tz) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}
const joinAnd = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

function hoursOf(config) {
  const w = parseWindow(config.window);
  return w ? config.window.split('-') : null;
}

function statusLine(config, toggle, now, tz, localZone) {
  // Name the zone when it is not the local one, or when the configured zone was unusable (we fell back).
  const fellBack = !!config.timeZone && !zoneOk(config.timeZone);
  const zoneTag = tz !== localZone || fellBack ? ` ${tz}` : '';
  const hours = hoursOf(config);
  if (toggle === 'off') return { status: 'paused', text: 'Away mode is paused. worca answers nothing until you turn it back on. (Marked runs wait too.)' };
  if (toggle === 'on') return { status: 'away-now', text: 'Right now you count as away because you said "I\'m away now". worca answers on every run until you click "I\'m back".' };
  if (!hours) {
    const extra = config.graceMinutes != null ? `, or on a marked run after a question has waited ${config.graceMinutes} minutes` : '';
    return { status: 'no-hours', text: `No away hours are set. worca only answers when you click "I'm away now"${extra}.` };
  }
  const cfg = { ...config, timeZone: tz };
  if (inWindow(cfg.window, tz, now)) return { status: 'away-hours', text: `Right now it is ${fmtHHMM(now, tz)}${zoneTag}. You count as away (your away hours). They end at ${hours[1]}.` };
  return { status: 'here', text: `Right now it is ${fmtHHMM(now, tz)}${zoneTag}. You count as here. Next away hours start at ${hours[0]}.` };
}

function scheduleLines(config) {
  const hours = hoursOf(config);
  const lines = [];
  if (hours) {
    lines.push(config.enabled === true
      ? `From ${hours[0]} to ${hours[1]}, worca answers questions on all runs.`
      : `From ${hours[0]} to ${hours[1]}, worca answers questions on runs you marked. Other runs wait for you.`);
    lines.push(config.graceMinutes != null
      ? `Outside those hours, a marked run is answered once a question has waited ${config.graceMinutes} minutes. Unmarked runs always wait.`
      : 'Outside those hours, every run waits for you.');
  }
  return lines;
}

/** @returns {{status:string, lines:string[]}} */
export function describeAwayMode({ config, toggle = 'auto', now, localZone = null, projectName = null } = {}) {
  try {
    if (!config || typeof config !== 'object' || !Number.isFinite(now)) return { status: 'unknown', lines: ['Away mode settings could not be read.'] };
    const local = localZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const tz = zoneOf(config, local);
    const s = statusLine(config, toggle, now, tz, local);
    const lines = [s.text, ...scheduleLines(config)];
    const kinds = Array.isArray(config.neverDecide) ? config.neverDecide : [];
    if (kinds.length) lines.push(`${joinAnd(kinds.map(kindLabel))} always wait${kinds.length === 1 ? 's' : ''} for you, even when you are away.`);
    if (projectName) lines[0] = `For ${projectName}: ${lines[0]}`;
    return { status: s.status, lines };
  } catch {
    return { status: 'unknown', lines: ['Away mode settings could not be read.'] };
  }
}

/** One run's state for the pill and the tooltip. */
export function describeRun({ config, toggle = 'auto', now, run = {}, localZone = null } = {}) {
  try {
    if (run.done || !config) return { state: 'never', pill: pillText('never'), reason: 'The run is over.' };
    const tz = zoneOf(config, localZone);
    const cfg = { ...config, timeZone: tz };
    const st = nightState({ config: cfg, toggle, optIn: run.optIn === true, override: run.override || 'auto', now });
    if (run.override === 'off') return { state: 'never', pill: pillText('never'), reason: 'You set this run to "Never on this run".' };
    if (!st.eligible) return { state: 'wait', pill: pillText('wait'), reason: toggle === 'off' ? 'Away mode is paused.' : 'This run is not marked and your settings allow only marked runs.' };
    if (st.active) return { state: 'now', pill: pillText('now'), reason: run.override === 'on' ? 'You set this run to "Answer for me now".' : toggle === 'on' ? 'You said "I\'m away now".' : 'You are inside your away hours.' };
    const openedAt = run.openedAt ? Date.parse(run.openedAt) : now;
    if (st.graceOn) {
      const delay = decideDelayMs({ state: { ...st, wakeOn: false }, config: cfg, openedAt, now });
      if (delay != null) return { state: 'after', pill: pillText('after', delay / MIN), minutes: Math.max(1, Math.round(delay / MIN)), reason: 'A marked run is answered by day once a question has waited long enough.' };
    }
    return { state: 'wait', pill: pillText('wait'), reason: 'You count as here, and unmarked runs wait for you by day.' };
  } catch {
    return { state: 'wait', pill: pillText('wait'), reason: 'Away mode settings could not be read.' };
  }
}

/** The New-run toggle's hint (proposal §3.4). */
export function describeNewRun({ config, toggle = 'auto' } = {}) {
  if (!config) return '';
  if (toggle === 'off') return 'Away mode is paused: even a marked run waits for you until you turn it back on.';
  const hours = hoursOf(config);
  const n = config.graceMinutes;
  if (config.enabled === true) return `Your settings already allow every run while you are away.${n != null ? ` Marking adds the ${n}-minute rule by day.` : ''}`;
  const when = hours ? `Settings › Away mode: ${hours[0]}–${hours[1]}, or "I'm away now"` : 'Settings › Away mode: "I\'m away now"';
  return `While you are away (${when}), worca answers this run's questions.${n != null ? ` By day it also answers once a question has waited ${n} minutes.` : ''}`;
}

/** Lines 2–3 before and after a stored change (the Ask Worca card). */
export function describeChange(before, after, { toggle = 'auto', now, localZone = null } = {}) {
  const pick = (c) => describeAwayMode({ config: c, toggle, now, localZone }).lines.slice(1);
  return { before: pick(before), after: pick(after) };
}
```

Note `inWindow` / `msUntilWindowStart` are imported for callers' parity; remove any unused import the linter flags.

- [ ] **Step 4: Run** `node --test test/away-mode-describe.test.mjs` — Expected: PASS. Fix wording until each asserted string matches exactly.

- [ ] **Step 5: Commit** `git add src/shared/away-mode/describe.mjs test/away-mode-describe.test.mjs && git commit -m "Away mode: one summary generator for every surface"`

---

### Task 4: `GET /api/away-mode`

**Files:**
- Modify: `ui/server.mjs` (next to `GET /api/night-decisions` ~2890)
- Test: `test/api-away-mode.test.mjs` (boot pattern: copy from `test/api-night-mode.test.mjs`)

**Interfaces:**
- Consumes: `effectiveNightConfig(projectDir)` (`src/core/night/effective.mjs`), `resolveNightConfig`, `nightModeSettings()`, `nightModeToggle()`, `readNightModePrefs(projectKey(dir))`.
- Produces: `GET /api/away-mode[?projectDir=]` → `{config, sources, toggle, user, project}` (`project` null without `projectDir`).

- [ ] **Step 1: Write the failing test** `test/api-away-mode.test.mjs` — boot the server as `test/api-night-mode.test.mjs` does, then:

```js
test('GET /api/away-mode: effective config, sources, live status and the raw layers', async () => {
  await api('POST', '/api/settings', { nightMode: { window: '22:00-07:00', enabled: true }, nightModeToggle: 'on' });
  const r = await api('GET', '/api/away-mode');
  assert.equal(r.status, 200);
  assert.equal(r.body.toggle, 'on');
  assert.equal(r.body.config.window, '22:00-07:00');
  assert.equal(r.body.sources.window, 'user');
  assert.deepEqual(r.body.user, { window: '22:00-07:00', enabled: true });
  assert.equal(r.body.project, null);
});
test('GET /api/away-mode?projectDir= adds the project layer', async () => {
  await api('PATCH', '/api/config', { projectDir: dir, nightMode: { graceMinutes: 45 } });
  const r = await api('GET', `/api/away-mode?projectDir=${encodeURIComponent(dir)}`);
  assert.equal(r.body.config.graceMinutes, 45);
  assert.equal(r.body.sources.graceMinutes, 'project');
  assert.deepEqual(r.body.project, { graceMinutes: 45 });
});
```

- [ ] **Step 2: Run** — Expected: FAIL (404).

- [ ] **Step 3: Implement** in `ui/server.mjs` after the night-decisions route:

```js
// GET /api/away-mode[?projectDir=] — what Away mode will do: the effective config (with the team
// layer when a project is given), where each field comes from, the live status and the raw layers
// the forms edit. Every surface renders its text from this through src/shared/away-mode/describe.mjs.
app.get('/api/away-mode', (req, res) => {
  const projectDir = typeof req.query.projectDir === 'string' && req.query.projectDir ? req.query.projectDir : null;
  const { config, sources } = projectDir ? effectiveNightConfig(projectDir) : resolveNightConfig({ user: nightModeSettings() });
  let project = null;
  if (projectDir) { try { project = readNightModePrefs(projectKey(projectDir)) || {}; } catch { project = {}; } }
  res.json({ config, sources, toggle: nightModeToggle(), user: nightModeSettings() || {}, project });
});
```

Import `effectiveNightConfig` from `../src/core/night/effective.mjs` if the file does not already.

- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Away mode: GET /api/away-mode"` (add the new test file first).

---

### Task 5: Settings card (form rewrite, live summary, status strip)

**Files:**
- Modify: `ui/public/night-mode-form.mjs` (rewrite `renderNightForm`; keep `readNightForm`'s output contract)
- Modify: `ui/public/index.html` (`#night-settings-card`, ~1657-1683)
- Modify: `ui/public/app.js` (`paintNightSettings` and handlers ~11724-11740)
- Modify: `ui/public/style.css` (`.night-*` rules)
- Test: `test/ui-night-mode.test.mjs`, `test/ui-settings-*.test.mjs` (card and ⓘ counts)

**Interfaces:**
- Consumes: Task 2 labels, Task 3 `describeAwayMode`, Task 4 `GET /api/away-mode`.
- Produces: `renderNightForm(root, {level, values, effective, sources, toggle, now?, onChange?})` — same patch contract from `readNightForm(root, {level})` (`{...patch, __unset: [...]}`); new `paintAwaySummary(host, {config, toggle, now})`.

- [ ] **Step 1: Write failing jsdom tests** (append to `test/ui-night-mode.test.mjs`, using its existing `renderNightForm` import and JSDOM setup):

```js
test('the card reads top to bottom: summary, which runs, marked runs by day, collapsed advanced', () => {
  const root = new JSDOM('<div id="r"></div>').window.document.getElementById('r');
  renderNightForm(root, { level: 'user', values: { window: '22:00-07:00' }, effective: { ...NIGHT_DEFAULTS, window: '22:00-07:00', timeZone: 'UTC' }, sources: {}, toggle: 'auto', now: Date.parse('2026-09-28T15:00:00Z') });
  const summary = root.querySelector('.away-summary').textContent;
  assert.match(summary, /You count as here/);
  assert.deepEqual([...root.querySelectorAll('.away-which input')].map((i) => i.closest('label').textContent.trim()), ['Only runs I marked', 'All runs']);
  assert.match(root.querySelector('.away-byday').textContent, /Marked runs by day/);
  for (const t of ['How worca picks an answer', 'Limits', 'Always wait for me on…']) {
    const d = [...root.querySelectorAll('details')].find((x) => x.querySelector('summary').textContent.includes(t));
    assert.ok(d && !d.open, t);
  }
});

test('the summary updates on input; switching to All runs changes line 2', () => {
  const root = new JSDOM('<div id="r"></div>').window.document.getElementById('r');
  renderNightForm(root, { level: 'user', values: { window: '22:00-07:00', timeZone: 'UTC' }, effective: { ...NIGHT_DEFAULTS, window: '22:00-07:00', timeZone: 'UTC' }, sources: {}, toggle: 'auto', now: Date.parse('2026-09-28T15:00:00Z') });
  const all = [...root.querySelectorAll('.away-which input')][1];
  all.checked = true; all.dispatchEvent(new root.ownerDocument.defaultView.Event('change', { bubbles: true }));
  assert.match(root.querySelector('.away-summary').textContent, /on all runs/);
});

test('half-typed hours: summary says inherited, save unsets the window', () => {
  const root = new JSDOM('<div id="r"></div>').window.document.getElementById('r');
  renderNightForm(root, { level: 'user', values: {}, effective: { ...NIGHT_DEFAULTS }, sources: {}, toggle: 'auto', now: Date.parse('2026-09-28T15:00:00Z') });
  root.querySelector('.night-window-start').value = '22:00';
  root.querySelector('.night-window-start').dispatchEvent(new root.ownerDocument.defaultView.Event('input', { bubbles: true }));
  assert.match(root.querySelector('.away-summary').textContent, /No away hours are set/);
  assert.ok(readNightForm(root, { level: 'user' }).__unset.includes('window'));
});

test('round-trip: empty vs set vs explicit off gives the same patch as before', () => {
  const root = new JSDOM('<div id="r"></div>').window.document.getElementById('r');
  renderNightForm(root, { level: 'user', values: { enabled: true, window: null, graceMinutes: null, spendCapUsd: 5, neverDecide: ['gate'] }, effective: { ...NIGHT_DEFAULTS }, sources: {}, toggle: 'auto', now: 0 });
  const p = readNightForm(root, { level: 'user' });
  assert.deepEqual([p.enabled, p.window, p.graceMinutes, p.spendCapUsd, p.neverDecide], [true, null, null, 5, ['gate']]);
  assert.ok(p.__unset.includes('strategy'));
});
```

Plus a card-level test through the app boot (existing Settings boot in `test/ui-night-mode.test.mjs`): the status strip shows buttons `I'm away now` and `Pause away mode` for toggle `auto`; clicking `I'm away now` POSTs `/api/settings` with `{nightModeToggle: 'on'}` only.

- [ ] **Step 2: Run** `node --test test/ui-night-mode.test.mjs` — Expected: FAIL on the new tests.

- [ ] **Step 3: Rewrite `renderNightForm`.** Structure (all strings from Task 2 labels / proposal §3.1):
  1. `<p class="away-summary">` filled by `paintAwaySummary(host, {config, toggle, now})` = one `<span>` per `describeAwayMode(...).lines` entry.
  2. Section `<h3>When and where worca answers</h3>`: away hours (`.night-window-start`, `.night-window-end`, keep classes for `readNightForm`), `No away hours` checkbox (`.night-window-off`), time zone (`.night-timezone`) with hint; `Which runs` as a radio group `.away-which` (two `input[type=radio][name=away-which-<level>]`, values `'false'`/`'true'`; at project level a first radio `Same as my settings (<inherited label>)` with value `''`); `Marked runs by day` `[N] minutes` (`.night-num[data-field=graceMinutes]`) inside `.away-byday` with checkbox `Never by day` (`.night-grace-off`).
  3. `<details class="away-adv"><summary>How worca picks an answer</summary>`: method select `.night-strategy` with `METHOD_OPTIONS`; min confidence and min margin (`.night-num`) with their labels/hints; criteria inputs `.night-crit-val` labelled by `CRITERIA_LABELS`.
  4. `<details class="away-adv"><summary>Limits</summary>`: max decisions, extra cycles (`.night-num`), spend cap (user level only, `.night-spend-cap` + `.night-spend-cap-off` "No cap"), `allowCostCapOverride` as a checkbox-style tri-select `.night-override` (keep the select: Not set / On / Off, labelled by `FIELD_LABELS.allowCostCapOverride`).
  5. `<details class="away-adv"><summary>Always wait for me on…</summary>`: `.night-never` checkboxes labelled by `KIND_LABELS`.
  - Every empty input shows the inherited value as `placeholder` and a `small.hint` "(default)" / "(team default)" / "(your setting)" from `sources`.
  - `readNightForm`: replace the `.night-enabled` select read with the radio group: `''` → unset, `'true'`/`'false'` → boolean. Everything else unchanged.
  - Live summary: attach one `input` + `change` listener on `root` that builds `formConfig = {...effective, ...patchWithoutUnset}` from `readNightForm(root, {level})` (dropping `__unset` fields back to `effective`) and calls `paintAwaySummary`.

- [ ] **Step 4: Settings card markup** in `ui/public/index.html`: title `Away mode`; info tip text from proposal §3.1 (card title + info tip); replace the `Right now` select with `<div class="away-status" id="awayStatus"></div>` (buttons rendered by app.js); keep `#night-mode-host`, `#nightModeReset` (label "Use defaults"), `#nightModeSave`, `#nightModeMsg`.

- [ ] **Step 5: app.js wiring.** `paintNightSettings(data)` now fetches `GET /api/away-mode` (user level) and calls `renderNightForm(host, {level:'user', values: d.user, effective: d.config, sources: d.sources, toggle: d.toggle, now: Date.now()})`, then paints `#awayStatus` with `STATUS_ACTIONS[d.toggle]` buttons (`button.btn.btn-mini`, `title` = tip). A status button click posts `{nightModeToggle: mode}` via `postNightSettings` (no `nightMode` key). Save posts `{nightMode: readNightForm(...)}` only. Reset posts `{nightMode: null}` only. After save show `Saved. The summary above is what will happen.`

- [ ] **Step 6: Update pinned counts.** Run `node --test test/ui-settings-*.test.mjs`; the ⓘ count and card counts change only if you removed or added `.info-tip` buttons — adjust the numbers and their message strings to the new totals.

- [ ] **Step 7: Run** `node --test test/ui-night-mode.test.mjs test/ui-settings-*.test.mjs` — Expected: PASS.

- [ ] **Step 8: Commit** `git commit -am "Away mode: Settings card reads top to bottom, with a live summary and status buttons"`

---

### Task 6: Project card

**Files:**
- Modify: `ui/public/app.js` (`buildPdNightCard` ~9923)
- Test: `test/ui-night-mode.test.mjs`

**Interfaces:**
- Consumes: Task 4 endpoint with `projectDir`; Task 5 `renderNightForm(root, {level:'project', ...})`.

- [ ] **Step 1: Failing test** (existing project-card boot in `test/ui-night-mode.test.mjs`): title `Away mode for this project`; summary starts `For <project name>:`; the Which-runs radio's first option reads `Same as my settings (Only runs I marked)`; no `.night-spend-cap`; a line `"I'm away now" and "Pause" are global. Change them in Settings › Away mode.` is present.

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement.** In `buildPdNightCard(p)`: title text `Away mode for this project`; hint = proposal §3.2 sub-line; load via `fetch('/api/away-mode?projectDir=' + encodeURIComponent(p.path))` and paint `renderNightForm(host, {level:'project', values: d.project, effective: d.config, sources: d.sources, toggle: d.toggle, now: Date.now(), projectName: p.name})` (pass `projectName` through to `describeAwayMode`). Add the global-status line and the spend-cap line (proposal §3.2) as `small.hint` elements. Rename `Reset to inherited` → `Use my settings`. After a successful PATCH, re-fetch `/api/away-mode?projectDir=` and repaint (the PATCH response's `nightMode` block has no `toggle`).

- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Away mode: project card with 'Same as my settings' and the project summary"`

---

### Task 7: Run page switch, pill, and New-run toggle

**Files:**
- Modify: `ui/public/index.html` (`.rd-night-wrap` ~571; `#night-row` ~372)
- Modify: `ui/public/app.js` (run switch paint ~25006, change handler ~23946; New-run form hint; an Away mode cache refreshed on `settings-changed` ~1100)
- Modify: `ui/public/style.css` (`.rd-night-pill`)
- Test: `test/ui-night-mode.test.mjs`

**Interfaces:**
- Consumes: Task 2 `RUN_SWITCH_OPTIONS`, `RUN_SWITCH_TIP`; Task 3 `describeRun`, `describeNewRun`; Task 4 endpoint; Task 1 `state.night.openedAt`.
- Produces: `state.awayMode` in app.js = last `GET /api/away-mode` body (no project), refetched on `settings-changed`.

- [ ] **Step 1: Failing tests:**
  - Run page: the select's options read `As set up / Answer for me now / Never on this run`, each option has a `title` tooltip from `RUN_SWITCH_OPTIONS`, the wrapper's `title` is `RUN_SWITCH_TIP`, the label reads `Away mode on this run`, and `.rd-night-pill` shows `answers after 30 min` for a marked run whose `night.openedAt` is now, with the fetched away-mode `{config:{window:'22:00-07:00', timeZone:'UTC', graceMinutes:30, enabled:false}, toggle:'auto'}` and a stubbed `Date.now()` at 15:00Z.
  - New run: the toggle label reads `Mark this run: worca may answer for me`; `#nightModeHint` text equals `describeNewRun({config, toggle})` for the fetched body; with `toggle: 'off'` it starts `Away mode is paused`.

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Markup.** `index.html` run bar:

```html
<!-- Away mode on this run (POST /api/run/night); hidden once the run is over. -->
<label class="rd-night-wrap" hidden><span class="txt">Away mode on this run</span>
  <select class="rd-night select input-mini" aria-label="Away mode on this run"></select>
  <span class="rd-night-pill"></span></label>
```

New-run: change the toggle text to `Mark this run: worca may answer for me` and add `<small class="hint" id="nightModeHint"></small>` after the label.

- [ ] **Step 4: app.js.** Fill the run select once from `RUN_SWITCH_OPTIONS` (`option.title = tip`), set `wrap.title = RUN_SWITCH_TIP`. In the paint function (where `.rd-night-wrap` visibility is set) compute `const d = describeRun({config: state.awayMode?.config, toggle: state.awayMode?.toggle, now: Date.now(), run: {...(r.night||{}), done: terminal}})` and set `.rd-night-pill` text to `d.pill`, its `title` to `d.reason`, `data-state` to `d.state`. Add the pill to the 1 s ticker's repaint (the same place `.run-time` is refreshed) so "answers after N min" counts down. New-run: on form open and on `settings-changed`, set `#nightModeHint` to `describeNewRun(state.awayMode || {})`. Load `state.awayMode` with `fetch('/api/away-mode')` at boot and on `settings-changed`.

- [ ] **Step 5: Run** `node --test test/ui-night-mode.test.mjs test/ui-question-*.test.mjs` — Expected: PASS.

- [ ] **Step 6: Commit** `git commit -am "Away mode: run switch with tooltips and a state pill; Mark this run on New run"`

---

### Task 8: Decisions, pause reasons, CLI, team policy wording

**Files:**
- Modify: `src/core/night/strategies.mjs` (rationale/reason strings at lines ~51-94), `src/core/night/decider.mjs` (~46-75)
- Modify: `src/core/failure-policy.mjs:197` (NIGHT_GUARDRAIL label)
- Modify: `src/core/run-harness.mjs` guardrail `detail` strings (`_nightGuardrail`)
- Modify: `ui/public/app.js` `paintNightDecisions` (~24071)
- Modify: `src/cli/worca-cc.mjs:331-332` (help), `:836` (log line)
- Modify: `src/core/policy/registry.mjs:30,65-77` (labels/help)
- Test: `test/night-strategies.test.mjs`, `test/night-decider.test.mjs`, `test/ui-night-mode.test.mjs`, `test/cli-*.test.mjs` pins, `test/team-policy-view.test.mjs`, `test/policy-night-fields.test.mjs`

- [ ] **Step 1: Update the tests first** to the proposal §3.6 strings:
  - weights met: `the agent recommended this at 82%, well ahead of the next option` (for confidence 82; drop the numeric lead);
  - below threshold: `the agent was not sure enough; first option taken`;
  - analysis failure: `could not weigh the options (<reason>); first option taken`;
  - no options: `free-text question; worca cannot answer it`;
  - gate: `no critical issues left, continuing` / `N critical issues left, one more fix round` / `N critical issues left but the extra fix rounds are used up; continuing`;
  - workflow: `workflow accepted as proposed` / `workflow accepted; P% of the away spend cap used`;
  - pause label: `Away mode limit reached`; guardrail details: `Paused: worca answered N times on this run, the limit you set. Resume to continue, or raise the limit in Settings › Away mode › Limits.` and `Paused: spending while away reached $X. Resume to continue, or raise the cap.`;
  - decisions list: header `Answers while you were away (n, m to check)`; row `Answered for you: "<choice>" — <rationale>.` or `Answered for you, please check: …` for flagged; kind shown with `kindLabel`;
  - CLI help line (proposal §3.5) and log line `Away mode answered <kind label> …` / `(please check)`;
  - registry: group label `Away mode`, each `night.*` field `label`/`help` from `FIELD_LABELS` (import `src/shared/away-mode/labels.mjs` in `registry.mjs`).

- [ ] **Step 2: Run** the listed tests — Expected: FAIL on the new strings.
- [ ] **Step 3: Change the strings** in each file to exactly those in Step 1 (low-confidence analysis: `the agent was not sure enough; took the option easiest to undo. <rationale>`; invalid analysis choice: `the review picked "<x>", which is not an option; took the best-scored option. <rationale>`; recovery: `retry N of M after a pause` / `the step keeps failing; pausing`).
- [ ] **Step 4: Run** the listed tests plus `node --test test/night*.test.mjs` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Away mode: plain wording for answers, pauses, the CLI and the team policy"`

---

### Task 9: Ask Worca — `get_away_mode`

**Files:**
- Modify: `src/core/ask/tools.mjs` (defs array ~356; handlers), `src/core/ask/events.mjs` (label switch ~125), `src/core/ask/prompt.mjs:18` (tool list), `src/core/claude-runner.mjs:1416` (mock allowed tools)
- Test: `test/ask-away-mode-tools.test.mjs`; update pinned tool-name lists in `test/ask-tools.test.mjs:377`, `test/ask-mcp-stdio.test.mjs:~142-153`, `test/ask-diff-comment-tools.test.mjs:~55-63`, `test/ask-policy-tools.test.mjs:84`

**Interfaces:**
- Consumes: Task 3 `describeAwayMode`, `describeRun`; `effectiveNightConfig`, `nightModeToggle` (read in the MCP child from WORCA_HOME/HOME).
- Produces: tool `get_away_mode({projectKey?, runId?})` → `{summary: string[], status, config, sources, run?: {state, pill, reason, minutes?}}`.

- [ ] **Step 1: Failing test** `test/ask-away-mode-tools.test.mjs` (use `createAskTools` like `test/ask-policy-tools.test.mjs` does):

```js
test('get_away_mode returns the same summary lines the Settings card shows', async () => {
  await setNightMode({ window: '22:00-07:00', timeZone: 'UTC' });
  // Build the tools and call a handler exactly the way test/ask-policy-tools.test.mjs does;
  // `call` below stands for that helper. `now` is injected through deps.now.
  const out = await call('get_away_mode', {}, { now: () => Date.parse('2026-09-28T15:00:00Z') });
  const card = describeAwayMode({ config: resolveNightConfig({ user: { window: '22:00-07:00', timeZone: 'UTC' } }).config, toggle: 'auto', now: Date.parse('2026-09-28T15:00:00Z') });
  assert.deepEqual(out.summary, card.lines);
  assert.equal(out.status, 'here');
});
test('get_away_mode with runId adds the run line from its saved state', async () => { /* seed a pipeline row whose state.night = {optIn:true, override:'auto', openedAt:<15:00Z>} and assert out.run.state === 'after' */ });
```

Fill the second test with `seedPipeline(dir, { night: { optIn: true, override: 'auto', decisions: 0, flagged: 0, openedAt: '2026-09-28T15:00:00.000Z' } })` from `test/helpers/db-seed.mjs` and `get_away_mode({ runId: pid })`.

- [ ] **Step 2: Run** — Expected: FAIL (unknown tool).
- [ ] **Step 3: Implement.** Def entry (after `get_team_policy`):

```js
    { name: 'get_away_mode',
      description: 'Read Away mode — whether worca answers a waiting run question for the user, and when. Returns `summary`: the plain-English lines the user sees at the top of Settings › Away mode (status, away hours, which runs, the marked-runs-by-day rule, kinds that always wait), plus the effective config and where each value comes from. With runId, `run` says whether that run\'s waiting question is answered now, after N minutes, or never, and why. Use it before answering any question about whether worca will answer for the user; quote the summary lines rather than paraphrasing. Read-only.',
      inputSchema: SCHEMA.obj({ projectKey: SCHEMA.s('project key; omit for the user\'s own settings (or the pinned project)'), runId: SCHEMA.s('run id or pipeline id') }) },
```

Handler: resolve `projectDir` from `projectKey` (or the pinned scope) with the same helper `get_team_policy` uses; `const { config, sources } = projectDir ? effectiveNightConfig(projectDir) : resolveNightConfig({ user: nightModeSettings() });` `const toggle = nightModeToggle(); const now = (deps.now || Date.now)();` → `describeAwayMode({config, toggle, now, projectName})`; with `runId`: `const row = await resolveRow(input, 'get_away_mode')`, read `st.night` from the row's state (the same accessor `shapeRun` uses), `describeRun({config, toggle, now, run: {...st.night, done: ['done','stopped','error'].includes(row.status)}})`. Label: `case 'get_away_mode': return 'Reading Away mode';`. Add the name to `prompt.mjs` rule 1 list and the mock's allowed tools; update the pinned lists and the tool count test.

- [ ] **Step 4: Run** the new test and the pinned-list tests — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "Ask Worca: get_away_mode reads Away mode in the user's words"`

---

### Task 10: Ask Worca — `set_away_now` and `set_run_away_mode` (act immediately)

**Files:**
- Create: `src/core/ask/away-deps.mjs` (`createAwaySwitch`)
- Modify: `src/core/ask/tools.mjs` (defs + handlers), `src/core/ask/events.mjs` (label switch; a result hook like `track_run`'s at ~642), `src/core/ask/turn.mjs` (`_onAwaySwitch`, wired like `_onTrackRun` ~251/514), `ui/server.mjs` (turn deps ~7513: `awaySwitch`), `src/core/ask/prompt.mjs` (tool list + one rule), `src/core/claude-runner.mjs:1416`
- Test: `test/ask-away-mode-tools.test.mjs`, `test/ask-away-switch.test.mjs`, `test/ask-events.test.mjs`, `test/ask-turn.test.mjs`, pinned tool lists

**Interfaces:**
- Produces (child): `set_away_now({mode:'away'|'back'|'pause'})` → `{ok:true, requested:{kind:'global', toggle:'on'|'auto'|'off'}}`; `set_run_away_mode({runId, mode:'auto'|'on'|'off'})` → `{ok:true, requested:{kind:'run', runId, pipelineId, mode}}`. The child only validates; the parent applies.
- Produces (parent): turn dep `awaySwitch(requested, {threadId, actor}) → Promise<{ok:true, line:string}|{ok:false, error:string}>`; the turn adds a `notice` block `Away mode: <line>` or `Could not change Away mode on this run: <error>`.

- [ ] **Step 1: Failing tests.**
  - tools: `set_away_now({mode:'away'})` returns `{ok:true, requested:{kind:'global', toggle:'on'}}`; bad mode throws `AskToolError` naming the allowed values; `set_run_away_mode` with an unknown run id throws `set_run_away_mode: no run "<id>"`.
  - events: a `mcp__worca__set_away_now` tool result calls `onAwaySwitch({input, text, isError})`.
  - turn: `_onAwaySwitch` with `deps.awaySwitch` resolving `{ok:true, line:'Right now you count as away …'}` adds the notice `Away mode: Right now you count as away …`; resolving `{ok:false, error:'the run is done'}` adds `Could not change Away mode on this run: the run is done` (Review Focus 4).
  - apply (`test/ask-away-switch.test.mjs`): `createAwaySwitch({ runs, emitChanged, now })` from `src/core/ask/away-deps.mjs`, with a fake `runs` Map holding one live and one done fake orchestrator (`{ runId, projectDir, title, orch: { state: { status, night }, setNightOverride, nightConfigChanged } }`): `({kind:'global', toggle:'on'})` sets `nightModeToggle` to `on`, calls `emitChanged('settings-changed', 'ask')` and every `nightConfigChanged()`, and returns the new status line; `({kind:'run', runId:<done run>})` returns `{ok:false, error:'the run is done'}` (the fake `setNightOverride` throws `{code:'NIGHT_NOT_LIVE'}`).

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Child tools** in `tools.mjs`:

```js
    { name: 'set_away_now',
      description: 'Switch the user\'s global Away mode status NOW, when the user asks ("I\'m leaving, take over", "I\'m back", "pause it"). mode: "away" = I\'m away now (worca answers on every run until told "back"), "back" = follow the away hours again, "pause" = answer nothing, on any run, until turned back on. It is applied as soon as this call returns; a line in the chat confirms it. Reversible.',
      inputSchema: SCHEMA.obj({ mode: SCHEMA.s('away | back | pause') }, ['mode']) },
    { name: 'set_run_away_mode',
      description: 'Set Away mode on ONE live run, when the user asks. mode: "auto" = as set up (follows Settings and whether the run was marked), "on" = answer for me now on this run, at any hour, even when paused, "off" = never on this run. Applied as soon as this call returns; a line in the chat confirms it, or says why not (a finished run cannot change). Reversible.',
      inputSchema: SCHEMA.obj({ runId: SCHEMA.s('run id or pipeline id'), mode: SCHEMA.s('auto | on | off') }, ['runId', 'mode']) },
```

Handlers:

```js
    async set_away_now(input) {
      const map = { away: 'on', back: 'auto', pause: 'off' };
      const toggle = map[str(input.mode)];
      if (!toggle) throw new AskToolError('set_away_now: mode must be "away", "back" or "pause"');
      return { ok: true, requested: { kind: 'global', toggle } };
    },
    async set_run_away_mode(input) {
      const mode = str(input.mode);
      if (!['auto', 'on', 'off'].includes(mode)) throw new AskToolError('set_run_away_mode: mode must be "auto", "on" or "off"');
      const row = await resolveRow(input, 'set_run_away_mode');
      return { ok: true, requested: { kind: 'run', runId: str(input.runId), pipelineId: row.id, mode } };
    },
```

`resolveRow` must throw `set_run_away_mode: no run "<id>"` for an unknown id (reuse its existing message format; adjust the test to it if it differs).

- [ ] **Step 4: Parent hook.** `events.mjs`: add `onAwaySwitch = null` to `createTurnReducer` params and, next to the `track_run` block:

```js
      if ((b.name === 'mcp__worca__set_away_now' || b.name === 'mcp__worca__set_run_away_mode') && typeof onAwaySwitch === 'function') {
        try {
          const ret = onAwaySwitch({ toolUseId: b.id, input: fullInputs.get(b.id) ?? {}, text, isError: !!c.is_error });
          if (ret && typeof ret.then === 'function') pendingHooks.push(ret.then(() => {}, () => { reducerErrors += 1; }));
        } catch { reducerErrors += 1; }
      }
```

Labels: `case 'set_away_now': return 'Switching Away mode';` `case 'set_run_away_mode': return 'Setting Away mode on a run';`.
`turn.mjs`: wire `onAwaySwitch: ({ text, isError }) => this._onAwaySwitch(text, isError)` and add:

```js
  /** set_away_now / set_run_away_mode RESULT: the child validated; the parent owns settings and live runs. */
  async _onAwaySwitch(text, isError) {
    if (isError || typeof this.deps.awaySwitch !== 'function') return;
    let req = null;
    try { req = JSON.parse(text)?.requested || null; } catch { req = null; }
    if (!req) return;
    let r;
    try { r = await this.deps.awaySwitch(req, { threadId: this.threadId }); }
    catch (err) { r = { ok: false, error: err?.message || String(err) }; }
    this.reducer.addBlock({ kind: 'notice', text: r?.ok ? `Away mode: ${r.line}` : `Could not change Away mode${req.kind === 'run' ? ' on this run' : ''}: ${r?.error || 'unknown error'}` });
    this._persistBlocks();
  }
```

Add `awaySwitch: deps.awaySwitch ?? null,` to the turn's deps normaliser (next to `trackRun`).

- [ ] **Step 5: Apply function.** Create `src/core/ask/away-deps.mjs` (Task 11 adds the card's apply to the same file) with `createAwaySwitch({ runs, emitChanged, now = Date.now })` returning `async (req, { actor = 'ask' } = {}) => …` — the body below, with `runs`, `emitChanged` and `now()` taken from the factory arguments. In `ui/server.mjs` create it once (`const askAwaySwitch = createAwaySwitch({ runs, emitChanged });`) next to the other ask helpers.

```js
async function applyAwaySwitch(req, { actor = 'ask' } = {}) {   // inside createAwaySwitch
  if (req.kind === 'global') {
    await setNightModeToggle(req.toggle);
    emitChanged('settings-changed', 'ask');
    for (const e of runs.values()) e.orch?.nightConfigChanged?.();
    const { config } = resolveNightConfig({ user: nightModeSettings() });
    return { ok: true, line: describeAwayMode({ config, toggle: nightModeToggle(), now: Date.now() }).lines[0] };
  }
  const entry = [...runs.values()].find((e) => e.runId === req.runId || e.orch?.pipeline?.id === req.pipelineId);
  if (!entry) return { ok: false, error: 'the run is not live' };
  try { entry.orch.setNightOverride(req.mode, actor); }
  catch (err) { return { ok: false, error: err?.code === 'NIGHT_NOT_LIVE' ? `the run is ${entry.orch.state.status}` : err.message }; }
  const { config } = effectiveNightConfig(entry.projectDir);
  const d = describeRun({ config, toggle: nightModeToggle(), now: Date.now(), run: entry.orch.state.night || {} });
  return { ok: true, line: `on run ${entry.title || entry.runId}: ${d.pill}` };
}
```

Pass it into the turn deps at ~7513: `awaySwitch: (req) => askAwaySwitch(req, { actor: askActorOf(id) }),` using the same actor helper other ask writes use (search `actor` near `onScheduleMutation`; if none, pass `'ask'`). Note `setNightOverride` refuses finished runs with `NIGHT_NOT_LIVE` (existing). For a finished run that is still in `runs`, the error text becomes `the run is done` / `stopped` / `error`.

- [ ] **Step 6: Prompt.** `prompt.mjs`: add both names to rule 1; add a rule: `Away mode: read it with get_away_mode before saying whether worca will answer for the user. When the user says they are leaving / back / want it paused, call set_away_now; for one run, set_run_away_mode. These act immediately — confirm with the line the chat shows. Stored settings change only through propose_away_mode_change.`

- [ ] **Step 7: Run** the listed tests + pinned lists — Expected: PASS.
- [ ] **Step 8: Commit** `git commit -am "Ask Worca: set_away_now and set_run_away_mode act immediately"`

---

### Task 11: Ask Worca — `propose_away_mode_change` card

**Files:**
- Create: `src/core/ask/away-proposal.mjs` (validator + event text)
- Modify: `src/core/ask/away-deps.mjs` (created in Task 10; add the card's apply and `defaultAwayDeps`)
- Modify: `src/core/ask/tools.mjs` (def + handler, group gated on `deps.away`), `src/core/ask/mcp-stdio.mjs:~71` (spread `defaultAwayDeps`), `src/core/ask/events.mjs` (label + `onAwayProposal` hook), `src/core/ask/turn.mjs` (`_onAwayProposal`, like `_onMetricsProposal` ~279-305), `src/core/ask/store.mjs:288` (card type allowlist), `ui/server.mjs` (`:7328` context types, `:7780-7782` event-turn map, cards route branch next to metrics ~7947), `ui/public/ask-panel.mjs` (`buildAwayCard`, dispatch ~3271-3296), `ui/public/style.css`, `src/core/ask/prompt.mjs` (rule 1, a rule like rule 14, `:341` types), `src/core/claude-runner.mjs:1416`
- Test: `test/ask-away-proposal.test.mjs`, `test/ask-api-away-cards.test.mjs`, `test/ui-ask-away-card.test.mjs`, pinned lists

**Interfaces:**
- Produces: `createAwayChangeValidator({readUser, readProject, projectOf, now}) → async (input) → {ok:true, card}|{ok:false, errors}`; card `{type:'away', level:'user'|'project', projectKey, projectName, set, unset, changes:[{field, label, before, after}], summary, before:string[], after:string[], note}`; `awayEventPrompt({cardId, state, card, result})`, `awayNoticeText(...)`; `applyAwayChange(card) → {ok:true, detail}` writing through `setNightMode` (user) or `writeNightModePrefs(projectKey, merged)` (project) exactly as `POST /api/settings` / `PATCH /api/config` do.

- [ ] **Step 1: Failing validator tests** `test/ask-away-proposal.test.mjs`:

```js
test('a user-level change builds a card with before/after summaries', async () => {
  const v = createAwayChangeValidator({ readUser: () => ({ window: '22:00-07:00', timeZone: 'UTC' }), readProject: () => ({}), projectOf: () => null, now: () => Date.parse('2026-09-28T15:00:00Z') });
  const r = await v({ level: 'user', set: { enabled: true } });
  assert.equal(r.ok, true);
  assert.equal(r.card.type, 'away');
  assert.deepEqual(r.card.changes, [{ field: 'enabled', label: 'Which runs', before: 'Only runs I marked', after: 'All runs' }]);
  assert.match(r.card.before[0], /runs you marked/);
  assert.match(r.card.after[0], /all runs/);
});
test('project level refuses the spend cap; bad values name the field', async () => {
  const v = createAwayChangeValidator({ readUser: () => ({}), readProject: () => ({}), projectOf: () => ({ key: 'p', name: 'P', path: '/p' }), now: () => 0 });
  assert.deepEqual((await v({ level: 'project', projectKey: 'p', set: { spendCapUsd: 3 } })).ok, false);
  const bad = await v({ level: 'user', set: { graceMinutes: 0 } });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /graceMinutes/);
});
test('event prompt and notice', () => {
  assert.equal(awayEventPrompt({ cardId: 'c1', state: 'applied', card: { summary: 'Which runs: All runs' } }), '[worca event] away card c1 applied; "Which runs: All runs"');
});
```

- [ ] **Step 2: Run** — Expected: FAIL.

- [ ] **Step 3: Implement `away-proposal.mjs`**: validate `level`, resolve the project via `projectOf(projectKey)` (error `unknown project "<key>"`), run `validateNightPatch(set, {level})` (catch → `errors: [err.message]`), validate `unset` entries against `NIGHT_FIELDS`, compute `before = resolveNightConfig({project, user}).config` and `after` with the patch applied to the right layer, `changes` by comparing per field with display values (`enabled` → `WHICH_RUNS_OPTIONS` label; `window` → `22:00–07:00` or `No away hours`; `graceMinutes` → `N minutes` / `Never by day`; `neverDecide` → joined `kindLabel`s; others `String(v)`; unset → `(inherited)`), `summary` = `changes.map(c => \`${c.label}: ${c.after}\`).join('; ')`, and `{before, after} = describeChange(beforeCfg, afterCfg, {toggle, now})`. `awayEventPrompt` / `awayNoticeText` mirror `metricsEventPrompt` / `metricsNoticeText` with `away` in place of `metrics`.

- [ ] **Step 4: Implement `away-deps.mjs`**: `applyAwayChange(card)` re-validates with `validateNightPatch`, then user level: `await setNightMode({ ...current user layer, ...card.set, minus card.unset })`; project level: `writeNightModePrefs(card.projectKey, merged)`; returns `{ok:true, detail: describeAwayMode({...}).lines[0]}`. `defaultAwayDeps()` returns `{ away: { validateChange } }` built from real readers.

- [ ] **Step 5: Wire the pipeline** exactly like the metrics card (see `plans/away-mode-design.md` §6 and the reference files): tool def

```js
    ...(deps.away ? [{ name: 'propose_away_mode_change',
      description: 'Propose a change to the stored Away mode settings — away hours, time zone, which runs, marked-runs-by-day minutes, method, thresholds, limits, always-wait kinds — at user level or for one project (level "project" + projectKey; the spend cap is user-only). set: {field: value} with the stored field names (enabled, window "HH:MM-HH:MM" or null, timeZone, graceMinutes or null, strategy, minConfidence, minMargin, criteria, neverDecide, spendCapUsd, maxDecisions, maxExtraCycles, allowCostCapOverride); unset: [field] returns a field to inherited. It never changes anything itself: the user sees a card with the effect before and after and applies or declines it. Returns {ok:true, card} or {ok:false, errors} to fix and retry. Never claim a change was applied — the card says so when it happens. For the two live switches use set_away_now / set_run_away_mode instead.',
      inputSchema: SCHEMA.obj({ level: SCHEMA.s('user | project'), projectKey: SCHEMA.s('project key (level project)'), set: { type: 'object' }, unset: { type: 'array', items: { type: 'string' } }, note: SCHEMA.s('one-line reason shown on the card') }, ['level']) }] : []),
```

handler `async propose_away_mode_change(input) { if (!deps.away) throw new AskToolError('propose_away_mode_change: unavailable'); return deps.away.validateChange(input); }`; label `case 'propose_away_mode_change': return 'Proposing an Away mode change';`; events `onAwayProposal` hook (copy of the metrics block with the new name); turn `_onAwayProposal` (copy of `_onMetricsProposal`, re-validating with `validateAwayChange`, notice prefix `Away mode change rejected: `); `store.mjs:288` add `away`; server: `:7328` and `:7780-7782` add `away` → `awayEventPrompt`/`awayNoticeText`, and in the cards route a branch `if (card.type === 'away')` identical to the metrics branch with `applyAwayChange`, plus after a successful apply: `emitChanged('settings-changed', 'ask'); for (const e of runs.values()) e.orch?.nightConfigChanged?.();`; UI `buildAwayCard(block)` in `ask-panel.mjs` (copy `buildMetricsCard`'s states; title `Change Away mode?` + target `(your settings)` / `(project <name>)`; body **Now:** `before` lines, **After:** `after` lines, `Changed:` one line per `changes` entry `label: before → after`; buttons `Keep as is` (decline) / `Apply`; applied state `Saved. <result.detail>`), dispatch in `buildCard` and `isProgressBlock` exclusions; styles `.ask-acard` copying `.ask-mcard`; prompt rule 1 + a rule: `propose_away_mode_change for stored Away mode settings; never claim it was applied; "[worca event] away card <id> applied|declined|failed…" tells you.`; mock allowed tools.

- [ ] **Step 6: End-to-end test** `test/ask-api-away-cards.test.mjs` (copy `test/ask-api-metrics-cards.test.mjs`'s setup): a proposed away card applied through `POST /api/ask/threads/:id/cards/:cardId {state:'applied'}` changes `GET /api/away-mode`'s `config.enabled` and flips the card to `applied`; declined leaves settings untouched. UI test `test/ui-ask-away-card.test.mjs` (copy `test/ui-ask-metrics-card.test.mjs`): proposed card shows Now/After/Changed and both buttons.

- [ ] **Step 7: Run** the new tests, `test/ask-*.test.mjs`, `test/ui-ask-*.test.mjs` — Expected: PASS.
- [ ] **Step 8: Commit** `git add -A src/core/ask ui test && git commit -m "Ask Worca: propose_away_mode_change card with before/after"`

---

### Task 12: Wording guard, docs, full suite

**Files:**
- Create: `test/away-mode-wording.test.mjs`
- Modify: `README.md` / `docs/*` mentions of "night mode" the user reads (search `grep -rin "night mode" README.md docs/*.md docs-site 2>/dev/null`)
- Modify: `ui/public/index.html` any remaining "Night" strings in the Away mode card, run bar, New-run toggle

- [ ] **Step 1: Failing guard test:**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const BAD = [/\bnight\b/i, /\bgrace\b/i, /\beligible\b/i, /\bForce\b/, /\bstrategy\b/i];

test('Away mode UI strings use the glossary words only', () => {
  const html = read('ui/public/index.html');
  const card = html.slice(html.indexOf('id="night-settings-card"'), html.indexOf('</section>', html.indexOf('id="night-settings-card"')));
  const runBar = html.slice(html.indexOf('rd-night-wrap'), html.indexOf('</label>', html.indexOf('rd-night-wrap')));
  const newRun = html.slice(html.indexOf('id="night-row"'), html.indexOf('</label>', html.indexOf('id="night-row"')));
  const form = read('ui/public/night-mode-form.mjs').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const strings = [card, runBar, newRun, ...form.match(/(['"`])(?:(?!\1).)*\1/g)]
    .map((s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/class="[^"]*"|id="[^"]*"|data-[a-z-]+="[^"]*"|name="[^"]*"/g, ''));
  for (const s of strings) for (const bad of BAD) assert.doesNotMatch(s.replace(/\.night-[\w-]+|night-[\w-]+/g, ''), bad, s.slice(0, 120));
});
```

- [ ] **Step 2: Run** — Expected: FAIL on any leftover string; fix each in its file.
- [ ] **Step 3: Docs** — replace user-facing "night mode" with "Away mode" in README/docs, and add under the project's release notes (`docs/changelog` via the `worca-changelog` skill, or the README "What's new" section if that is where features are listed) the behaviour note from spec §3.2: *"Away mode (was night mode). By day, only runs you marked are answered after a question waits; 'All runs' now applies inside your away hours only. 'I'm away now' answers every run."*
- [ ] **Step 4: Full suite** `npm test` — Expected: all pass (known timing-only flakes: `wsmap-*` performance tests, `git-push-retry`; re-run those alone to confirm).
- [ ] **Step 5: Commit** `git commit -am "Away mode: wording guard, docs and release note"`
