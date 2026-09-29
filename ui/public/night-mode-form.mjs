// ui/public/night-mode-form.mjs — the night mode fields (src/core/night/config.mjs), shared by
// the global Settings card (level 'user') and the project Overview card (level 'project').
// Pure DOM: renderNightForm builds the inputs, readNightForm reads them back into a patch.
// A field left empty is "not set here": it is sent as `__unset` so the next layer applies.

export const NIGHT_KINDS = ['clarify', 'questions', 'form', 'gate', 'workflow', 'recovery'];
export const CRITERIA = ['matchesMemory', 'reversible', 'smallestScope', 'codebaseConventions', 'cost'];
const STRATEGIES = ['weights', 'analysis', 'mixed'];
const NUMBER_FIELDS = [
  ['graceMinutes', 'Grace (minutes)', 1, 1440, 'A question open this long is decided, even outside the window.'],
  ['minConfidence', 'Min confidence (0-100)', 0, 100, 'The agent\'s recommendation is used when at least this confident…'],
  ['minMargin', 'Min margin (0-100)', 0, 100, '…and ahead of the runner-up by at least this much.'],
  ['maxDecisions', 'Max decisions per run', 1, 500, 'Reaching it pauses the run for review.'],
  ['maxExtraCycles', 'Extra review cycles', 0, 10, 'Per loop, granted while critical issues remain.'],
];

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

/** "(inherits: 30 · team)" — what an empty field falls back to. */
function inherited(effective, sources, f, fmt = String) {
  const v = effective[f];
  const src = sources[f] && sources[f] !== 'default' ? ` · ${sources[f]}` : '';
  return `inherits ${v == null ? 'off' : fmt(v)}${src}`;
}

/**
 * Build the fields into `root` (replacing its content).
 * @param {HTMLElement} root
 * @param {{level:'user'|'project', values?:object, effective?:object, sources?:object}} o
 *   values: the layer's own fields; effective/sources: what applies and where it comes from.
 */
