// ui/public/night-mode-form.mjs — the Away mode fields (src/core/night/config.mjs), shared by
// the global Settings card (level 'user') and the project Overview card (level 'project').
// Pure DOM: renderNightForm builds the live summary and the inputs, readNightForm reads them back
// into a patch. A field left empty is "not set here": it is sent as `__unset` so the next layer applies.
// Every word comes from src/shared/away-mode (labels.mjs, describe.mjs); copy: plans/away-mode-wording.md §3.
import { FIELD_LABELS, METHOD_OPTIONS, CRITERIA_LABELS, KIND_LABELS, WHICH_RUNS_OPTIONS } from '../../src/shared/away-mode/labels.mjs';
import { describeAwayMode } from '../../src/shared/away-mode/describe.mjs';

export const NIGHT_KINDS = ['clarify', 'questions', 'form', 'gate', 'workflow', 'recovery'];
export const CRITERIA = ['matchesMemory', 'reversible', 'smallestScope', 'codebaseConventions', 'cost'];
// Per-field input limits of the number fields ([min, max]).
const NUM_LIMITS = { graceMinutes: [1, 1440], minConfidence: [0, 100], minMargin: [0, 100], maxDecisions: [1, 500], maxExtraCycles: [0, 10] };
// Where an empty field's value comes from (the inherited layer's source).
const SOURCE_TAG = { default: '(default)', team: '(team default)', user: '(your setting)' };
// The project level's empty choice: never "(undefined)" when nothing is inherited yet.
const sameAs = (shown) => (shown == null || shown === '' ? 'Same as my settings' : `Same as my settings (${shown})`);
const CTX = new WeakMap();   // root → {level, inherited, toggle, offset, projectName}

