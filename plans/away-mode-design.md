# Away mode: configuration redesign

Date: 2026-09-30. Branch: `worca-cc/night-mode-decider`.
Companion: [`plans/away-mode-wording.md`](away-mode-wording.md). Its §3 is
the exact copy for every surface and is part of this spec; where the two differ, this spec wins.

## 1. Problem and goal

Night mode works, but its configuration is confusing. "Night" names four different things, three
switches reuse Auto/On/Off with different meanings, and numbers such as "Grace 30" say nothing
about what they do. Worse, the 30-minute grace timer quietly answers questions by day.

**Success:** the developer opens Settings › Away mode, reads it top to bottom once, and correctly
predicts whether a question waiting at 15:00 or at 23:00 is answered, for a marked run and for an
unmarked one. Ask Worca gives the same answer, in the same words.

## 2. Decisions (agreed with the developer)

| # | Decision |
|---|---|
| D1 | Rename the feature **Away mode** in everything the developer reads. Stored keys (`nightMode`, `nightModeToggle`, `night_decisions`, `night.*` policy keys), the `--night` flag and code names stay. No migration. |
| D2 | Mental model: **worca answers a waiting question when you are away and the run is allowed.** Away = inside your away hours, or after "I'm away now". Allowed = "All runs", or you marked the run when you started it. |
| D3 | By day (outside away hours, no "I'm away now"), questions wait for you, **except on marked runs**: those are answered once a question has waited N minutes (default 30). Unmarked runs are never answered by day. |
| D4 | All three usage styles are first-class: fixed away hours; "I'm away now" / "I'm back" by hand; marking a run when starting it. |
| D5 | Every setting explains its effect in plain words; the card opens with a live summary of the combined effect. Basic setup first; method, limits and always-wait kinds are collapsed below. |
| D6 | The run page switch and the New-run toggle carry explanations, from the same summary logic. |
| D7 | Ask Worca can read Away mode, flip the two live switches **immediately** (no card), and propose stored-settings changes through a confirm card. |
| D8 | Layering stays per field: project > user > team, empty = inherit. |

## 3. Behaviour

### 3.1 Precedence (first matching row wins)

| # | Condition | Result |
|---|---|---|
| 1 | Run switch = **Never on this run** (`override 'off'`) | never answered |
| 2 | Run switch = **Answer for me now** (`override 'on'`) | answered now, at any hour, even when paused |
| 3 | Global status = **Paused** (`toggle 'off'`) | waits for you |
| 4 | Global status = **I'm away now** (`toggle 'on'`) | answered now, **every run** |
| 5 | Inside away hours, and the run is allowed ("All runs", or marked) | answered now |
| 6 | Outside away hours, marked run, question waited ≥ N minutes | answered |
| 7 | Anything else | waits for you |

The question kind being on "Always wait for me on…" (`neverDecide`) overrides every row: it waits.
Limits (max answers per run, spend cap) still pause the run as today.

### 3.2 Changes to today's engine (`nightState` / `decideDelayMs`)

| Today | After |
|---|---|
| The grace timer applies to **every eligible run** (a run is eligible when `enabled` is on, it opted in, or its switch is on). | The by-day timer applies **only to marked runs** (`optIn === true`) — D3. |
| `toggle 'on'` ("Force on now") answers only eligible runs; with `enabled` off, unmarked runs still wait. | `toggle 'on'` ("I'm away now") answers **every run** — row 4. |
| `enabled` ("Night mode: On") makes every run eligible at any time, via the grace timer. | `enabled` ("Which runs: All runs") only widens row 5: every run is allowed **inside away hours**. |

Unchanged: the run's own `override`, `toggle 'off'` being sticky, the window arithmetic, guardrails,
the strategies and their thresholds, `neverDecide` semantics (including form origin), and every
stored value. A user who had `enabled: true` and relied on daytime answers must now mark the run
or click "I'm away now"; the release note says so.

### 3.3 Paused status reads honestly

`toggle 'off'` stays sticky. Its status line says "until you turn it back on". No time-bound
pause and no "I'm away until…" in this change (see §9).

## 4. Architecture

### 4.1 Units

| Unit | Where | Does | Depends on |
|---|---|---|---|
| Activation math | `src/shared/away-mode/activation.mjs` (moved from `src/core/night/activation.mjs`, which re-exports it) | `inWindow`, `msUntilWindowStart`, `nightState`, `decideDelayMs`, `nightAnchorMs`. Pure, `now` passed in. Changes of §3.2 land here. | nothing |
| Summary generator | `src/shared/away-mode/describe.mjs` (new) | `describeAwayMode({config, sources?, toggle, now, run?, projectName?})` → `{status, lines[], run?}`: the card summary (proposal §3.1 A), the per-run pill state and reason, and the before/after text for a card. Pure; all copy lives here. | activation math |
| Labels | `src/shared/away-mode/labels.mjs` (new) | Plain labels for kinds, methods, criteria, fields (proposal §3.1 D–F, §5 glossary). Used by the form, the summary, the decisions list and the tools. | nothing |
| Config resolution | `src/core/night/config.mjs`, `effective.mjs` (unchanged) | Defaults, validation, layering. | — |
| Settings/project form | `ui/public/night-mode-form.mjs` (rewritten) | Renders proposal §3.1 C–G / §3.2 and reads a patch back; recomputes the live summary on every input via `describeAwayMode` over (form values ⊕ inherited effective config). | shared modules |
| Run page + New-run | `ui/public/app.js`, `index.html`, `style.css` | Run switch labels, tooltip and state pill; New-run toggle label and hint; decisions list and pause-banner copy. | shared modules |
| Ask Worca tools | `src/core/ask/tools.mjs`, `tool-deps.mjs` | Four tools (§6). | describe, labels |

