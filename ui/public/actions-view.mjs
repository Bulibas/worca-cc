// ui/public/actions-view.mjs — Actions (issue #529): pure renderers + one live controller.
// Every renderer takes `doc` explicitly and returns detached DOM; no colour literals, no innerHTML with data.
export const TERMINAL = new Set(['exited', 'failed', 'stopped']);
const ACTIVE = new Set(['starting', 'running', 'ready']);
const LOG_TAIL = 400;
function h(doc, tag, cls, text) { const el = doc.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; }

// In-app pages an Actions message names. appendWithPageLinks keeps the message's words and turns each
// page name into a link to it; `extra` adds [label, href] pairs for this message (a project's own tab).
const PAGE_LINKS = [['Settings › Runs › Actions', '#settings/runs/actions']];
export function appendWithPageLinks(doc, el, text, extra = []) {
  const links = [...extra, ...PAGE_LINKS];
  let rest = String(text ?? '');
  while (rest) {
    const hit = links.map(([label, href]) => ({ label, href, i: rest.indexOf(label) })).filter((x) => x.i >= 0).sort((a, b) => a.i - b.i)[0];
    if (!hit) { el.append(rest); break; }
    if (hit.i) el.append(rest.slice(0, hit.i));
    const a = h(doc, 'a', 'act-page-link', hit.label);
    a.href = hit.href;
    el.append(a);
    rest = rest.slice(hit.i + hit.label.length);
  }
  return el;
}
/** The project's own Actions tab, where its setup and actions are edited. */
export const projectActionsHref = (key) => `#projects/${encodeURIComponent(key)}/actions`;
const btn = (doc, label, cls, onClick) => { const b = h(doc, 'button', `btn ${cls || 'btn-ghost'} btn-mini`, label); b.type = 'button'; if (onClick) b.addEventListener('click', onClick); return b; };
const portOf = (s) => Object.values(s.ports || {})[0];
/** "Run :4417", or just "Run" for a service without a port variable (never "Run :undefined"). Used by the
 *  pill, the sidebar rows and the "Running :4417" History badge alike. */
export const withPort = (text, s) => (portOf(s) != null ? `${text} :${portOf(s)}` : text);