function el(doc, tag, cls, text) {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** An explicit "off" (null) checkbox next to `inputs` — a choice distinct from "not set here". */
function offBox(doc, wrap, cls, text, checked, inputs) {
  const lab = el(doc, 'label', 'check-row'); const off = el(doc, 'input', cls); off.type = 'checkbox';
  off.checked = checked;
  const sync = () => { for (const i of inputs) i.disabled = off.checked; };
  sync(); off.addEventListener('change', sync);
  lab.append(off, ` ${text}`); wrap.append(lab);
}

function field(doc, label, hint) {
  const wrap = el(doc, 'div', 'field night-field');
  const row = el(doc, 'div', 'label-row');
  row.append(el(doc, 'label', null, label));
  wrap.append(row);
  if (hint) wrap.append(el(doc, 'small', 'hint', hint));
  return wrap;
}

/** The placeholder of an empty input: the inherited value (project level: "Same as my settings (…)"). */
const placeholderFor = (level, v) => (level === 'project' ? sameAs(v ?? null) : String(v ?? ''));

/** "(default)" / "(team default)" / "(your setting)" after a field not set at this level. */
function sourceHint(doc, wrap, values, inhSrc, f) {
  const tag = values[f] === undefined ? SOURCE_TAG[inhSrc[f]] : null;
  if (tag) wrap.append(el(doc, 'small', 'hint away-inherited', tag));
}

function numInput(doc, f, level, values, inh) {
  const [min, max] = NUM_LIMITS[f];
  const inp = el(doc, 'input', 'input input-mini night-num'); inp.type = 'number'; inp.min = String(min); inp.max = String(max); inp.step = '1';
  inp.dataset.field = f; inp.value = values[f] == null ? '' : String(values[f]);
  inp.placeholder = placeholderFor(level, inh[f]);
  return inp;
}

/** A number field: label, hint, `[prefix][input][ suffix]`, and where an empty value comes from. */
function numField(doc, f, level, values, inh, inhSrc, { suffix = '', prefix = '' } = {}) {
  const w = field(doc, FIELD_LABELS[f].label, FIELD_LABELS[f].hint);
  const inp = numInput(doc, f, level, values, inh);
  const row = el(doc, 'div', 'away-input-row');
  if (prefix) row.append(doc.createTextNode(prefix));
  row.append(inp);
  if (suffix) row.append(doc.createTextNode(` ${suffix}`));
  w.append(row);
  sourceHint(doc, w, values, inhSrc, f);
  return { wrap: w, input: inp };
}

/** A tri-state select: '' (not set here) / on / off. */
function triSelect(doc, cls, f, level, values, inhValue) {
  const sel = el(doc, 'select', cls); sel.dataset.field = f;
  const none = el(doc, 'option', null, level === 'project' ? sameAs(typeof inhValue === 'boolean' ? (inhValue ? 'On' : 'Off') : null) : 'Not set');
  none.value = ''; sel.append(none);
  for (const [v, t] of [['on', 'On'], ['off', 'Off']]) { const o = el(doc, 'option', null, t); o.value = v; sel.append(o); }
  sel.value = values[f] !== undefined ? (values[f] ? 'on' : 'off') : '';
  return sel;
}

// Called from renderNightForm with the normalised `inh`/`inhSrc`: both are always objects (never null),
// so the fallback paint's `inherited: {config: null}` cannot throw here. The group records whether the user
// set a value here: untouched at user level means "inherit", exactly like the old '' select option.
function whichRuns(doc, level, own, inh, inhSrc) {
  const wrap = field(doc, FIELD_LABELS.enabled.label, '');
  const grp = el(doc, 'div', 'away-which'); grp.setAttribute('role', 'radiogroup');
  grp.dataset.set = own === undefined ? '' : '1';
  const name = `away-which-${level}`;
  const known = typeof inh.enabled === 'boolean';                  // false when the fetch failed or has not answered
  const opts = level === 'project'
    ? [{ value: '', label: sameAs(known ? WHICH_RUNS_OPTIONS.find((o) => o.value === inh.enabled).label : null), hint: '' }, ...WHICH_RUNS_OPTIONS]
    : WHICH_RUNS_OPTIONS;
  const shown = own === undefined ? (level === 'project' ? '' : String(inh.enabled === true)) : String(own);
  for (const o of opts) {
    const lab = el(doc, 'label', 'away-radio'); const r = el(doc, 'input'); r.type = 'radio'; r.name = name; r.value = String(o.value);
    r.checked = r.value === shown;
    lab.append(r, ` ${o.label}`); grp.append(lab);
    if (o.hint) grp.append(el(doc, 'small', 'hint', o.hint));
  }
  if (own === undefined && level === 'user' && known) grp.append(el(doc, 'small', 'hint away-inherited', SOURCE_TAG[inhSrc.enabled || 'default']));
  grp.addEventListener('change', () => { grp.dataset.set = '1'; });
  wrap.append(grp);
  return wrap;
}

function details(doc, title) {
  const d = el(doc, 'details', 'away-adv');
  d.append(el(doc, 'summary', null, title));
  return d;
}

/**
 * Build the summary and the fields into `root` (replacing its content).
 * @param {HTMLElement} root
 * @param {{level:'user'|'project', values?:object, effective?:object, sources?:object,
 *   inherited?:{config:object|null, sources:object}, toggle?:string, now?:number, projectName?:string|null}} o
 *   values: the layer's own fields; effective/sources: what applies and where it comes from;
 *   inherited: what an EMPTY field falls back to (GET /api/away-mode), null config = unknown.
 */
export function renderNightForm(root, { level, values = {}, effective = {}, sources = {}, inherited = { config: effective, sources }, toggle = 'auto', now = Date.now(), projectName = null, statusEl = null }) {
  const doc = root.ownerDocument;
  root.replaceChildren();
  delete root.dataset.dirty;
  root.dataset.level = level;
  const inh = (inherited && inherited.config) || {};
  const inhSrc = (inherited && inherited.sources) || {};

  const summary = el(doc, 'p', 'away-summary'); summary.setAttribute('aria-live', 'polite');
  const body = el(doc, 'div', 'away-body');      // fresh on every render: its listeners never stack
  // statusEl: the Settings card's status buttons, kept right below the summary (moved, not copied:
  // the caller keeps the element and its click listener across renders).
  root.append(summary, ...(statusEl ? [statusEl] : []), body);

  // C. When and where worca answers (open).
  const basic = el(doc, 'div', 'away-basic');
  basic.append(el(doc, 'h3', null, 'When and where worca answers'));

  const win = field(doc, FIELD_LABELS.window.label, FIELD_LABELS.window.hint);
  const [ws, we] = typeof values.window === 'string' ? values.window.split('-') : ['', ''];
  const [iws, iwe] = typeof inh.window === 'string' ? inh.window.split('-') : [null, null];
  const start = el(doc, 'input', 'input input-mini night-window-start'); start.type = 'time'; start.value = ws || ''; start.placeholder = placeholderFor(level, iws);
  const end = el(doc, 'input', 'input input-mini night-window-end'); end.type = 'time'; end.value = we || ''; end.placeholder = placeholderFor(level, iwe);
  const winRow = el(doc, 'div', 'away-input-row');
  winRow.append(start, doc.createTextNode(' to '), end);
  win.append(winRow);
  sourceHint(doc, win, values, inhSrc, 'window');
  offBox(doc, win, 'night-window-off', 'No away hours', values.window === null, [start, end]);
  win.append(el(doc, 'small', 'hint', 'You only count as away when you click "I\'m away now".'));
  basic.append(win);

  const tz = field(doc, FIELD_LABELS.timeZone.label, FIELD_LABELS.timeZone.hint);
  const tzIn = el(doc, 'input', 'input night-timezone'); tzIn.type = 'text'; tzIn.dataset.field = 'timeZone';
  tzIn.value = typeof values.timeZone === 'string' ? values.timeZone : '';
  tzIn.placeholder = placeholderFor(level, inh.timeZone);
  try {
    const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    if (zones.length) {
      const list = el(doc, 'datalist'); list.id = `night-tz-${level}`;
      for (const z of zones) { const o = el(doc, 'option'); o.value = z; list.append(o); }
      tzIn.setAttribute('list', list.id); tz.append(list);
    }
  } catch { /* no zone list: plain text */ }
  tz.append(tzIn);
  sourceHint(doc, tz, values, inhSrc, 'timeZone');
  basic.append(tz);

  basic.append(whichRuns(doc, level, values.enabled, inh, inhSrc));

  const byDay = numField(doc, 'graceMinutes', level, values, inh, inhSrc, { suffix: 'minutes' });
  byDay.wrap.classList.add('away-byday');
  offBox(doc, byDay.wrap, 'night-grace-off', 'Never by day', values.graceMinutes === null, [byDay.input]);
  byDay.wrap.append(el(doc, 'small', 'hint', 'Marked runs wait for you outside away hours, like every other run.'));
  basic.append(byDay.wrap);
  body.append(basic);

  // D. How worca picks an answer (collapsed).
  const pick = details(doc, 'How worca picks an answer');
  const method = field(doc, FIELD_LABELS.strategy.label, FIELD_LABELS.strategy.hint);
  const stSel = el(doc, 'select', 'select night-strategy'); stSel.dataset.field = 'strategy';
  const m = METHOD_OPTIONS.find((o) => o.value === inh.strategy);
  const none = el(doc, 'option', null, level === 'project' ? sameAs(m && m.label) : 'Not set'); none.value = ''; stSel.append(none);
  for (const o of METHOD_OPTIONS) {
    const opt = el(doc, 'option', null, o.label); opt.value = o.value;
    if (o.hint) opt.title = o.hint;
    stSel.append(opt);
  }
  stSel.value = values.strategy !== undefined ? values.strategy : '';
  method.append(stSel);
  sourceHint(doc, method, values, inhSrc, 'strategy');
  pick.append(method);
  pick.append(numField(doc, 'minConfidence', level, values, inh, inhSrc, { suffix: '% sure' }).wrap);
  pick.append(numField(doc, 'minMargin', level, values, inh, inhSrc, { suffix: 'points' }).wrap);
  const cr = field(doc, FIELD_LABELS.criteria.label, FIELD_LABELS.criteria.hint);
  for (const c of CRITERIA) {
    const lab = el(doc, 'label', 'night-crit', `${CRITERIA_LABELS[c]} `);
    const inp = el(doc, 'input', 'input input-mini night-crit-val'); inp.type = 'number'; inp.min = '0'; inp.max = '10'; inp.step = '0.5';
    inp.dataset.crit = c;
    inp.placeholder = String(inh.criteria?.[c] ?? '');
    if (values.criteria && Number.isFinite(values.criteria[c])) inp.value = String(values.criteria[c]);
    lab.append(inp); cr.append(lab);
  }
  pick.append(cr);
  body.append(pick);

  // E. Limits (collapsed).
  const limits = details(doc, 'Limits');
  limits.append(numField(doc, 'maxDecisions', level, values, inh, inhSrc, { suffix: 'answers' }).wrap);
  limits.append(numField(doc, 'maxExtraCycles', level, values, inh, inhSrc).wrap);
  if (level === 'user') {
    const cap = field(doc, FIELD_LABELS.spendCapUsd.label, FIELD_LABELS.spendCapUsd.hint);
    const inp = el(doc, 'input', 'input input-mini night-spend-cap'); inp.type = 'number'; inp.min = '0.1'; inp.step = '0.1';
    inp.value = values.spendCapUsd == null ? '' : String(values.spendCapUsd);
    inp.placeholder = placeholderFor(level, inh.spendCapUsd);
    const row = el(doc, 'div', 'away-input-row');
    row.append(doc.createTextNode('$'), inp, doc.createTextNode(' spent while away'));
    cap.append(row);
    sourceHint(doc, cap, values, inhSrc, 'spendCapUsd');
    offBox(doc, cap, 'night-spend-cap-off', 'No cap', values.spendCapUsd === null, [inp]);
    limits.append(cap);
  } else {
    limits.append(el(doc, 'small', 'hint', 'The spend cap is set once for you, not per project, because it counts spending across every run.'));
  }
  const ov = field(doc, FIELD_LABELS.allowCostCapOverride.label, FIELD_LABELS.allowCostCapOverride.hint);
  ov.append(triSelect(doc, 'select night-override', 'allowCostCapOverride', level, values, inh.allowCostCapOverride));
  sourceHint(doc, ov, values, inhSrc, 'allowCostCapOverride');
  limits.append(ov);
  body.append(limits);

  // F. Always wait for me on… (collapsed).
  const wait = details(doc, FIELD_LABELS.neverDecide.label);
  wait.append(el(doc, 'small', 'hint', FIELD_LABELS.neverDecide.hint));
  for (const k of NIGHT_KINDS) {
    const lab = el(doc, 'label', 'check-row');
    const cb = el(doc, 'input', 'night-never'); cb.type = 'checkbox'; cb.value = k;
    cb.checked = Array.isArray(values.neverDecide) && values.neverDecide.includes(k);
    lab.append(cb, ` ${KIND_LABELS[k]}`); wait.append(lab);
    if (k === 'form') wait.append(el(doc, 'small', 'hint', 'A form asked as part of the two kinds above follows their tick too.'));
  }
  body.append(wait);

  CTX.set(root, { level, inherited, toggle, offset: now - Date.now(), projectName });
  const onEdit = () => { root.dataset.dirty = '1'; updateAwaySummary(root); };
  body.addEventListener('input', onEdit); body.addEventListener('change', onEdit);
  updateAwaySummary(root);
  return root;
}

/**
 * Read the form back into a patch: set fields → values; cleared fields → `__unset`.
 * @returns {object} `{ ...patch, __unset: [...] }`
 */
export function readNightForm(root, { level }) {
  const out = {}; const unset = [];
  const q = (sel) => root.querySelector(sel);
  const tri = (sel, f) => { const v = q(sel).value; if (v === '') unset.push(f); else out[f] = v === 'on'; };
  const grp = q('.away-which'); const pick = grp && grp.querySelector('input:checked');
  if (!grp || grp.dataset.set !== '1' || !pick || pick.value === '') unset.push('enabled');
  else out.enabled = pick.value === 'true';
  tri('.night-override', 'allowCostCapOverride');
  const ws = q('.night-window-start').value; const we = q('.night-window-end').value;
  if (q('.night-window-off').checked) out.window = null;
  else if (ws && we) out.window = `${ws.slice(0, 5)}-${we.slice(0, 5)}`;
  else unset.push('window');
  const tz = q('.night-timezone').value.trim();
  if (tz) out.timeZone = tz; else unset.push('timeZone');
  const st = q('.night-strategy').value;
  if (st) out.strategy = st; else unset.push('strategy');
  for (const inp of root.querySelectorAll('.night-num')) {
    const f = inp.dataset.field; const s = inp.value.trim();
    if (f === 'graceMinutes' && q('.night-grace-off').checked) { out.graceMinutes = null; continue; }
    if (s === '') { unset.push(f); continue; }
    out[f] = Math.round(Number(s));
  }
  const crit = {};
  for (const inp of root.querySelectorAll('.night-crit-val')) { const s = inp.value.trim(); if (s !== '' && Number.isFinite(Number(s))) crit[inp.dataset.crit] = Number(s); }
  if (Object.keys(crit).length) out.criteria = crit; else unset.push('criteria');
  const never = [...root.querySelectorAll('.night-never')].filter((c) => c.checked).map((c) => c.value);
  if (never.length) out.neverDecide = never; else unset.push('neverDecide');
  if (level === 'user') {
    const s = q('.night-spend-cap').value.trim();
    if (q('.night-spend-cap-off').checked) out.spendCapUsd = null;
    else if (s === '') unset.push('spendCapUsd'); else out.spendCapUsd = Number(s);
  }
  return { ...out, __unset: unset };
}

function formPatch(root) {
  const c = CTX.get(root); const { __unset, ...patch } = readNightForm(root, { level: c.level });
  return patch;
}

/** The live summary: one `<span>` per line of describeAwayMode. */
export function paintAwaySummary(host, { config, toggle, now, projectName = null, projectFields = null }) {
  const doc = host.ownerDocument;
  host.replaceChildren(...describeAwayMode({ config, toggle, now, projectName, projectFields }).lines.map((l) => el(doc, 'span', 'away-line', `${l} `)));
}

/** Re-render only the summary from the form's current values (unsaved edits survive). Each key is optional. */
export function updateAwaySummary(root, { toggle, now, inherited } = {}) {
  const c = CTX.get(root); if (!c) return;
  if (toggle !== undefined) c.toggle = toggle;
  if (inherited !== undefined) c.inherited = inherited;       // a fallback-painted, now-dirty form gets the real layers
  if (now !== undefined) c.offset = now - Date.now();       // the render's clock, moving on in real time
  const patch = formPatch(root);
  paintAwaySummary(root.querySelector('.away-summary'), {
    // An unset field falls back to the layer below. With no inherited config (the fetch failed), the
    // summary says "Away mode settings could not be read." and the fields still render (spec §7).
    config: c.inherited && c.inherited.config ? { ...c.inherited.config, ...patch } : null,
    toggle: c.toggle, now: Date.now() + c.offset, projectName: c.projectName,
    projectFields: c.level === 'project' ? Object.keys(patch) : null,   // "(this project)" on the lines it overrides
  });
}