`src/shared/**` is already served to the browser (`/src/shared`) and imported by the server, so
one generator feeds every surface and they cannot drift.

### 4.2 Data the surfaces need

- **Global:** `GET /api/away-mode?projectDir=` (new) → `{config, sources, toggle, user, project?}`:
  the effective config (with the team layer when a project is given), the per-field source, the
  live status, and the raw layer values for the form. The browser caches it and refetches on
  `settings-changed` (already emitted when settings or project prefs change).
- **Per run:** the run snapshot's `night` gains `openedAt` (ISO time the open question was armed,
  or null), so the pill can say "answers after N min" with `decideDelayMs`. Existing keys
  (`optIn`, `override`, `decisions`, `flagged`) stay.
- Writes reuse today's endpoints: `POST /api/settings` (`nightMode`, `nightModeToggle`),
  `PATCH /api/config` (project `nightMode`), `POST /api/run/night` (run switch).

## 5. Surfaces (copy: proposal §3)

1. **Settings card** (Runs tab): title "Away mode"; live summary; status strip with **I'm away
   now / Pause away mode / I'm back / Turn away mode back on** buttons (replacing the "Right now"
   select); "When and where worca answers" (away hours + time zone + "No away hours"; Which runs
   radio; Marked runs by day [N] + "Never by day"); collapsed "How worca picks an answer",
   "Limits" (including the `allowCostCapOverride` checkbox, now exposed), "Always wait for me on…".
   Empty fields show "(default)" or "(team default)" and the value that applies.
2. **Project card:** proposal §3.2 — "Same as my settings (…)" as the empty choice everywhere, no
   status strip (one line pointing to Settings), no spend cap (one line why), summary prefixed
   "For {project}:".
3. **Run page switch:** "Away mode on this run": As set up / Answer for me now / Never on this run,
   with option tooltips and a state pill (`answering` / `waiting for you` / `answers after N min` /
   `never`), shown on any run that is not over.
4. **New-run toggle:** "Mark this run: worca may answer for me", with the hint variants of §3.4
   picked by the summary generator.
5. **Decisions list and pause banners:** proposal §3.6 wording; rationale strings produced by
   `strategies.mjs` / `decider.mjs` change to the plain versions.
6. **CLI:** `--night` help line of §3.5; the CLI's "night mode answered …" line becomes
   "Away mode answered …".
7. **Team policy view:** labels for `night.*` fields from `labels.mjs`.

## 6. Ask Worca tools

| Tool | Kind | Input | Returns / does |
|---|---|---|---|
| `get_away_mode` | read | `projectKey?`, `runId?` | `{summary: string[], status, config, sources, run?: {state, reason, answersAfterMin?}}` from `describeAwayMode`. |
| `set_away_now` | **acts** | `mode: 'away' \| 'back' \| 'pause'` | Sets `nightModeToggle` to `on` / `auto` / `off`; audit line names the chat's user; returns the new status line. |
| `set_run_away_mode` | **acts** | `runId`, `mode: 'auto' \| 'on' \| 'off'` | Calls the run's `setNightOverride(mode, actor)`; refused on a finished run (existing `NIGHT_NOT_LIVE`); returns the run's new pill text. |
| `propose_away_mode_change` | card | `level: 'user' \| 'project'`, `projectKey?`, `set: {field: value}`, `unset: [field]` | Validates with `validateNightPatch` (project level rejects the spend cap), builds the confirm card of proposal §3.7 with before/after summaries; never applies it. |

Tool descriptions: proposal §3.7, with the tool names above. Tools read and write through the same
functions as the HTTP routes; no new write path.

## 7. Error handling

- Invalid stored values are already dropped by `cleanLayer`; the summary describes what applies.
- A time zone the browser cannot resolve falls back to the host zone, and the summary says which
  zone it used.
- `propose_away_mode_change` returns `{ok:false, errors}` naming the field, like the other
  propose tools; `set_run_away_mode` on an unknown or finished run returns an error, not a card.
- The summary generator never throws: on missing data it says "Away mode settings could not be
  read" and the card still renders its fields.

## 8. Testing

- **activation (unit):** the §3.1 table as a truth table — each row × inside/outside hours ×
  marked/unmarked × `enabled` on/off, including: unmarked + `enabled` by day waits; `toggle 'on'`
  answers an unmarked run with `enabled` off; run `on` beats `toggle 'off'`.
- **describe (unit):** the four worked examples of proposal §3.1 A produce exactly the rendered
  lines; the "No away hours", paused, "I'm away now", "Never by day" and always-wait variants; the
  per-run pill states; the before/after card text.
- **form (jsdom):** empty vs set vs explicit-off per field round-trips to the same patch as today;
  the summary updates on input; project card shows "Same as my settings (…)" with the inherited value.
- **status strip, run switch, New-run hint (jsdom):** buttons post the right `nightModeToggle`;
  the pill shows "answers after N min" from `openedAt`; the hint variants appear for paused /
  "All runs".
- **harness integration:** a marked run's question is answered after N minutes by day; an unmarked
  run with `enabled` on is not; "I'm away now" answers an unmarked run.
- **Ask tools:** `get_away_mode` text equals the card summary for the same state; the two act tools
  change state and audit the actor; `propose_away_mode_change` returns a card and applies nothing,
  and rejects a project-level spend cap.
- **Wording guard:** a test scans the Away mode UI strings (form, index.html card, run switch,
  New-run toggle) for "night", "grace", "eligible", "Force", "strategy" and fails on any hit.

## 9. Out of scope

- "I'm away until [08:00]" and any time-bound pause.
- A `--away` CLI alias.
- Renaming stored keys, code identifiers or the `night_decisions` table.
- A countdown on the waiting question's card.