export function formatUptime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
export function estimateText(ms, hasSetup) {
  if (ms) return `about ${ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`}`;
  return hasSetup ? 'usually under a minute' : 'a few seconds';
}

/** D24: the renderer re-checks every link, whatever the server stored. */
export function isSafeHref(u) {
  if (typeof u !== 'string') return false;
  try { const p = new URL(u.trim()); return p.protocol === 'http:' || p.protocol === 'https:'; } catch { return false; }
}
/** An open link: http(s) only, new tab, no opener. Returns null for anything else. */
export function openLink(doc, url, text) {
  if (!isSafeHref(url)) return null;
  const a = h(doc, 'a', 'act-open', text || url);
  a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
  return a;
}

export function memberViewState(m, instances) {
  if (!m.branch) return 'no-branch';
  if (!m.checkout) return 'not-checked-out';
  const mine = instances.filter((s) => s.member === m.projectKey);
  const setup = m.checkout.setup?.status;
  // D25: `pending` alone means "not run yet" (a kept checkout waits for its first action), not "running now".
  if (setup === 'running' || m.setupQueued || mine.some((s) => s.actionId === '__setup' && ACTIVE.has(s.status))) return 'setting-up';
  if (setup === 'failed' || setup === 'interrupted') return 'setup-failed';
  if (mine.some((s) => s.kind === 'service' && ACTIVE.has(s.status))) return 'running';
  if (mine.some((s) => s.kind === 'task' && s.actionId !== '__setup')) return 'task-result';
  return 'ready';
}

export function renderRunPill(instances, { doc, onClick } = {}) {
  const s = instances.find((x) => x.kind === 'service' && ACTIVE.has(x.status));
  if (!s) return null;
  const b = h(doc, 'button', 'pill-run green act-pill', null); b.type = 'button';
  b.append(h(doc, 'span', 'pdot'), doc.createTextNode(withPort(s.label, s)));
  if (onClick) b.addEventListener('click', () => onClick(s));
  return b;
}

const STATE_TEXT = {
  'no-branch': 'No branch', 'not-checked-out': 'Not checked out', 'setting-up': 'Setting up',
  'setup-failed': 'Setup failed', ready: 'Checked out', running: 'Running', 'task-result': 'Checked out',
};
const POLICY_TEXT = { 'on-success': 'on success', 'until-pr': 'until PR' };
const instancesOf = (model, pk) => (model.instances || []).filter((s) => s.member === pk);
const activeService = (list, actionId) => list.find((s) => s.kind === 'service' && ACTIVE.has(s.status) && (actionId == null || s.actionId === actionId));
const latest = (list) => list.reduce((a, s) => (!a || (s.startedAt || 0) >= (a.startedAt || 0) ? s : a), null);
const labelOf = (m, s) => s.label || m?.actions?.find((a) => a.id === s.actionId)?.label || s.actionId;

/** The log tail of one instance as a `<pre class="act-log">`; action-line frames append to it in place. */
function renderLog(doc, instanceId, lines) {
  const pre = h(doc, 'pre', 'act-log');
  pre.dataset.instanceId = instanceId;
  for (const l of lines || []) pre.append(logLine(doc, l));
  return pre;
}
function logLine(doc, l) { return h(doc, 'span', l.stream === 'out' ? null : l.stream, `${l.text}\n`); }

/** Long branch names and paths keep both ends (the run id is at the end): "worca-cc/github-…-da7d143d". */
export function middleClip(text, max = 56) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) * 0.55);
  return `${s.slice(0, head)}…${s.slice(s.length - (max - 1 - head))}`;
}
const SVG_NS = 'http://www.w3.org/2000/svg';
function copyIconButton(doc, label, onClick) {
  const b = h(doc, 'button', 'act-copy');
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.title = label;
  const svg = doc.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of [['width', '14'], ['height', '14'], ['viewBox', '0 0 24 24'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2'], ['aria-hidden', 'true']]) svg.setAttribute(k, v);
  const rect = doc.createElementNS(SVG_NS, 'rect');
  for (const [k, v] of [['x', '9'], ['y', '9'], ['width', '12'], ['height', '12'], ['rx', '2.5']]) rect.setAttribute(k, v);
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5');
  svg.append(rect, path);
  b.append(svg);
  b.addEventListener('click', onClick);
  return b;
}
/** Branch and Folder as labelled rows: each mono string says what it is. */
function metaRows(doc, m, handlers) {
  const dl = h(doc, 'dl', 'act-meta');
  const row = (label, ...value) => { const dd = h(doc, 'dd'); dd.append(...value); dl.append(h(doc, 'dt', null, label), dd); };
  if (!m.branch) { row('Branch', h(doc, 'span', 'act-later', 'None: this run made no branch')); return dl; }
  const br = h(doc, 'code', 'act-branch', middleClip(m.branch)); br.title = m.branch;
  row('Branch', br, copyIconButton(doc, 'Copy branch name', () => handlers.onCopy?.(m.branch)));
  const dir = m.checkout ? (m.checkout.worktreeDir || m.worktreeDir) : null;
  if (dir) {
    const p = h(doc, 'code', 'act-path', middleClip(dir, 64)); p.title = dir;
    row('Folder', p, copyIconButton(doc, 'Copy folder path', () => handlers.onCopy?.(dir)));
  } else row('Folder', h(doc, 'span', 'act-later', 'Created when you check out'));
  return dl;
}

const BUILTIN_NAME = { editor: 'editor', terminal: 'terminal', fileManager: 'file manager' };

function memberCard(model, m, { doc, handlers, logs, queued }) {
  const sec = h(doc, 'section', 'card act-card');
  sec.dataset.member = m.projectKey;
  const mine = instancesOf(model, m.projectKey);
  const state = memberViewState(m, mine);
  sec.dataset.state = state;
  // Name and state on top (the badge keeps one place, top right), then Branch and Folder as labelled rows.
  const head = h(doc, 'div', 'act-head');
  head.append(h(doc, 'h3', 'act-name', m.projectName || m.projectKey), h(doc, 'span', 'badge act-state', STATE_TEXT[state]));
  sec.append(head, metaRows(doc, m, handlers));

  if (state === 'no-branch') return sec;
  if (model.finished === false) {
    sec.append(h(doc, 'p', 'hint', 'Check out is available once the run has finished. Resume or stop the run first.'));
    return sec;
  }
  if (!model.enabled) sec.append(h(doc, 'p', 'hint', 'Actions are turned off on this hosted deployment. Check out and Copy command still work.'));
  const copyBtn = () => (m.copyCommand ? btn(doc, 'Copy command', null, () => handlers.onCopy?.(m.copyCommand)) : null);
  const discardBtn = () => btn(doc, 'Discard', 'btn-ghost act-discard', () => handlers.onDiscard?.([m.projectKey]));
  // A built-in switched on for the project but not found on this machine (the server's detection) says so,
  // instead of quietly missing from the row; the project's Actions tab says "not found on this machine".
  // `lead` is text that comes first in the same note (what waits for Check out); null when there is nothing to say.
  const missingNote = (lead = '') => {
    const names = model.enabled ? (m.unavailableBuiltins || []).map((k) => BUILTIN_NAME[k] || k) : [];
    if (!lead && !names.length) return null;
    // The link lands on the card itself: showSettingsTab scrolls to it and focuses its first field.
    const text = [lead, names.length ? `No ${names.join(' or ')} was found on this machine. Set one in Settings › Runs › Actions.` : ''].filter(Boolean).join(' ');
    return appendWithPageLinks(doc, h(doc, 'p', 'hint act-missing'), text);
  };

  if (state === 'not-checked-out') {
    const row = h(doc, 'div', 'act-row');
    if (!model.workspace) row.append(btn(doc, 'Check out', 'btn-primary', () => handlers.onCheckout?.([m.projectKey])));
    const c = copyBtn(); if (c) row.append(c);
    // The other built-ins open the checkout folder, which Check out creates: a click asks first, then checks
    // out and opens (a workspace run checks out from its checklist, so there they wait for it).
    const opens = model.enabled ? (m.builtins || []).filter((b) => b.key !== 'copyCommand') : [];
    if (opens.length) {
      row.append(h(doc, 'span', 'act-sep'));
      for (const b of opens) {
        const o = btn(doc, b.label, null, () => handlers.onOpenBeforeCheckout?.(m.projectKey, b.key, b.label));
        if (model.workspace) { o.disabled = true; o.title = 'Available after Check out'; } else o.title = 'Checks out the run first, then opens';
        row.append(o);
      }
    }
    if (row.childNodes.length) sec.append(row);
    // One note under the row: what waits for Check out, then what this machine lacks.
    const names = opens.map((b) => b.label).join(', ').replace(/, ([^,]*)$/, ' and $1');
    const waits = !opens.length ? '' : model.workspace ? `${names} open the checkout, so they work after Check out.`
      : `${names} open the checkout, so they check out first.`;
    const note = missingNote(`Check out takes ${estimateText(model.estimate?.lastSetupMs, !!m.setup)}.${waits ? ` ${waits}` : ''}`);
    if (note) sec.append(note);
    return sec;
  }

  const setup = m.checkout.setup || {};
  const row = h(doc, 'div', 'act-row');
  if (state === 'setting-up') {
    sec.append(h(doc, 'p', 'hint', m.setup ? `Running setup: ${m.setup}` : 'Running setup'));
  } else if (state === 'setup-failed') {
    const why = setup.status === 'interrupted' ? 'Setup was interrupted.' : `Setup failed${setup.exitCode != null ? ` (exit ${setup.exitCode})` : ''}.`;
    sec.append(h(doc, 'p', 'hint act-exit fail', why));
    if (model.enabled) row.append(btn(doc, 'Run setup again', 'btn-primary', () => handlers.onSetupAgain?.(m.projectKey)));
  } else if (model.enabled) {
    for (const a of m.actions || []) {
      const live = a.kind === 'service' ? activeService(mine, a.id) : null;
      if (live) { row.append(btn(doc, `Stop ${a.label}`, 'btn-danger', () => handlers.onStop?.(m.projectKey, a.id))); continue; }
      if (queued?.has(`${m.projectKey}:${a.id}`)) { const b = btn(doc, 'Starts after setup'); b.disabled = true; row.append(b); continue; }
      row.append(btn(doc, a.label, a.kind === 'service' ? 'btn-primary' : null, () => handlers.onStart?.(m.projectKey, a.id)));
    }
    if (setup.status === 'skipped') row.append(btn(doc, 'Run setup', null, () => handlers.onSetupAgain?.(m.projectKey)));
  }
  if (model.enabled && state !== 'setting-up' && state !== 'setup-failed' && (m.builtins || []).length) {
    if (row.childNodes.length) row.append(h(doc, 'span', 'act-sep'));
    for (const b of m.builtins) {
      if (b.key === 'copyCommand') { const c = copyBtn(); if (c) row.append(c); continue; }
      row.append(btn(doc, b.label, null, () => handlers.onBuiltin?.(m.projectKey, b.key)));
    }
  } else { const c = copyBtn(); if (c) row.append(c); }
  row.append(discardBtn());
  sec.append(row);
  if (model.enabled && state !== 'setting-up' && state !== 'setup-failed' && !(m.actions || []).length) {
    const tab = "the project's Actions tab";
    sec.append(appendWithPageLinks(doc, h(doc, 'p', 'hint act-none'),
      `${m.projectName || 'This project'} has no actions yet. Add a Run or Test command on ${tab}.`, [[tab, projectActionsHref(m.projectKey)]]));
  }
  if (state !== 'setting-up' && state !== 'setup-failed') { const miss = missingNote(); if (miss) sec.append(miss); }
  if (state === 'ready' && setup.status === 'pending') sec.append(h(doc, 'p', 'hint', 'Setup runs before the first action.'));

  for (const s of mine.filter((x) => x.kind === 'service' && ACTIVE.has(x.status))) {
    const line = h(doc, 'div', 'act-row act-service');
    line.append(h(doc, 'span', 'act-label', withPort(labelOf(m, s), s)));
    const link = openLink(doc, s.url, portOf(s) != null ? `Open :${portOf(s)}` : 'Open');
    if (link) line.append(link);
    if (s.startedAt) line.append(h(doc, 'span', 'act-uptime', `up ${formatUptime(Date.now() - s.startedAt)}`));
    if (s.readyError) line.append(h(doc, 'span', 'hint act-ready-error', s.readyError));
    sec.append(line);
  }
  const task = latest(mine.filter((s) => s.kind === 'task' && s.actionId !== '__setup' && TERMINAL.has(s.status)));
  if (state === 'task-result' && task) {
    const ok = task.exitCode === 0;
    sec.append(h(doc, 'p', `act-exit ${ok ? 'ok' : 'fail'}`, `${labelOf(m, task)} ${task.status} (exit ${task.exitCode ?? '?'})`));
  }
  const shown = latest(mine);
  if (shown && logs) sec.append(renderLog(doc, shown.instanceId, logs.get(shown.instanceId)));
  return sec;
}

/** One section.card.act-card per member. A workspace run adds a member checklist and stack rows on top. */
export function renderActionsCard(model, { doc, handlers = {}, logs = null, queued = null, notice = null } = {}) {
  const root = h(doc, 'div', 'act-view');
  if (notice) {
    // kind 'error' | 'ok' (and older 'err'): an error is a tinted alert box, a success a green status line.
    const err = notice.kind === 'error' || notice.kind === 'err';
    const p = h(doc, 'p', `act-notice ${err ? 'err' : notice.kind === 'ok' ? 'ok' : ''}`.trim());
    p.setAttribute('role', err ? 'alert' : 'status');
    root.append(appendWithPageLinks(doc, p, notice.text));
  }
  const members = model.members || [];
  if (model.workspace && model.finished !== false) {
    const open = members.filter((m) => m.branch && !m.checkout);
    if (open.length) {
      const list = h(doc, 'div', 'act-members');
      for (const m of open) {
        const lab = h(doc, 'label', 'act-member');
        const cb = h(doc, 'input'); cb.type = 'checkbox'; cb.checked = true; cb.value = m.projectKey;
        lab.append(cb, doc.createTextNode(` ${m.projectName || m.projectKey}`));
        list.append(lab);
      }
      list.append(btn(doc, 'Check out selected', 'btn-primary', () => {
        handlers.onCheckout?.([...list.querySelectorAll('input[type="checkbox"]')].filter((x) => x.checked).map((x) => x.value));
      }));
      root.append(list);
    }
    for (const st of model.stacks || []) {
      const cur = (model.stackStates || []).find((x) => x.stackId === st.id);
      const busy = cur && ['starting', 'running'].includes(cur.status);
      const line = h(doc, 'div', 'act-row act-stack');
      line.append(h(doc, 'span', 'act-label', st.label || st.id));
      if (cur) line.append(h(doc, 'span', 'badge act-state', cur.status));
      if (busy) line.append(btn(doc, 'Stop stack', 'btn-danger', () => handlers.onStack?.(st.id, 'stop')));
      else if (model.enabled) line.append(btn(doc, 'Start stack', 'btn-primary', () => handlers.onStack?.(st.id, 'start')));
      if (cur?.error) line.append(h(doc, 'span', 'hint act-exit fail', cur.error));
      root.append(line);
    }
  }
  for (const m of members) root.append(memberCard(model, m, { doc, handlers, logs, queued }));
  return root;
}

/** Overview strip: the state, one primary affordance (Check out, or open link + Stop) and "Open tab ›". */
export function renderOverviewStrip(model, { doc, handlers = {} } = {}) {
  if (!model) return null;
  const members = (model.members || []).filter((m) => m.branch);
  if (!members.length) return null;
  const row = h(doc, 'div', 'act-row act-strip-row');
  const live = (model.instances || []).find((s) => s.kind === 'service' && ACTIVE.has(s.status));
  if (live) {
    row.append(h(doc, 'span', 'badge act-running', withPort('Running', live)));
    const link = openLink(doc, live.url, portOf(live) != null ? `Open :${portOf(live)}` : 'Open');
    if (link) row.append(link);
    row.append(btn(doc, 'Stop', 'btn-danger', () => handlers.onStop?.(live.member, live.actionId)));
  } else if (members.some((m) => m.checkout)) {
    row.append(h(doc, 'span', 'badge act-kept', 'Checked out'));
  } else {
    row.append(h(doc, 'span', 'act-label', 'Try the result in a local checkout.'));
    if (model.finished !== false) row.append(btn(doc, 'Check out', 'btn-primary', () => handlers.onCheckout?.()));
  }
  row.append(btn(doc, 'Open tab ›', null, () => handlers.onOpenTab?.()));
  return row;
}

/** Ship It "Try it first": Check out, or Open :port / actions / Editor / Stop. Never blocks the dialog. */
export function renderShipItStrip(model, { doc, handlers = {} } = {}) {
  if (!model) return null;
  const m = (model.members || []).find((x) => x.branch);
  if (!m || model.finished === false) return null;
  const row = h(doc, 'div', 'act-row act-shipit');
  row.append(h(doc, 'span', 'act-label', 'Try it first'));
  if (!m.checkout) {
    row.append(btn(doc, 'Check out', 'btn-primary', () => handlers.onCheckout?.(model.workspace ? undefined : [m.projectKey])));
    return row;
  }
  const mine = instancesOf(model, m.projectKey);
  const live = activeService(mine);
  if (live) {
    const link = openLink(doc, live.url, portOf(live) != null ? `Open :${portOf(live)}` : 'Open');
    if (link) row.append(link);
  }
  if (model.enabled) {
    for (const a of m.actions || []) {
      if (a.kind === 'service' && activeService(mine, a.id)) continue;
      row.append(btn(doc, a.label, null, () => handlers.onStart?.(m.projectKey, a.id)));
    }
    const editor = (m.builtins || []).find((b) => b.key === 'editor');
    if (editor) row.append(btn(doc, editor.label, null, () => handlers.onBuiltin?.(m.projectKey, 'editor')));
  }
  if (live) row.append(btn(doc, 'Stop', 'btn-danger', () => handlers.onStop?.(live.member, live.actionId)));
  return row;
}

/** Sidebar "Running actions": one row per running service; null when nothing runs. */
export function renderRunningActionsCard(services, { doc, titleOf = (s) => s.runId, onStop, onOpen } = {}) {
  const list = (services || []).filter((s) => ACTIVE.has(s.status));
  if (!list.length) return null;
  const card = h(doc, 'div', 'act-running');
  const head = h(doc, 'div', 'act-row act-running-head');
  head.append(h(doc, 'span', 'pdot'), h(doc, 'span', 'act-running-heading', 'Running actions'), h(doc, 'span', 'act-running-count', String(list.length)));
  card.append(head);
  for (const s of list) {
    const row = h(doc, 'div', 'act-row act-running-row');
    row.dataset.instanceId = s.instanceId;
    const title = h(doc, onOpen && s.histKey !== null ? 'button' : 'span', 'act-running-title', titleOf(s));
    if (title.tagName === 'BUTTON') { title.type = 'button'; title.addEventListener('click', () => onOpen(s)); }
    row.append(title, h(doc, 'span', 'act-label', withPort(s.label, s)));
    if (s.startedAt) row.append(h(doc, 'span', 'act-uptime', formatUptime(Date.now() - s.startedAt)));
    row.append(btn(doc, 'Stop', 'btn-ghost act-stop', () => onStop?.(s)));
    card.append(row);
  }
  return card;
}

/** History card badges: `Running :4417`, `N checked out` and `Kept · <policy>`, as `{text, cls}`. */
export function historyActionBadges(p, running) {
  const out = [];
  const live = (running || []).find((s) => s.runId === p.id && s.kind === 'service' && ACTIVE.has(s.status));
  if (live) out.push({ text: withPort('Running', live), cls: 'badge act-running' });
  const members = p.checkout?.members || [];
  if (members.length) {
    out.push({ text: members.length === 1 ? 'Checked out' : `${members.length} checked out`, cls: 'badge act-kept' });
    const policy = members.map((x) => x.policy).find((x) => POLICY_TEXT[x]);
    if (policy) out.push({ text: `Kept · ${POLICY_TEXT[policy]}`, cls: 'badge act-kept' });
  }
  return out;
}

/** The live Actions tab: fetches the run model, renders the card, follows action-* frames. */
export function createActionsController({ runId, scopeQuery, api, ws, host, doc, confirm, navigate, onModel }) {
  const st = { model: null, dead: false, lastSeq: new Map(), logs: new Map(), queued: new Set(), subscribed: new Set(), notice: null };
  const base = `/api/runs/${encodeURIComponent(runId)}`;
  const q = scopeQuery ? `?${scopeQuery}` : '';
  const prefix = `act:${runId}:`;
  const instanceIdOf = (member, actionId) => `${prefix}${member}:${actionId}`;

  function subscribe(instanceId) {
    if (st.subscribed.has(instanceId)) return;
    st.subscribed.add(instanceId);
    ws?.send({ type: 'subscribe', instanceId });
  }
  function render() {
    if (st.dead || !st.model) return;
    host.replaceChildren(renderActionsCard(st.model, { doc, handlers, logs: st.logs, queued: st.queued, notice: st.notice }));
  }
  function fail(r) { st.notice = { text: r.data?.error || `Request failed (${r.status})`, kind: 'error' }; render(); }
  function upsert(snap) {
    if (!st.model || !snap?.instanceId) return;
    const list = st.model.instances || (st.model.instances = []);
    const i = list.findIndex((s) => s.instanceId === snap.instanceId);
    if (i >= 0) list[i] = snap; else list.push(snap);
  }

  async function refresh() {
    if (st.dead) return;
    const r = await api('GET', `${base}/actions${q}`);
    if (st.dead) return;
    if (!r.ok) { if (!st.model) host.replaceChildren(h(doc, 'p', 'hint act-hint', r.data?.error || 'Could not load actions.')); return; }
    st.model = r.data;
    for (const s of st.model.instances || []) subscribe(s.instanceId);
    // A queued start waits only while its member's setup can still finish; with setup settled and no
    // instance for it, the start was refused (failed setup, no free port, bad cwd), so drop the wait.
    for (const key of [...st.queued]) {
      const m = (st.model.members || []).find((x) => key.startsWith(`${x.projectKey}:`));
      const waiting = m && (m.setupQueued || m.checkout?.setup?.status === 'running');
      if (!waiting && !(st.model.instances || []).some((s) => ACTIVE.has(s.status) && `${s.member}:${s.actionId}` === key)) st.queued.delete(key);
    }
    onModel?.(st.model);
    render();
  }
  const after = async (r) => { if (!r.ok) return fail(r); st.notice = null; await refresh(); return r; };

  const handlers = {
    onCheckout: async (members) => after(await api('POST', `${base}/checkout${q}`, members ? { members } : {})),
    onDiscard: async (members) => {
      if (!(await confirm({ title: 'Discard the checkout?', message: 'Running services stop first. Uncommitted changes are saved as a patch in the run\'s files.', danger: true, confirmLabel: 'Discard' }))) return;
      let r = await api('DELETE', `${base}/checkout${q}`, { members });
      if (!r.ok && r.data?.code === 'SNAPSHOT_FAILED') {
        if (!(await confirm({ title: 'Saving the uncommitted changes failed', message: 'Discard anyway? Uncommitted changes in the checkout will be lost.', danger: true, confirmLabel: 'Discard anyway' }))) return;
        r = await api('DELETE', `${base}/checkout${q}`, { members, force: true });
      }
      await after(r);
    },
    onStart: async (member, actionId) => {
      const r = await api('POST', `${base}/actions/${encodeURIComponent(actionId)}/start${q}`, { member });
      if (!r.ok) return fail(r);
      st.notice = null;
      if (r.status === 202) {
        st.queued.add(`${member}:${actionId}`);
        subscribe(r.data?.instanceId || instanceIdOf(member, actionId));
      } else {
        upsert(r.data);
        if (r.data?.instanceId) subscribe(r.data.instanceId);
      }
      render();
    },
    onStop: async (member, actionId) => after(await api('POST', `${base}/actions/${encodeURIComponent(actionId)}/stop${q}`, { member })),
    onBuiltin: async (member, key) => { const r = await api('POST', `${base}/builtins/${encodeURIComponent(key)}${q}`, { member }); if (!r.ok) fail(r); },
    // Terminal / Finder / Editor before Check out: they open the checkout folder, so ask, check out, then open.
    onOpenBeforeCheckout: async (member, key, label) => {
      const m = (st.model?.members || []).find((x) => x.projectKey === member);
      // Parts, not one string: the branch and the setup command are bold in the dialog (confirmModal).
      const ok = await confirm({ title: `Check out to open ${label}?`,
        message: [`${label} opens the run's checkout, which doesn't exist yet. Worca checks out `,
          m?.branch ? { strong: m.branch } : "the run's branch", ` first (a few seconds), then opens ${label}.`,
          ...(m?.setup ? [' Then the setup command runs: ', { strong: m.setup }] : [])],
        confirmLabel: `Check out and open` });
      if (!ok) return;
      const r = await after(await api('POST', `${base}/checkout${q}`, { members: [member] }));
      if (r?.ok) await handlers.onBuiltin(member, key);
    },
    onSetupAgain: async (member) => {
      const r = await api('POST', `${base}/setup${q}`, { member });
      if (!r.ok) return fail(r);
      if (r.data?.instanceId) subscribe(r.data.instanceId);
      await refresh();
    },
    onCopy: async (text) => {
      try { await doc.defaultView?.navigator?.clipboard?.writeText(text); st.notice = { text: 'Copied', kind: 'ok' }; }
      catch { st.notice = { text: 'Copy failed; select the text by hand.', kind: 'error' }; }
      render();
    },
    onStack: async (stackId, op) => after(await api('POST', `${base}/stacks/${encodeURIComponent(stackId)}/${op === 'stop' ? 'stop' : 'start'}${q}`, {})),
  };

  function onFrame(msg) {
    if (st.dead || !msg || typeof msg.instanceId !== 'string' || !msg.instanceId.startsWith(prefix)) return;
    if (Number.isInteger(msg.seq)) {
      if (msg.seq <= (st.lastSeq.get(msg.instanceId) ?? -Infinity)) return;
      st.lastSeq.set(msg.instanceId, msg.seq);
    }
    if (msg.type === 'action-line') {
      const line = { stream: msg.stream || 'out', text: String(msg.text ?? '') };
      const tail = st.logs.get(msg.instanceId) || [];
      tail.push(line);
      if (tail.length > LOG_TAIL) tail.splice(0, tail.length - LOG_TAIL);
      st.logs.set(msg.instanceId, tail);
      const pre = [...host.querySelectorAll('pre.act-log')].find((x) => x.dataset.instanceId === msg.instanceId);
      if (pre) {
        pre.append(logLine(doc, line));
        while (pre.childNodes.length > LOG_TAIL) pre.firstChild.remove();
      }
      return;
    }
    if (msg.type === 'action-status') {
      if (msg.snapshot) {
        upsert(msg.snapshot);
        st.queued.delete(`${msg.snapshot.member}:${msg.snapshot.actionId}`);
      } else st.queued.delete(msg.instanceId.slice(prefix.length));
      if (typeof msg.error === 'string' && msg.error) st.notice = { text: msg.error, kind: 'error' };
      render();
    }
  }

  function destroy() { st.dead = true; host.replaceChildren(); }

  return { runId, refresh, onFrame, destroy };
}
