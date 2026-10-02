// src/core/ask/away-proposal.mjs — propose_away_mode_change: validate a stored-settings change and build its
// confirm card (wording §3.7). Never writes; away-deps.mjs applyAwayChange does, behind the card's Apply.
import { validateNightPatch, resolveNightConfig, NIGHT_FIELDS } from '../night/config.mjs';
import { describeChange } from '../../shared/away-mode/describe.mjs';
import { FIELD_LABELS, WHICH_RUNS_OPTIONS, METHOD_OPTIONS, CRITERIA_LABELS, DECIDER_WORDS, kindLabel } from '../../shared/away-mode/labels.mjs';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const without = (o, keys) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !keys.includes(k)));
// eslint-disable-next-line no-control-regex
const BREAKS_RE = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;
const clip = (v, n) => String(v ?? '').replace(BREAKS_RE, ' ').slice(0, n);

/** One stored value in the user's words (the card's "Changed:" lines). */
export function fmtAwayValue(field, v) {
  switch (field) {
    case 'enabled': return WHICH_RUNS_OPTIONS.find((o) => o.value === (v === true)).label;
    case 'window': return v ? v.replace('-', '–') : 'No away hours';
    case 'timeZone': return v || "this computer's zone";
    case 'graceMinutes': return v == null ? 'Never by day' : `${v} minutes`;
    case 'strategy': return (METHOD_OPTIONS.find((o) => o.value === v) || {}).label || String(v);
    case 'criteria': return Object.entries(v || {}).map(([k, w]) => `${CRITERIA_LABELS[k] || k} ${w}`).join(', ');
    case 'neverDecide': return (v || []).length ? v.map(kindLabel).join(', ') : 'nothing';
    case 'spendCapUsd': return v == null ? 'No cap' : `$${v}`;
    case 'allowCostCapOverride': return v ? 'On' : 'Off';
    case 'deciderModel': return v || DECIDER_WORDS.sameAsRun;
    case 'deciderEffort': return v || DECIDER_WORDS.defaultEffort;
    default: return String(v);
  }
}

/**
 * @param {{layers:(dir:string|null)=>{project,user,team}, projectOf:(key:string)=>object|null|Promise<object|null>,
 *   toggle:()=>string, now:()=>number}} readers
 */
export function createAwayChangeValidator({ layers, projectOf, toggle, now }) {
  return async function validateAwayChange(input = {}) {
    const errors = [];
    const level = input.level === 'project' ? 'project' : input.level === 'user' ? 'user' : null;
    if (!level) return { ok: false, errors: ['level must be "user" or "project"'] };
    const set = isObj(input.set) ? input.set : {};
    const unset = Array.isArray(input.unset) ? [...new Set(input.unset.map(String))] : [];
    if (input.set !== undefined && !isObj(input.set)) errors.push('set must be an object of field → value');
    for (const f of unset) if (!NIGHT_FIELDS.includes(f)) errors.push(`unset: unknown field "${f}"`);
    for (const f of unset) if (f in set) errors.push(`${f} is both set and unset`);
    let clean = {};
    try { clean = validateNightPatch(set, { level }); } catch (err) { errors.push(err.message); }
    if (level === 'project' && unset.includes('spendCapUsd')) errors.push('spendCapUsd is set per user, not per project');
    let project = null;
    if (level === 'project') {
      const key = typeof input.projectKey === 'string' ? input.projectKey.trim() : '';
      project = key ? await projectOf(key) : null;
      if (!project) errors.push(key ? `unknown project "${key}"` : 'projectKey is required for level "project"');
    }
    if (!errors.length && !Object.keys(clean).length && !unset.length) errors.push('nothing to change: give set and/or unset');
    if (errors.length) return { ok: false, errors };
    const L = layers(project ? project.path : null);
    const beforeLayers = level === 'user' ? { user: L.user } : L;
    const patchLayer = (cur) => ({ ...without(cur, unset), ...clean });
    const afterLayers = level === 'user' ? { user: patchLayer(L.user) } : { ...L, project: patchLayer(L.project) };
    const b = resolveNightConfig(beforeLayers).config; const a = resolveNightConfig(afterLayers).config;
    const changes = [...Object.keys(clean), ...unset].map((f) => ({ field: f, label: FIELD_LABELS[f].label,
      before: fmtAwayValue(f, b[f]), after: `${fmtAwayValue(f, a[f])}${unset.includes(f) ? ' (inherited)' : ''}` }));
    const t = toggle(); const at = now();
    const { before, after } = describeChange(b, a, { toggle: t, now: at });
    const note = typeof input.note === 'string' ? input.note.trim().slice(0, 200) : '';
    return { ok: true, card: { type: 'away', level, projectKey: project ? project.key : null, projectName: project ? project.name : null,
      set: clean, unset, changes, summary: changes.map((c) => `${c.label}: ${c.after}`).join('; '), before, after, note } };
  };
}

const eventText = (s, n) => clip(s, n).replace(/"/g, "'").replace(/\[(\/?)worca context\]/gi, '($1worca context)');

/** `[worca event] …` — the synthetic turn's prompt after the user acted on an Away mode card. */
export function awayEventPrompt({ cardId, state, card = {}, result = null }) {
  const summary = eventText(card.summary, 160);
  if (state === 'declined') return `[worca event] away card ${cardId} declined; "${summary}"`;
  if (state === 'failed') return `[worca event] away card ${cardId} failed: ${eventText(result?.error || 'unknown error', 200)}; "${summary}"`;
  return `[worca event] away card ${cardId} applied; "${summary}"${result?.detail ? `; ${eventText(result.detail, 300)}` : ''}`;
}

/** The user-row notice above the event turn. */
export function awayNoticeText({ state, card = {}, result = null }) {
  const s = clip(card.summary, 120);
  if (state === 'declined') return `Declined — ${s}`;
  if (state === 'failed') return `Could not apply — ${s}: ${clip(result?.error || 'unknown error', 200)}`;
  return `Applied — ${s}${result?.detail ? ` · ${clip(result.detail, 200)}` : ''}`;
}
