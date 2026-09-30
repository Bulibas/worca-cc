# Away mode: wording and concept proposal for "night mode"

Scope: copy and concepts only. No code was changed. Stored settings, field names, layering
(project > user > team, empty = inherit) and the `--night` flag stay as they are.

Ground truth read: `src/core/night/activation.mjs`, `config.mjs`, `decider.mjs`,
`strategies.mjs`, `analysis.mjs`, `ui/public/night-mode-form.mjs`, the Night mode section of
`ui/public/index.html`.

---

## 1. Diagnosis: why both versions still confuse

The feature answers one question for the developer: **"If a run is waiting on me, will worca
answer instead, and when?"** Neither version lets them answer that after one read. Reasons:

### 1.1 "Night" means four different things
- the feature ("Night mode" card, `--night`),
- a time span ("Night window"),
- a per-run choice (New-run toggle "Night mode", run page select "Night"),
- a global eligibility setting ("Night mode: Not set / On / Off").

Worse, "night" says *time of day*, but the feature also fires at 15:00 (take-over, and the
30-minute rule on ticked runs). The name itself teaches the wrong model, so every daytime case
feels like an exception the developer has to memorise.

### 1.2 Three switches share the same words with different meanings
| Control | Options | What "On/Off/Auto" actually means |
|---|---|---|
| "Night mode" | Not set / On / Off | Which runs *may* be answered (all vs ticked only). "Off" is not "never": ticked runs are still answered. "Not set" is silently "Off". |
| "Right now" | Auto / Force on / Force off | Whether you count as *away right now*. "Force off" *is* "never" (for every run except one whose run switch says On). |
| Run page "Night" | Auto / On / Off | Per-run override. "Off" is "never on this run". "On" is "answer immediately, even if Right now = Force off". |

Same three words, three precedences, no visible order. "Auto" appears twice and follows
different things (the window in one, the tick + settings in the other).

### 1.3 Numbers without a subject
"Grace (minutes) 30" does not say *what* waits, *who* it waits for, or *when it applies*.
"Min confidence 60", "Min margin 25", "Extra review cycles 1", "Max decisions per run 20" are
tuning knobs shown at the same level as the basic switches, so the reader cannot tell which four
fields decide the outcome and which twelve merely shape it.

### 1.4 Jargon
"Eligible", "grace", "window", "strategy", "weights / analysis / mixed", "margin", "gate",
"recovery", "clarify", "matchesMemory". These are code names, not the developer's words.

### 1.5 The first redesign kept the structure that causes the confusion
It renamed well but:
- still had **three switches** ("Right now", "answer for", the run switch), with "Answer for me
  now" appearing on two of them with different scope;