export function renderNightForm(root, { level, values = {}, effective = {}, sources = {} }) {
  const doc = root.ownerDocument;
  root.replaceChildren();
  root.dataset.level = level;
  const has = (f) => values[f] !== undefined;

  // enabled: a switch at user level; inherit / on / off per project.
  const en = field(doc, 'Night mode', level === 'project' ? inherited(effective, sources, 'enabled', (v) => (v ? 'on' : 'off')) : 'Eligible runs may be answered while you are away.');
  const enSel = el(doc, 'select', 'select night-enabled');
  enSel.dataset.field = 'enabled';
  for (const [v, t] of [['', level === 'project' ? 'Inherit' : 'Not set'], ['on', 'On'], ['off', 'Off']]) {
    const o = el(doc, 'option', null, t); o.value = v; enSel.append(o);
  }
  enSel.value = has('enabled') ? (values.enabled ? 'on' : 'off') : '';
  en.append(enSel); root.append(en);

  // window: two times; both empty = not set here, "No window" = an explicit null.
  const win = field(doc, 'Night window', `24 h, in your time zone. ${inherited(effective, sources, 'window')}`);
  const [ws, we] = typeof values.window === 'string' ? values.window.split('-') : ['', ''];
  const start = el(doc, 'input', 'input input-mini night-window-start'); start.type = 'time'; start.value = ws || '';
  const end = el(doc, 'input', 'input input-mini night-window-end'); end.type = 'time'; end.value = we || '';
  win.append(start, doc.createTextNode(' – '), end);
  offBox(doc, win, 'night-window-off', 'No window', values.window === null, [start, end]);
  root.append(win);

  const tz = field(doc, 'Time zone', `IANA name, e.g. Europe/Berlin. ${inherited(effective, sources, 'timeZone')}`);
  const tzIn = el(doc, 'input', 'input night-timezone'); tzIn.type = 'text'; tzIn.dataset.field = 'timeZone';
  tzIn.value = typeof values.timeZone === 'string' ? values.timeZone : '';
  try {
    const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    if (zones.length) {
      const list = el(doc, 'datalist'); list.id = `night-tz-${level}`;
      for (const z of zones) { const o = el(doc, 'option'); o.value = z; list.append(o); }
      tzIn.setAttribute('list', list.id); tz.append(list);
    }
  } catch { /* no zone list: plain text */ }
  tz.append(tzIn); root.append(tz);

  const st = field(doc, 'Strategy', `weights: the agent's own confidence · analysis: a read-only decider scores each option · mixed: weights when decisive, else analysis. ${inherited(effective, sources, 'strategy')}`);
  const stSel = el(doc, 'select', 'select night-strategy'); stSel.dataset.field = 'strategy';
  const none = el(doc, 'option', null, level === 'project' ? 'Inherit' : 'Not set'); none.value = ''; stSel.append(none);
  for (const v of STRATEGIES) { const o = el(doc, 'option', null, v); o.value = v; stSel.append(o); }
  stSel.value = has('strategy') ? values.strategy : '';
  st.append(stSel); root.append(st);

  for (const [f, label, min, max, hint] of NUMBER_FIELDS) {
    const w = field(doc, label, `${hint} ${inherited(effective, sources, f)}`);
    const inp = el(doc, 'input', 'input input-mini night-num'); inp.type = 'number'; inp.min = String(min); inp.max = String(max); inp.step = '1';
    inp.dataset.field = f; inp.value = values[f] == null ? '' : String(values[f]);
    w.append(inp);
    if (f === 'graceMinutes') offBox(doc, w, 'night-grace-off', 'No grace timeout', values.graceMinutes === null, [inp]);
    root.append(w);
  }

  const cr = field(doc, 'Criteria weights (0-10)', 'How the analysis weighs each option. Empty keeps the inherited weight.');
  for (const c of CRITERIA) {
    const lab = el(doc, 'label', 'night-crit', `${c} `);
    const inp = el(doc, 'input', 'input input-mini night-crit-val'); inp.type = 'number'; inp.min = '0'; inp.max = '10'; inp.step = '0.5';
    inp.dataset.crit = c;
    inp.placeholder = effective.criteria && effective.criteria[c] != null ? String(effective.criteria[c]) : '';
    if (values.criteria && Number.isFinite(values.criteria[c])) inp.value = String(values.criteria[c]);
    lab.append(inp); cr.append(lab);
  }
  root.append(cr);

  const nd = field(doc, 'Never decide', 'These question kinds always wait for you. Clarify and questions also cover the forms those steps ask with.');
  for (const k of NIGHT_KINDS) {
    const lab = el(doc, 'label', 'check-row');
    const cb = el(doc, 'input', 'night-never'); cb.type = 'checkbox'; cb.value = k;
    cb.checked = Array.isArray(values.neverDecide) && values.neverDecide.includes(k);
    lab.append(cb, ` ${k}`); nd.append(lab);
  }
  root.append(nd);

  if (level === 'user') {
    const cap = field(doc, 'Night spend cap (USD)', `Across all runs since night mode took over (the window start, or the first decision while you were away). Reaching it pauses the run. ${inherited(effective, sources, 'spendCapUsd')}`);
    const inp = el(doc, 'input', 'input input-mini night-spend-cap'); inp.type = 'number'; inp.min = '0.1'; inp.step = '0.1';
    inp.value = values.spendCapUsd == null ? '' : String(values.spendCapUsd);
    cap.append(inp);
    offBox(doc, cap, 'night-spend-cap-off', 'No cap', values.spendCapUsd === null, [inp]);
    root.append(cap);
  }

  const ov = field(doc, 'Continue past team soft caps', 'Off by default. Never overrides your own caps.');
  const ovSel = el(doc, 'select', 'select night-override'); ovSel.dataset.field = 'allowCostCapOverride';
  for (const [v, t] of [['', level === 'project' ? 'Inherit' : 'Not set'], ['on', 'On'], ['off', 'Off']]) {
    const o = el(doc, 'option', null, t); o.value = v; ovSel.append(o);
  }
  ovSel.value = has('allowCostCapOverride') ? (values.allowCostCapOverride ? 'on' : 'off') : '';
  ov.append(ovSel); root.append(ov);
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
  tri('.night-enabled', 'enabled');
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
