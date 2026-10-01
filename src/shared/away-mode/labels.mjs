// src/shared/away-mode/labels.mjs — the plain words for every Away mode setting and state.
// Zero imports: served to the browser at /src/shared. Copy: plans/away-mode-wording.md §3.

export const KIND_LABELS = Object.freeze({
  clarify: 'Clarifying questions before planning',
  questions: 'Questions an agent asks mid-step',
  form: 'Input forms',
  gate: 'Fix again or continue, in a review loop',
  workflow: 'Approving a proposed workflow',
  recovery: 'A step failed: retry or give up',
  'cost-cap': "Continuing past the team's cost cap",   // a record kind only (run-harness.mjs), not in NIGHT_KINDS
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
  enabled: { label: 'Which runs', hint: '' },   // the radio options carry the hints; registry.mjs needs its own non-empty help
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

/** The end-of-run line every existing channel uses (chat, CLI, run pages): "5 answers while you were
 *  away — 2 to check", or null when Away mode gave no answer. `night` = the run's {decisions, flagged}. */
export function awayAnswersSummary(night) {
  const n = Math.max(0, Number(night && night.decisions) || 0);
  if (!n) return null;
  const m = Math.min(n, Math.max(0, Number(night.flagged) || 0));
  return `${n} answer${n === 1 ? '' : 's'} while you were away — ${m ? `${m} to check` : 'nothing to check'}`;
}
