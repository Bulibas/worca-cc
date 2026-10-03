// ui/public/terminal-pane.mjs — the terminal pane on the right of every page (issue #573). The shell
// runs on the worca server (src/core/terminal/manager.mjs); this pane draws it with xterm.js over /ws
// (term-* frames), follows the page (a run's folder, a project's branch) and lists each recorded command
// as a block. Built in JS and appended to <body>, like the Ask dock: index.html is untouched.
import { createLineEditor } from './terminal-line.mjs';

const OPEN_KEY = 'worca-cc.terminal.open';
const WIDTH_KEY = 'worca-cc.terminal.width';
const MIN_W = 320;
const DEFAULT_W = 460;

/**
 * What the pane opens for this page: a run, a project (branch picker), or nothing new. The run id is the
 * pipeline id (`/api/runs/:id` resolves it; `ctx.runId` is the live in-memory key). A live run gets its
 * pipeline id a moment after it starts: until then the target is `pending`.
 */
export function paneTargetOf(ctx = {}) {
  if (ctx.view === 'running' && !ctx.pipelineId && ctx.runId) return { kind: 'pending' };
  if ((ctx.view === 'running' || ctx.view === 'history-detail') && ctx.pipelineId) {
    const ws = ctx.workspaceId ? String(ctx.workspaceId).replace(/^workspaces\//, '') : '';   // the server wants the bare id
    const scope = ws ? { workspaceId: ws }
      : ctx.projectKey ? { projectKey: ctx.projectKey }
        : ctx.projectDir ? { projectDir: ctx.projectDir } : null;
    if (scope) return { kind: 'run', runId: ctx.pipelineId, query: new URLSearchParams(scope).toString() };
  }
  if (ctx.view === 'project-detail' && ctx.projectKey) return { kind: 'project', projectKey: ctx.projectKey };
  return { kind: 'other' };
}

export function formatDuration(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

export function blockStatusLabel(b) {
  if (b.status === 'running') return { text: 'running', tone: 'run' };
  if (b.status === 'stopped' || b.status === 'interrupted') return { text: b.status, tone: 'bad' };
  if (b.exitCode === 0) return { text: 'exit 0', tone: 'ok' };
  return { text: b.exitCode == null ? 'ended' : `exit ${b.exitCode}`, tone: 'bad' };
}

export const stripAnsi = (s) => String(s || '')
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  .replace(/\x1b[@-Z\\-_]/g, '');

let xtermPromise = null;
/** xterm.js + the fit addon, loaded on first use: pages that never open the pane never pay for it. */
export function defaultLoadXterm(doc) {
  if (!doc.querySelector('link[data-xterm-css]')) {
    const l = doc.createElement('link');
    l.rel = 'stylesheet'; l.href = '/vendor/xterm/xterm.css'; l.dataset.xtermCss = '1';
    doc.head.appendChild(l);
  }
  xtermPromise ||= Promise.all([import('/vendor/xterm/xterm.mjs'), import('/vendor/xterm/addon-fit.mjs')])
    .then(([x, f]) => ({ Terminal: x.Terminal, FitAddon: f.FitAddon }))
    .catch((e) => { xtermPromise = null; throw e; });
  return xtermPromise;
}

export function createTerminalPane({ doc, win, fetch, sendWs, getPageContext, confirm = async () => true, storage = null, loadXterm = null }) {
  const load = loadXterm || (() => defaultLoadXterm(doc));
  const st = { open: false, enabled: true, pty: { available: true, reason: null }, sessions: new Map(), current: null, lastSeq: 0,
    target: { kind: 'other' }, targetKey: '', ctx: null, blocks: new Map(), tab: 'term', term: null, fit: null, line: null,
    bootId: null, member: '', branch: '', note: '', destroyed: false };

  const make = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const button = (label, cls, onClick) => { const b = make('button', `btn ${cls}`.trim(), label); b.type = 'button'; b.addEventListener('click', onClick); return b; };
  const readStore = (k) => { try { return storage ? storage.getItem(k) : null; } catch { return null; } };
  const writeStore = (k, v) => { try { if (storage) storage.setItem(k, v); } catch { /* private mode */ } };

  // ── DOM ──────────────────────────────────────────────────────────────────────────────────────────
  const root = make('aside', 'term-pane');
  root.hidden = true;
  root.setAttribute('aria-label', 'Terminal');
  const resizer = make('div', 'term-resize');
  const head = make('div', 'term-head');
  const picker = make('select', 'term-sessions');
  picker.setAttribute('aria-label', 'Terminal session');
  picker.addEventListener('change', () => { if (picker.value) attach(picker.value); });
  const stopBtn = button('Stop', 'btn-danger term-stop', () => stopCurrent());
  const closeSessBtn = button('Close terminal', 'btn-ghost term-close-session', () => closeCurrent());
  const hideBtn = button('×', 'btn-ghost term-hide', () => close());
  hideBtn.setAttribute('aria-label', 'Hide the terminal pane');
  head.append(make('span', 'term-title', 'Terminal'), picker, stopBtn, closeSessBtn, hideBtn);
  const context = make('div', 'term-context');
  const banners = make('div', 'term-banners');
  const tabs = make('div', 'term-tabs');
  const tabTerm = button('Terminal', 'btn-ghost term-tab', () => setTab('term'));
  const tabBlocks = button('Commands', 'btn-ghost term-tab', () => setTab('blocks'));
  tabs.append(tabTerm, tabBlocks);
  const screen = make('div', 'term-screen');
  const probe = make('span', 'term-sel-probe');      // its token background becomes xterm's selection colour
  screen.appendChild(probe);
  const blocksEl = make('div', 'term-blocks');
  blocksEl.hidden = true;
  root.append(resizer, head, context, banners, tabs, screen, blocksEl);
  const handle = button('Terminal', 'term-handle', () => toggle());
  handle.setAttribute('aria-label', 'Open the terminal pane');

  // ── network ──────────────────────────────────────────────────────────────────────────────────────
  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    let j = null;
    try { j = await r.json(); } catch { j = null; }
    if (!r.ok) throw Object.assign(new Error((j && j.error) || `HTTP ${r.status}`), { status: r.status, code: j && j.code });
    return j;
  }
  const showError = (e) => { st.note = e?.message || String(e); render(); return null; };

  // ── open / close / width ─────────────────────────────────────────────────────────────────────────
  function applyWidth(px) {
    const max = Math.round((win.innerWidth || 1600) * 0.6);
    const w = Math.max(MIN_W, Math.min(Number(px) || DEFAULT_W, max));
    doc.body.style.setProperty('--term-w', `${w}px`);
    return w;
  }
  async function open() {
    st.open = true;
    root.hidden = false;
    doc.body.classList.add('term-open');
    writeStore(OPEN_KEY, '1');
    await refreshInfo();
    await refreshContext(true);
  }
  function close() {
    st.open = false;
    root.hidden = true;
    doc.body.classList.remove('term-open');
    writeStore(OPEN_KEY, '0');
  }
  const toggle = () => (st.open ? close() : open());

  async function refreshInfo() {
    try {
      const info = await api('GET', '/api/terminal');
      st.enabled = !!info.enabled;
      st.pty = info.pty || st.pty;
      for (const s of info.sessions || []) st.sessions.set(s.id, s);
    } catch (e) { st.note = e.message; }
  }

  function sessionsForTarget() {
    const all = [...st.sessions.values()];
    if (st.target.kind === 'run') return all.filter((s) => s.runId === st.target.runId && (!st.member || s.member === st.member));
    if (st.target.kind === 'project') return all.filter((s) => s.scope === 'branch' && s.projectKey === st.target.projectKey);
    return all;
  }

  async function refreshContext(force = false) {
    const target = paneTargetOf(getPageContext ? getPageContext() : {});
    const key = JSON.stringify(target);
    if (!force && key === st.targetKey) return;
    st.targetKey = key;
    st.target = target;
    st.ctx = null;
    st.note = '';
    if (!st.open || !st.enabled) { render(); return; }
    try {
      if (target.kind === 'run') st.ctx = await api('GET', `/api/runs/${encodeURIComponent(target.runId)}/terminal?${target.query}`);
      else if (target.kind === 'project') st.ctx = await api('GET', `/api/projects/${encodeURIComponent(target.projectKey)}/terminal`);
    } catch (e) { st.note = e.message; }
    for (const s of st.ctx?.sessions || []) st.sessions.set(s.id, s);
    if (target.kind === 'run' && st.ctx && !st.ctx.members.some((m) => m.projectKey === st.member)) st.member = st.ctx.members[0]?.projectKey || '';
    // D3: follow the page by reattaching its running session; never spawn one unasked.
    const mine = sessionsForTarget().find((s) => s.status === 'running');
    if (mine && mine.id !== st.current) await attach(mine.id);
    render();
  }

  // ── sessions ─────────────────────────────────────────────────────────────────────────────────────
  async function termSize() {
    try { await ensureTerm(); return { cols: st.term.cols, rows: st.term.rows }; } catch { return { cols: 100, rows: 30 }; }
  }
  async function adopt(r) {
    if (!r) return;
    st.sessions.set(r.session.id, r.session);
    if (r.warning) st.note = r.warning;
    await attach(r.session.id);
  }
  async function openRun(member) {
    const t = st.target;
    const size = await termSize();
    await adopt(await api('POST', `/api/runs/${encodeURIComponent(t.runId)}/terminal?${t.query}`, { member, ...size }).catch(showError));
  }
  async function openBranch(branch) {
    const size = await termSize();
    await adopt(await api('POST', `/api/projects/${encodeURIComponent(st.target.projectKey)}/terminal`, { branch, ...size }).catch(showError));
  }
  async function checkout(member) {
    const t = st.target;
    const r = await api('POST', `/api/runs/${encodeURIComponent(t.runId)}/checkout?${t.query}`, { members: [member] }).catch(showError);
    if (r) await refreshContext(true);
  }
  async function removeFolder(w) {
    const url = `/api/projects/${encodeURIComponent(st.target.projectKey)}/terminal/worktrees`;
    try {
      await api('DELETE', url, { branch: w.branch });
    } catch (e) {
      if (e.code !== 'DIRTY') { showError(e); return; }
      if (!(await confirm({ title: 'Discard uncommitted changes?', message: `${w.dir} has uncommitted changes. Removing it discards them. The branch itself stays.`, confirmLabel: 'Discard and remove', danger: true }))) return;
      await api('DELETE', url, { branch: w.branch, force: true }).catch(showError);
    }
    await refreshContext(true);
  }

  async function attach(id) {
    if (st.current && st.current !== id) sendWs({ type: 'term-detach', sessionId: st.current });
    st.current = id;
    st.lastSeq = 0;
    st.blocks = new Map();
    const s = st.sessions.get(id);
    st.line = s && s.mode === 'pipes' ? createLineEditor() : null;
    try {
      const term = await ensureTerm();
      term.reset();
      term.options.convertEol = !!(s && s.mode === 'pipes');
    } catch (e) { st.note = `The terminal could not load: ${e.message}`; }
    if (!s || s.status === 'running') sendWs({ type: 'term-attach', sessionId: id });
    loadBlocks(id);
    render();
  }
  async function loadBlocks(id) {
    const r = await api('GET', `/api/terminal/sessions/${encodeURIComponent(id)}`).catch(() => null);
    if (!r || st.current !== id) return;
    if (r.session && !st.sessions.has(id)) st.sessions.set(id, r.session);
    for (const b of r.blocks || []) st.blocks.set(b.seq, b);
    renderBlocks();
  }
  function stopCurrent() {
    if (st.current) api('POST', `/api/terminal/sessions/${encodeURIComponent(st.current)}/stop`).catch(showError);
  }
  async function closeCurrent() {
    const id = st.current;
    if (!id) return;
    if (!(await confirm({ title: 'Close this terminal?', message: 'The shell and anything still running in it are stopped. Its commands stay recorded.', confirmLabel: 'Close terminal' }))) return;
    await api('DELETE', `/api/terminal/sessions/${encodeURIComponent(id)}`).catch(showError);
  }

  // ── xterm ────────────────────────────────────────────────────────────────────────────────────────
  function themeNow() {
    const cs = win.getComputedStyle(screen);
    return { background: cs.backgroundColor, foreground: cs.color, cursor: cs.color, selectionBackground: win.getComputedStyle(probe).backgroundColor };
  }
  async function ensureTerm() {
    if (st.term) return st.term;
    const { Terminal, FitAddon } = await load();
    const term = new Terminal({ fontFamily: win.getComputedStyle(screen).fontFamily, fontSize: 12, cursorBlink: true, scrollback: 5000, theme: themeNow() });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(screen);
    term.onData((d) => onKeys(d));
    st.term = term;
    st.fit = fit;
    fitNow();
    if (typeof win.ResizeObserver === 'function') new win.ResizeObserver(() => fitNow()).observe(screen);
    return term;
  }
  let fitTimer = null;
  function fitNow() {
    if (!st.fit || root.hidden) return;
    try { st.fit.fit(); } catch { return; }
    win.clearTimeout(fitTimer);
    fitTimer = win.setTimeout(() => {
      if (st.current && st.term) sendWs({ type: 'term-resize', sessionId: st.current, cols: st.term.cols, rows: st.term.rows });
    }, 100);
  }
  function onKeys(data) {
    const s = st.sessions.get(st.current);
    if (!s || s.status !== 'running') return;
    if (!st.line) { sendWs({ type: 'term-input', sessionId: s.id, data }); return; }
    const r = st.line.feed(data);
    if (r.echo) st.term.write(r.echo);
    if (r.send) sendWs({ type: 'term-input', sessionId: s.id, data: r.send });
    if (r.interrupt) stopCurrent();
  }
  function runAgain(command) {
    const s = st.sessions.get(st.current);
    if (!s || s.status !== 'running') return;
    // Never type into a running program (a REPL, a prompt): only at the shell's prompt.
    if (s.currentBlock) { st.note = 'A command is still running in this terminal. Stop it first, or open another terminal.'; render(); return; }
    // Under a PTY, Ctrl+U first clears anything half-typed at the prompt; over pipes the line goes as is.
    sendWs({ type: 'term-input', sessionId: s.id, data: st.line ? `${command}\n` : `\x15${command}\r` });
    setTab('term');
  }

  // ── frames ───────────────────────────────────────────────────────────────────────────────────────
  function onFrame(msg) {
    if (msg.type === 'term-status' && msg.snapshot) {
      const prev = st.sessions.get(msg.snapshot.id);
      st.sessions.set(msg.snapshot.id, msg.snapshot);
      if (msg.snapshot.id === st.current && prev?.status === 'running' && msg.snapshot.status !== 'running' && st.term) {
        st.term.write(msg.snapshot.status === 'closed' ? '\r\n[terminal closed]\r\n'
          : `\r\n[shell exited${msg.snapshot.exitCode == null ? '' : ` with code ${msg.snapshot.exitCode}`}]\r\n`);
      }
      if (st.open) render();
      return;
    }
    if (msg.sessionId !== st.current) return;
    if (msg.type === 'term-replay') {
      if (st.term) { st.term.reset(); st.term.write(msg.data || ''); }
      st.lastSeq = msg.seq || 0;
      return;
    }
    if (msg.type === 'term-data') {
      if (msg.seq <= st.lastSeq) return;
      st.lastSeq = msg.seq;
      if (st.term) st.term.write(msg.data);
      return;
    }
    if (msg.type === 'term-block' && msg.block) {
      st.blocks.set(msg.block.seq, msg.block);
      renderBlocks();
    }
  }
  function onHello(msg) {
    const restarted = !!(st.bootId && msg.bootId && msg.bootId !== st.bootId);
    st.bootId = msg.bootId || st.bootId;
    if (restarted) {                                     // the server restarted: its shells are gone
      st.sessions.clear();
      if (st.open) refreshInfo().then(() => refreshContext(true));
      return;
    }
    if (st.current && st.sessions.get(st.current)?.status === 'running') sendWs({ type: 'term-attach', sessionId: st.current });
  }
  const onContextChange = () => { win.setTimeout(() => { if (!st.destroyed) refreshContext(); }, 0); };   // after showView syncs the hash

  // ── render ───────────────────────────────────────────────────────────────────────────────────────
  function render() {
    const s = st.sessions.get(st.current);
    picker.replaceChildren();
    const all = [...st.sessions.values()].sort((a, z) => (a.status === 'running' ? 0 : 1) - (z.status === 'running' ? 0 : 1) || z.createdAt.localeCompare(a.createdAt));
    picker.hidden = !all.length;
    for (const x of all) {
      const o = make('option', null, `${x.label || x.id} — ${x.status}`);
      o.value = x.id;
      o.selected = x.id === st.current;
      picker.append(o);
    }
    stopBtn.disabled = !(s && s.status === 'running');
    closeSessBtn.disabled = !(s && s.status === 'running');
    renderContext();
    renderBanners();
    renderBlocks();
    tabTerm.classList.toggle('on', st.tab === 'term');
    tabBlocks.classList.toggle('on', st.tab === 'blocks');
  }
  function setTab(tab) {
    st.tab = tab;
    screen.hidden = tab !== 'term';
    blocksEl.hidden = tab !== 'blocks';
    render();
    if (tab === 'term') fitNow();
  }

  function renderContext() {
    context.replaceChildren();
    if (!st.enabled) {
      context.append(make('p', 'term-note', 'The terminal is turned off on this hosted deployment. An administrator can enable it with WORCA_TERMINAL_REMOTE=1.'));
      return;
    }
    if (st.note) context.append(make('p', 'term-note term-error', st.note));
    const c = st.ctx;
    if (st.target.kind === 'run' && c) {
      if (c.members.length > 1) {
        const sel = make('select', 'term-member');
        sel.setAttribute('aria-label', 'Project');
        for (const m of c.members) { const o = make('option', null, m.projectName); o.value = m.projectKey; o.selected = m.projectKey === st.member; sel.append(o); }
        sel.addEventListener('change', () => {
          st.member = sel.value;
          const s = sessionsForTarget().find((x) => x.status === 'running');
          if (s) attach(s.id); else render();
        });
        context.append(sel);
      }
      const m = c.members.find((x) => x.projectKey === st.member) || c.members[0];
      if (!m) return;
      const attached = sessionsForTarget().some((x) => x.status === 'running');
      if (m.warning && !attached) context.append(make('p', 'term-warn', m.warning));
      if (m.state === 'needs-checkout') context.append(make('p', 'term-note', 'This run has no checkout yet.'), button('Check out', 'btn-primary term-checkout', () => checkout(m.projectKey)));
      else if (m.state === 'unavailable') context.append(make('p', 'term-note', m.reason || 'This run has no folder.'));
      else context.append(make('p', 'term-folder', m.cwd), button(attached ? 'Open another terminal' : 'Open terminal', 'btn-primary term-new', () => openRun(m.projectKey)));
      return;
    }
    if (st.target.kind === 'project' && c) {
      const sel = make('select', 'term-branch');
      sel.setAttribute('aria-label', 'Branch');
      for (const b of c.branches || []) { const o = make('option', null, b === c.current ? `${b} (current)` : b); o.value = b; o.selected = b === (st.branch || c.current); sel.append(o); }
      sel.addEventListener('change', () => { st.branch = sel.value; });
      context.append(sel, button('Open terminal', 'btn-primary term-new', () => openBranch(sel.value)));
      for (const w of c.worktrees || []) {
        const row = make('div', 'term-wt');
        row.append(make('span', 'term-folder', `${w.branch}${w.detached ? ' (detached)' : ''} — ${w.dir}`), button('Remove folder', 'btn-ghost term-wt-remove', () => removeFolder(w)));
        context.append(row);
      }
      return;
    }
    if (st.target.kind === 'pending') {
      context.append(make('p', 'term-note', 'This run is starting. Its folder is ready in a moment.'), button('Refresh', 'btn-ghost term-refresh', () => refreshContext(true)));
      return;
    }
    context.append(make('p', 'term-note', st.sessions.size
      ? 'Open a run or a project to start a new terminal, or pick an open one above.'
      : 'Open a run or a project to start a terminal.'));
  }

  function renderBanners() {
    banners.replaceChildren();
    const s = st.sessions.get(st.current);
    if (!s) return;
    if (s.mode === 'pipes') banners.append(make('p', 'term-banner', `Full-screen programs (vim, top, less) do not work here: ${st.pty.reason || 'node-pty is not available on this server'}. Commands, blocks and Stop still work.`));
    if (s.status === 'running' && s.runLive) banners.append(make('p', 'term-warn', 'This pipeline is still running and changing these files.'));
    if (s.folder === 'gone') banners.append(make('p', 'term-banner', 'This folder was removed when the run finished. Open a new terminal on the run to keep working.'));
    if (s.folder === 'replaced') banners.append(make('p', 'term-banner', 'This folder was re-created when the run finished. Run cd "$PWD" here, or open a new terminal.'));
  }

  function renderBlocks() {
    tabBlocks.textContent = st.blocks.size ? `Commands (${st.blocks.size})` : 'Commands';
    blocksEl.replaceChildren();
    const s = st.sessions.get(st.current);
    if (s && !s.integration) blocksEl.append(make('p', 'term-note', 'Commands are not recorded as blocks in this shell. Use bash or zsh to get them.'));
    for (const b of [...st.blocks.values()].sort((a, z) => z.seq - a.seq)) blocksEl.append(blockRow(b));
  }
  function blockRow(b) {
    const row = make('div', 'term-block');
    row.dataset.seq = String(b.seq);
    const lab = blockStatusLabel(b);
    const top = make('div', 'term-block-top');
    top.append(make('span', `term-badge term-badge-${lab.tone}`, lab.text), make('code', 'term-cmd', b.command));
    const when = b.startedAt ? new Date(b.startedAt).toLocaleTimeString() : '';
    const meta = make('div', 'term-block-meta', [b.runBy && b.runBy !== 'local' ? `by ${b.runBy}` : null, when, formatDuration(b.durationMs)].filter(Boolean).join(' · '));
    const out = make('pre', 'term-out');
    out.hidden = true;
    const copy = (text) => { try { win.navigator.clipboard?.writeText(text); } catch { /* no clipboard */ } };
    const acts = make('div', 'term-block-acts');
    acts.append(
      button('Output', 'btn-ghost', async () => {
        if (out.hidden && !out.textContent) {
          const full = await api('GET', `/api/terminal/sessions/${encodeURIComponent(b.sessionId)}/blocks/${b.seq}`).catch(showError);
          if (full) out.textContent = `${full.truncated ? `(earlier output trimmed; ${full.outputBytes} bytes in total)\n` : ''}${stripAnsi(full.output)}`;
        }
        out.hidden = !out.hidden;
      }),
      button('Copy', 'btn-ghost', () => copy(b.command)),
      button('Run again', 'btn-ghost', () => runAgain(b.command)),
      button('Copy link', 'btn-ghost', () => copy(`${win.location.origin}/?terminal=${encodeURIComponent(b.sessionId)}&block=${b.seq}`)),
    );
    row.append(top, meta, acts, out);
    return row;
  }

  // ── global listeners ─────────────────────────────────────────────────────────────────────────────
  // Capture phase (D16): inside the pane xterm takes Ctrl+` as a keystroke (NUL) and stops the event, so a
  // bubbling listener would never see it there.
  const onDocKey = (e) => {
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === '`' || e.code === 'Backquote')) { e.preventDefault(); e.stopPropagation(); toggle(); }
  };
  const onTheme = () => { if (st.term) st.term.options.theme = themeNow(); };
  const onHash = () => onContextChange();
  doc.addEventListener('keydown', onDocKey, true);
  doc.addEventListener('worca:theme', onTheme);
  win.addEventListener('hashchange', onHash);
  resizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const move = (ev) => { applyWidth((win.innerWidth || 0) - ev.clientX); fitNow(); };
    const up = () => {
      doc.removeEventListener('pointermove', move);
      doc.removeEventListener('pointerup', up);
      writeStore(WIDTH_KEY, String(parseInt(doc.body.style.getPropertyValue('--term-w'), 10) || DEFAULT_W));
    };
    doc.addEventListener('pointermove', move);
    doc.addEventListener('pointerup', up);
  });

  applyWidth(readStore(WIDTH_KEY));
  // D9: /?terminal=<id>&block=<seq> opens that session on its Commands tab.
  const link = new URLSearchParams(win.location.search || '');
  if (link.get('terminal')) {
    open().then(async () => {
      await attach(link.get('terminal'));
      setTab('blocks');
      const seq = link.get('block');
      const n = Number(seq);                               // a seq is an integer: no selector escaping needed
      if (Number.isInteger(n)) win.setTimeout(() => blocksEl.querySelector(`.term-block[data-seq="${n}"]`)?.scrollIntoView?.({ block: 'center' }), 300);
    });
  } else if (readStore(OPEN_KEY) === '1') {
    open();
  }

  function destroy() {
    st.destroyed = true;
    doc.removeEventListener('keydown', onDocKey, true);
    doc.removeEventListener('worca:theme', onTheme);
    win.removeEventListener('hashchange', onHash);
    try { st.term?.dispose(); } catch { /* already gone */ }
  }

  return { root, handle, open, close, toggle, isOpen: () => st.open, onFrame, onHello, onContextChange, destroy };
}