- "**During** night hours, answer for: All runs / Only runs I tick" states the rule as
  time-bound, then the very next line ("Runs I tick: also answer during the day after 30
  minutes") contradicts it — the reader has to hold an exception in their head;
- "runs I **tick**" — tick where? The tick lives on another page (New run) and is called
  "Night mode" there, not "tick";
- "Don't answer **tonight**" implies it resets in the morning; it is sticky;
- the heading "When should worca answer for you?" is answered with hours only, but the honest
  answer has three triggers (hours, take-over, ticked-run wait).

### 1.6 Code vs decision B (for the implementer, not the copy)
`nightState()` sets `graceOn` for **every eligible run** (`config.enabled === true` makes an
unticked run eligible, so it also gets the 30-minute rule). Decision B says only ticked runs get
it. The copy below follows decision B; the code will need a one-line change, or the copy for
"All runs" must say "also after 30 minutes by day". Flagged so nobody writes a summary that lies.

---

## 2. The mental model

> **worca answers a waiting question when you are away and the run is allowed.**
> You are *away* during your away hours, or whenever you say "I'm away".
> A run is *allowed* if you allow all runs, or you marked that run when you started it.
> One extra rule: a **marked** run is also answered by day, once a question has waited 30 minutes.

Two yes/no questions ("Am I away?", "Is this run allowed?") plus one named exception that only
applies to runs you deliberately marked. Every label below is phrased so it clearly feeds one of
those three.

### Concept changes proposed (each marked against the agreed decisions)

| Change | Behaviour change vs decisions? |
|---|---|
| **Rename the feature "Night mode" → "Away mode"** everywhere the developer reads it. Storage keys, `nightMode` settings, `--night` stay; `--away` can be a CLI alias later. | None. Copy only. The feature genuinely triggers on *away*, not *night*, so the name stops contradicting the daytime rule. Fallback if the name must stay: keep "Night mode" as the card title only, and never use "night" for the hours, the tick, or the switches ("away hours", "marked runs", "I'm away now"). |
| **Merge "Night mode: Not set/On/Off" and the idea of ticking into one radio: "Which runs".** Options: *Only runs I marked* / *All runs*. Empty (inherit) is shown as "Only runs I marked (default)". | None. Same stored field `enabled`. |
| **Replace "Right now: Auto / Force on / Force off" with a status line + two buttons: "I'm away now" / "Pause until I turn it back on", and "Back to my away hours".** | None. Same three values (`auto`/`on`/`off`), but presented as a state you are in, not a mode you force. "Pause" is sticky exactly as today; the status line says so. |
| **Rename the per-run tick "marked".** New-run toggle: "Mark this run: worca may answer for me". Run page switch: "Away mode on this run". | None. |
| Optional, **not** in the decisions: time-bound take-over ("I'm away until 08:00"). | Would be new behaviour (auto-return to "follow hours"). Not needed for the success scenario; listed in §7 as a follow-up. |

Precedence, stated once and used everywhere (it matches `nightState()` today, where
`override 'off'` wins and `override 'on'` beats `toggle 'off'`):

**run "Never on this run" > run "Answer for me now" > global "Pause" > global "I'm away now"
> away hours + which runs > 30-minute rule for marked runs.**

---

## 3. Exact copy

Typography convention: `Label` — *one-line explanation shown under the field*.
`[value]` is an input. Sentences are short on purpose.

### 3.1 Settings card (user level)

**Card title:** `Away mode`
**Info tip:** *While you are away, worca answers the questions a run is waiting on: clarifying
questions, an agent's mid-step questions, input forms, "fix again or continue", workflow approval,
and "a step failed: retry or give up". Every answer is recorded with a reason. Unsure answers are
flagged for you to check.*

#### A. Live summary (always at the top, updates as you edit)

Rendered as one short paragraph. Templates (fill from the effective values; `{tz}` omitted when
it equals the browser zone):

Line 1, status, one of:
- `Right now it is {HH:MM} {tz}. You count as here. Next away hours start at {HH:MM}.`
- `Right now it is {HH:MM} {tz}. You count as away (your away hours). They end at {HH:MM}.`
- `Right now you count as away because you said "I'm away now". worca answers on every run until you click "I'm back".`
- `Away mode is paused. worca answers nothing until you turn it back on. (Marked runs wait too.)`
- `No away hours are set. worca only answers when you click "I'm away now"{, or on a marked run after a question has waited {N} minutes}.`

Line 2, schedule + which runs, one of:
- `From {from} to {to}, worca answers questions on runs you marked. Other runs wait for you.`
- `From {from} to {to}, worca answers questions on all runs.`

Line 3, the daytime rule, one of:
- `Outside those hours, a marked run is answered once a question has waited {N} minutes. Unmarked runs always wait.`
- `Outside those hours, every run waits for you.` (when "Never by day" is ticked)

Line 4 (only if any "Always wait for me" kind is ticked):
- `{Kind list} always wait for you, even when you are away.`

**Four worked examples** (settings: away hours 22:00–07:00, "Only runs I marked", 30 minutes,
status "Back to my away hours"):

| Clock | Run | What the summary lets you predict | Why |
|---|---|---|---|
| 15:00 | marked | Answered at ~15:30 if you have not answered by then. | Line 3: marked run, waited 30 min. |
| 15:00 | not marked | Waits for you. | Line 1: you count as here; line 3: unmarked runs always wait. |
| 23:00 | marked | Answered right away. | Line 1: away; line 2: marked runs answered. |
| 23:00 | not marked | Waits for you. | Line 2: "other runs wait for you". With "All runs" it would read "answered right away". |

Rendered example for those settings at 15:00:

> Right now it is 15:00. You count as here. Next away hours start at 22:00.
> From 22:00 to 07:00, worca answers questions on runs you marked. Other runs wait for you.
> Outside those hours, a marked run is answered once a question has waited 30 minutes. Unmarked runs always wait.

#### B. Right now (status strip directly under the summary)

Three states, shown as the status line above plus buttons:

| State (`toggle`) | Buttons shown |
|---|---|
| `auto` | `I'm away now` · `Pause away mode` |
| `on` | `I'm back` (returns to away hours) |
| `off` | `Turn away mode back on` (returns to away hours) |

Button tooltips:
- `I'm away now` — *worca answers on every run from now until you click "I'm back".*
- `Pause away mode` — *worca answers nothing, on any run, until you turn it back on. Your away hours are kept.*
- `I'm back` / `Turn away mode back on` — *Go back to following your away hours.*

#### C. Basic setup (open by default)

Section title: `When and where worca answers`

`Away hours` `[22:00]` to `[07:00]` `[time zone ▾]`
*During these hours you count as away. worca answers on the runs allowed below.*
Checkbox `No away hours` — *You only count as away when you click "I'm away now".*
Time zone hint: *Hours are read in this zone. Empty = this computer's zone.*

`Which runs` (radio)
- `Only runs I marked` — *Mark a run when you start it (New run → "Mark this run", or `--night`). Other runs wait for you.*
- `All runs` — *Every run is answered while you are away, marked or not.*

`Marked runs by day` `[30]` minutes
*Outside away hours, a marked run is still answered once a question has waited this long. Unmarked runs are never answered by day.*
Checkbox `Never by day` — *Marked runs wait for you outside away hours, like every other run.*

#### D. How worca picks an answer (collapsed)

`Method` (select)
- `Trust the agent when it is sure, otherwise weigh the options` (default; `mixed`)
- `Always trust the agent's recommendation` (`weights`)
- `Always weigh the options` (`analysis`) — *A separate read-only review scores each option.*
Field hint under the select: *Answers below the bar are still given, but flagged for you.*

`Trust the agent only if it is at least` `[60]` `% sure` — *Below this, worca weighs the options instead (or flags the answer).*
`…and its choice leads the next one by` `[25]` `points` — *A close call is not trusted.*

`What matters when weighing options` (0 = ignore, 10 = decisive)
- `Matches what you decided before` `[3]` (`matchesMemory`)
- `Easy to undo` `[3]` (`reversible`)
- `Changes the least` `[2]` (`smallestScope`)
- `Follows the codebase's conventions` `[2]` (`codebaseConventions`)
- `Costs the least` `[1]` (`cost`)

#### E. Limits (collapsed)

`Pause a run after` `[20]` `answers` — *When worca has answered this many times on one run, the run pauses and waits for you.*
`Extra fix rounds in a review loop` `[1]` — *When critical issues remain, worca may ask for this many more fix rounds. After that it continues and flags it.*
`Pause everything at` `$[ ]` `spent while away` — *Counted from the start of the current away stretch, across all projects. Not set = no cap.* (user/team only)
Checkbox `May exceed the team's cost cap` (`allowCostCapOverride`, off) — *Off: a run pauses at the team's soft cost cap while you are away. On: worca keeps going and flags it.*

#### F. Always wait for me (collapsed)

Title: `Always wait for me on…`
*Ticked kinds are never answered by worca, even while you are away. The run pauses on them.*
- `Clarifying questions before planning` (`clarify`)
- `Questions an agent asks mid-step` (`questions`)
- `Input forms` (`form`) — *A form asked as part of the two kinds above follows their tick too.*
- `Fix again or continue, in a review loop` (`gate`)
- `Approving a proposed workflow` (`workflow`)
- `A step failed: retry or give up` (`recovery`)

#### G. Footer
Buttons: `Use defaults` · `Save`. After save: *Saved. The summary above is what will happen.*

### 3.2 Project card differences

- Title: `Away mode for this project`
- Sub-line: *Anything left as "Same as my settings" uses your Settings page. Set a value here to override it for this project only.*
- Every field gets a leading option / placeholder `Same as my settings`. The live summary starts
  with `For {project}:` and marks overridden lines with `(this project)`.
- `Which runs` radio gains a first option `Same as my settings ({Only runs I marked | All runs})`.
- The spend cap is **not shown**; in its place: *The spend cap is set once for you, not per project, because it counts spending across every run.*
- The status strip (I'm away now / Pause) is **not** repeated here; one line instead:
  *"I'm away now" and "Pause" are global. Change them in Settings › Away mode.*
- Team-provided values show `(team default)` after the value.

### 3.3 Run page switch

Label: `Away mode on this run` (select)
- `As set up` (`auto`) — tooltip: *Follows Settings and whether you marked this run.*
- `Answer for me now` (`on`) — tooltip: *worca answers this run's questions from now on, at any hour, even if away mode is paused.*
- `Never on this run` (`off`) — tooltip: *worca never answers on this run, whatever the settings.*

Select tooltip (whole control): *Overrides Settings › Away mode for this run only.*
Beside it, a one-word state pill fed by the same summary logic: `answering` / `waiting for you` /
`answers after {N} min` / `never`.

### 3.4 New-run form toggle

`Mark this run: worca may answer for me`
Hint: *While you are away (Settings › Away mode: {from}–{to}, or "I'm away now"), worca answers this run's questions. By day it also answers once a question has waited {N} minutes.*
Hint when "All runs" is on: *Your settings already allow every run while you are away. Marking adds the {N}-minute rule by day.*
Hint when away mode is paused: *Away mode is paused: even a marked run waits for you until you turn it back on.*

### 3.5 CLI `--night` help line

```
--night        Mark this run: worca may answer its questions while you are away
               (your away hours or "I'm away now"), and by day once a question has
               waited 30 min. Configure in Settings > Away mode.
```

### 3.6 Flagged-decision and pause messages

Decision list entry, normal: `Answered for you: "{choice}" — {rationale}.`
Flagged: `Answered for you, please check: "{choice}" — {rationale}.` with the list header
`{n} answers, {m} to check`.

Specific rationale strings (replacing today's):
- `recommended at 82% (lead 30)` → `the agent recommended this at 82%, well ahead of the next option`
- `recommendation below threshold: first option taken` → `the agent was not sure enough; first option taken`
- `analysis unavailable: …` → `could not weigh the options ({reason}); first option taken`
- `question has no options` → `free-text question; worca cannot answer it`
- review loop: `no critical issues remain` → `no critical issues left, continuing`;
  `N critical issue(s): one more cycle` → `N critical issues left, one more fix round`;
  `… budget is spent` → `N critical issues left but the extra fix rounds are used up; continuing`
- workflow: `accepted as proposed` → `workflow accepted as proposed`; tight budget → `workflow accepted; {pct}% of the away spend cap used`

Pause banners on the run page:
- `Paused: worca answered {N} times on this run, the limit you set. Resume to continue, or raise the limit in Settings › Away mode › Limits.`
- `Paused: spending while away reached ${cap}. Resume to continue, or raise the cap.`
- `Paused: the step failed {N} times. worca does not retry further while you are away.`
- `Paused: the team's cost cap was reached. Away mode is not allowed to exceed it.`
- `Waiting for you: this is a "{kind label}" and you asked worca to always wait on those.`

### 3.7 Ask Worca tools

**`get_night_mode`**
Description (for the model): *Returns the plain-English summary of Away mode exactly as the user
sees it in Settings: current status (here / away / "I'm away now" / paused), away hours and time
zone, which runs are allowed, the marked-runs-by-day rule, any kinds that always wait, and the
limits. With `runId`, also states for that run whether a waiting question would be answered now,
after N minutes, or never, and why. Use it before answering any question about whether worca
will answer for the user.*

**`set_night_now`** (direct, no confirm card)
Description: *Switches the global status. `mode`: "away" (= "I'm away now": answer on every run
until told "back"), "back" (follow away hours), or "pause" (answer nothing until turned back on).
Acts immediately. Reply to the user with the new status line from get_night_mode.*
Chat confirmation line after acting: `Done — {status line}.`

**`set_run_night`** (direct, no confirm card)
Description: *Sets Away mode on one run. `runId`; `mode`: "auto" (as set up), "on" (answer for
me now on this run, at any hour, even when paused), "off" (never on this run). Acts immediately.*
Chat line: `Done — on run {name}: {answering now | waiting for you | answers after N min | never}.`

**`propose_night_mode_change`** (confirm card)
Description: *Proposes a change to the stored Away mode settings (away hours, time zone, which
runs, marked-runs-by-day minutes, method, thresholds, limits, always-wait kinds) at user or
project level. Never applies it; shows the user a card with the effect before and after. Use for
anything that persists; use set_night_now / set_run_night for the two live switches.*

Confirm card:
> **Change Away mode?** ({user settings | project {name}})
> **Now:** {current summary lines 2–3}
> **After:** {proposed summary lines 2–3, changed words highlighted}
> Changed: {field label}: {old} → {new} (one line per field)
> `[Apply]` `[Keep as is]`
After apply: `Saved. {new status line}.`

---

## 4. Reads-top-to-bottom test

Developer opens Settings › Away mode with: hours 22:00–07:00, "Only runs I marked", 30 min,
status "Back to my away hours". Time is 15:00.

1. **Summary** (3 lines) — they read: here now; 22:00–07:00 marked runs are answered, others
   wait; by day a marked run is answered after 30 minutes, unmarked never.
   → They can already answer all four cells of the table: 15:00 marked = answered at 15:30;
   15:00 unmarked = waits; 23:00 marked = answered; 23:00 unmarked = waits.
2. **Right now strip** — two buttons, both named by what they do to *them* ("I'm away now",
   "Pause"). No "Auto", no "Force".
3. **Away hours** — the field's own hint repeats line 2 of the summary in the same words.
4. **Which runs** — the radio's hint tells them *where* marking happens. If they flip to
   "All runs", the summary's line 2 changes to "on all runs" and the 23:00 unmarked cell flips to
   "answered". They see the cause and the effect on the same screen.
5. **Marked runs by day** — the only field with a number; its label carries the subject
   ("marked runs"), the condition ("by day"), and the effect ("still answered once a question has
   waited this long"). Ticking "Never by day" changes summary line 3 to "every run waits".
6. Everything below is collapsed and titled by its question ("How worca picks an answer",
   "Limits", "Always wait for me on…"). None of it changes *whether* a question is answered
   except the last, which the summary surfaces as line 4 when relevant.

Every word the developer meets on the run page ("Away mode on this run", "As set up") and on
New run ("Mark this run") is a word they already saw in the card. "Night" appears nowhere except
the `--night` flag, whose help line explains itself.

---

## 5. Glossary the whole product should stick to

| Say | Not |
|---|---|
| Away mode | Night mode, Nightshift, night-mode decider |
| away hours | night window, window |
| you count as away / here | active, eligible, armed |
| I'm away now / I'm back / Pause away mode | Force on, Force off, Auto, take over |
| marked run / unmarked run | ticked, opted-in, eligible, `--night` run |
| Marked runs by day: N minutes | grace, grace timeout |
| answers / answered for you | decisions, decided |
| please check | flagged |
| Which runs: Only runs I marked / All runs | Night mode: Not set / On / Off |
| Always wait for me on… | Never decide |
| method: trust the agent / weigh the options | strategy: weights / analysis / mixed |

---

## 6. Things the implementer must know

- Decision B vs `nightState()`: `graceOn` is currently true for any eligible run (see §1.6).
  Either restrict it to `optIn === true` or change the "All runs" summary line to
  "…on all runs, and by day once a question has waited N minutes".
- The summary generator should be one function used by the Settings card, the project card,
  the New-run hint, the run page pill, and `get_night_mode`, so the four surfaces cannot drift.
- The run page pill and the New-run hint need `decideDelayMs()` (already pure) to say
  "answers after N min" honestly.
- `toggle 'off'` is sticky; the paused status line says so explicitly ("until you turn it back
  on"). If a time-bound pause is ever added, only that line changes.

## 7. Optional follow-ups (not required for the success scenario)

- `I'm away until [08:00]` as a third button: auto-returns to away hours. New behaviour.
- `--away` as a CLI alias for `--night`.
- Show "answers after 12 min" countdown on a waiting question's card.
