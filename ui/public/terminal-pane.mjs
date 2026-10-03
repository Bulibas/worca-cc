// ui/public/terminal-pane.mjs — the terminal pane on the right of every page (issue #573). The shell
// runs on the worca server (src/core/terminal/manager.mjs); this pane draws it with xterm.js over /ws
// (term-* frames), follows the page (a run's folder, a project's own folder: opening the pane starts or
// reattaches that shell) and lists each recorded command as a block. Built in JS and appended to <body>,
// like the Ask dock: index.html is untouched.
import { createLineEditor } from './terminal-line.mjs';

const OPEN_KEY = 'worca-cc.terminal.open';
const WIDTH_KEY = 'worca-cc.terminal.width';
const MIN_W = 320;
const DEFAULT_W = 460;
const BLOCKS_PAGE = 200;     // GET /api/terminal/sessions/:id returns at most the newest 200 blocks (and totalBlocks)
// xterm's 16 ANSI colours, each read from a --term-ansi-* token (style.css), so both themes stay readable.
const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
const ansiToken = (name) => `--term-ansi-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/**
 * What the pane opens for this page: a run, a project (its own folder), or nothing new. The run id is the
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

export function createTerminalPane({ doc, win, fetch, sendWs, getPageContext, storage = null, loadXterm = null }) {
  const load = loadXterm || (() => defaultLoadXterm(doc));
  const st = { open: false, enabled: true, pty: { available: true, reason: null }, sessions: new Map(), current: null, lastSeq: 0,
    target: { kind: 'other' }, targetKey: '', ctx: null, ctxGen: 0, blocks: new Map(), blocksOlder: 0, view: 'term', term: null,
    fit: null, line: null, bootId: null, member: '', note: '', busy: '', online: true, destroyed: false,
    warnings: new Map(),         // session id → the warning its open returned (a detached branch copy): shown while attached
    tried: new Set(),            // start keys auto-started since the pane opened: each at most once (D3)
    starting: null,              // the start key whose shell is being made
    restartKey: null,            // Enter starts a new shell for this start key (the last one exited, or never started)
    why: null, focusNext: false, linking: false, pendingTimer: null };
  const rows = new Map();          // seq → { row, update }: Commands rows are patched in place, so an open Output stays open
  const drawn = { picker: '', context: '' };   // what the picker and the context bar show: unchanged → not rebuilt (an open select stays open)

  const make = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const button = (label, cls, onClick) => { const b = make('button', `btn ${cls}`.trim(), label); b.type = 'button'; b.addEventListener('click', onClick); return b; };
  const readStore = (k) => { try { return storage ? storage.getItem(k) : null; } catch { return null; } };
  const writeStore = (k, v) => { try { if (storage) storage.setItem(k, v); } catch { /* private mode */ } };
  function icon(paths) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ width: '15', height: '15', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
    for (const d of paths) { const p = doc.createElementNS(NS, 'path'); p.setAttribute('d', d); svg.append(p); }
    return svg;
  }
  const LIST_ICON = ['M9 6h11', 'M9 12h11', 'M9 18h11', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01'];
  const PROMPT_ICON = ['M5 7l5 5-5 5', 'M12 18h7'];

  // ── DOM ──────────────────────────────────────────────────────────────────────────────────────────
  const root = make('aside', 'term-pane');
  root.hidden = true;
  root.setAttribute('aria-label', 'Terminal');
  const resizer = make('div', 'term-resize');
  const head = make('div', 'term-head');
  const picker = make('select', 'term-sessions');
  picker.setAttribute('aria-label', 'Terminal session');
  picker.hidden = true;
  picker.addEventListener('change', () => { if (picker.value) attach(picker.value); });
  // One toggle between the terminal and its Commands list: pressed = the list is showing.
  const cmdsBtn = button('', 'btn-ghost term-icon term-cmds', () => setView(st.view === 'term' ? 'blocks' : 'term'));
  const hideBtn = button('×', 'btn-ghost term-icon term-hide', () => close());
  hideBtn.setAttribute('aria-label', 'Hide the terminal pane');
  hideBtn.title = 'Hide (the shell keeps running)';
  head.append(make('span', 'term-title', 'Terminal'), picker, cmdsBtn, hideBtn);
  const context = make('div', 'term-context');
  const banners = make('div', 'term-banners');
  const screen = make('div', 'term-screen');
  const probe = make('span', 'term-sel-probe');      // its token background becomes xterm's selection colour
  const ansiProbes = ANSI.map((name) => {            // their token colours become xterm's ANSI palette
    const p = make('span', 'term-ansi-probe');
    p.style.setProperty('color', `var(${ansiToken(name)})`);
    return [name, p];
  });
  // xterm opens in the host, which has no padding or border: FitAddon sizes rows and columns from its
  // parent's computed height and width, and under border-box those would include the frame's.
  const host = make('div', 'term-host');
  screen.append(probe, ...ansiProbes.map(([, p]) => p), host);
  const blocksEl = make('div', 'term-blocks');
  blocksEl.hidden = true;
  root.append(resizer, head, context, banners, screen, blocksEl);
  renderToggle();
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
  // app.js's sendWs returns false while /ws is down (reconnecting): the pane says so instead of
  // pretending the keys went through. onHello clears it.
  function send(obj) {
    const ok = sendWs(obj) !== false;
    if (!ok && st.online) { st.online = false; renderBanners(); }
    return ok;
  }

  // ── open / close / width ─────────────────────────────────────────────────────────────────────────
  function applyWidth(px) {
    const max = Math.round((win.innerWidth || 1600) * 0.6);
    const w = Math.max(MIN_W, Math.min(Number(px) || DEFAULT_W, max));
    doc.body.style.setProperty('--term-w', `${w}px`);
    return w;
  }
  /** `focus`: a person opened it (the edge tab, Ctrl+`): their next keys go to the shell. */
  async function open({ focus = false } = {}) {
    st.open = true;
    st.focusNext = focus;
    root.hidden = false;
    doc.body.classList.add('term-open');
    writeStore(OPEN_KEY, '1');
    await refreshInfo();
    await refreshContext(true);
    if (st.focusNext && st.current && st.term) { st.focusNext = false; focusTerm(); }
  }
  /** Hides the pane. The shell keeps running and stays attached; the next open may start one again. */
  function close() {
    st.open = false;
    root.hidden = true;
    doc.body.classList.remove('term-open');
    writeStore(OPEN_KEY, '0');
    st.tried.clear();
    win.clearTimeout(st.pendingTimer);
  }
  const toggle = () => (st.open ? close() : open({ focus: true }));
  const focusTerm = () => { try { st.term?.focus?.(); } catch { /* not drawn */ } };

  async function refreshInfo() {
    try {
      const info = await api('GET', '/api/terminal');
      st.enabled = !!info.enabled;
      st.pty = info.pty || st.pty;
      // The server's list is the truth: sessions it no longer has leave the picker. The attached one stays
      // (a permalink can attach a finished session the list does not carry).
      const keep = st.current && st.sessions.get(st.current);
      st.sessions = new Map((info.sessions || []).map((s) => [s.id, s]));
      if (keep && !st.sessions.has(keep.id)) st.sessions.set(keep.id, keep);
    } catch (e) { st.note = e.message; }
  }

  const newestFirst = (a, z) => String(z.createdAt || '').localeCompare(String(a.createdAt || ''));
  function sessionsForTarget() {
    const all = [...st.sessions.values()];
    if (st.target.kind === 'run') return all.filter((s) => s.runId === st.target.runId && (!st.member || s.member === st.member));
    if (st.target.kind === 'project') return all.filter((s) => s.scope === 'project' && s.projectKey === st.target.projectKey);
    if (st.target.kind === 'pending') return [];
    return all;
  }
  const memberNow = () => st.ctx?.members?.find((x) => x.projectKey === st.member) || st.ctx?.members?.[0] || null;
  /** What a new shell on this page would be: one per run member, or the project's own folder. null: none here. */
  function startKey() {
    if (st.target.kind === 'run') {
      const m = memberNow();
      return m && m.state !== 'unavailable' ? `${st.targetKey}|${m.projectKey}` : null;
    }
    if (st.target.kind === 'project') return st.ctx ? st.targetKey : null;
    return null;
  }

  // A live run gets its pipeline id a moment after it starts: look again until it has one.
  function schedulePending() {
    win.clearTimeout(st.pendingTimer);
    if (st.target.kind !== 'pending' || !st.open || st.destroyed) return;
    st.pendingTimer = win.setTimeout(() => {
      if (st.destroyed) return;
      refreshContext();
      if (st.target.kind === 'pending') schedulePending();
    }, 1500);
  }

  async function refreshContext(force = false) {
    const target = paneTargetOf(getPageContext ? getPageContext() : {});
    const key = JSON.stringify(target);
    if (!force && key === st.targetKey) return;
    const changed = key !== st.targetKey;
    const gen = ++st.ctxGen;                             // a later page change wins over this one's fetch
    st.targetKey = key;
    st.target = target;
    st.ctx = null;
    st.note = '';
    if (changed) st.restartKey = null;
    // A new page whose terminals do not include the attached one: let go of it now, so no keystroke reaches
    // a shell other than the one the context bar shows (its own running session is reattached below).
    if (changed && st.current && !sessionsForTarget().some((s) => s.id === st.current)) detachCurrent();
    schedulePending();
    if (!st.open || !st.enabled) { render(); return; }
    let ctx = null;
    try {
      if (target.kind === 'run') ctx = await api('GET', `/api/runs/${encodeURIComponent(target.runId)}/terminal?${target.query}`);
      else if (target.kind === 'project') ctx = await api('GET', `/api/projects/${encodeURIComponent(target.projectKey)}/terminal`);
    } catch (e) { if (gen === st.ctxGen) st.note = e.message; }
    if (gen !== st.ctxGen) return;
    st.ctx = ctx;
    for (const s of ctx?.sessions || []) st.sessions.set(s.id, s);
    if (target.kind === 'run' && ctx && !ctx.members.some((m) => m.projectKey === st.member)) st.member = ctx.members[0]?.projectKey || '';
    render();
    await follow();
    render();
  }

  /**
   * D3: the pane shows this page's shell. Its running session is reattached; with none, one is started,
   * at most once per start key while the pane is open (a later one needs Enter, see promptRestart).
   * Other pages start nothing: they keep the attached shell, or attach the newest running one.
   */
  async function follow() {
    const cur = st.sessions.get(st.current);
    const live = sessionsForTarget().filter((s) => s.status === 'running').sort(newestFirst);
    if (st.target.kind === 'other') {
      if (!(cur && cur.status === 'running') && live[0]) await attach(live[0].id);
      return;
    }
    const key = startKey();
    if (key && live.length) st.tried.add(key);            // this page has had its shell: a later one needs Enter
    if (cur && cur.status === 'running' && live.some((s) => s.id === cur.id)) return;
    if (live[0]) { await attach(live[0].id); return; }
    if (!key || st.starting === key || st.linking) return;
    if (st.tried.has(key)) { promptRestart(key); return; }
    st.tried.add(key);
    await start(key);
  }

  /** A dim line in the terminal; Enter (that keypress only) then starts a new shell for `key`. Never on its own. */
  function promptRestart(key, why = st.why) {
    st.why = null;
    if (st.restartKey === key) return;
    st.restartKey = key;
    const text = why ? `[${why} — press Enter for a new one]` : '[no shell here — press Enter to start one]';
    ensureTerm().then((t) => { if (st.restartKey === key) t.write(`\r\n\x1b[2m${text}\x1b[0m\r\n`); }).catch(() => {});
  }

  // ── sessions ─────────────────────────────────────────────────────────────────────────────────────
  async function termSize() {
    try { await ensureTerm(); return { cols: st.term.cols, rows: st.term.rows }; } catch { return { cols: 100, rows: 30 }; }
  }
  /** Starts this page's shell. Attached only if the page still wants it; otherwise it waits in the picker. */
  async function start(key) {
    st.starting = key;
    st.restartKey = null;
    render();
    let r = null;
    try {
      r = st.target.kind === 'run' ? await startRun(key) : await startProject();
    } finally {
      if (st.starting === key) st.starting = null;
      st.busy = '';
    }
    if (!r) { if (startKey() === key) promptRestart(key); render(); return; }
    st.sessions.set(r.session.id, r.session);
    if (r.warning) st.warnings.set(r.session.id, r.warning);
    if (startKey() === key) { st.note = ''; await attach(r.session.id); }
    render();
  }
  async function startRun(key) {
    const t = st.target;
    let m = memberNow();
    if (m.state === 'needs-checkout') {                  // a finished run with no checkout: make it, then start there
      st.busy = 'Making a checkout of this run…';
      render();
      const ok = await api('POST', `/api/runs/${encodeURIComponent(t.runId)}/checkout?${t.query}`, { members: [m.projectKey] }).catch(showError);
      if (!ok || startKey() !== key) return null;
      const ctx = await api('GET', `/api/runs/${encodeURIComponent(t.runId)}/terminal?${t.query}`).catch(showError);
      if (!ctx || startKey() !== key) return null;
      st.ctx = ctx;
      m = memberNow();
      if (!m?.cwd) { st.note = m?.reason || 'This run has no folder.'; return null; }
    }
    const size = await termSize();
    if (startKey() !== key) return null;
    return api('POST', `/api/runs/${encodeURIComponent(t.runId)}/terminal?${t.query}`, { member: m.projectKey, ...size }).catch(showError);
  }
  async function startProject() {
    const size = await termSize();
    return api('POST', `/api/projects/${encodeURIComponent(st.target.projectKey)}/terminal`, size).catch(showError);
  }

  /** Forgets the attached session: the screen, its commands and any half-typed line. */
  function resetCurrent() {
    st.current = null;
    st.lastSeq = 0;
    st.blocks = new Map();
    st.blocksOlder = 0;
    st.line = null;
    rows.clear();
    try { st.term?.reset(); } catch { /* not drawn yet */ }
  }
  function detachCurrent() {
    if (st.current) send({ type: 'term-detach', sessionId: st.current });
    resetCurrent();
  }

  async function attach(id) {
    if (st.current && st.current !== id) send({ type: 'term-detach', sessionId: st.current });
    resetCurrent();
    st.current = id;
    st.restartKey = null;
    const s = st.sessions.get(id);
    st.line = s && s.mode === 'pipes' ? createLineEditor() : null;
    try {
      const term = await ensureTerm();
      term.reset();
      term.options.convertEol = !!(s && s.mode === 'pipes');
    } catch (e) { st.note = `The terminal could not load: ${e.message}`; }
    if (!s || s.status === 'running') send({ type: 'term-attach', sessionId: id });
    const blocks = loadBlocks(id);
    render();
    fitNow();                                            // the width may have changed since the session started
    if (st.focusNext && st.open) { st.focusNext = false; focusTerm(); }
    return blocks;
  }
  async function loadBlocks(id) {
    const r = await api('GET', `/api/terminal/sessions/${encodeURIComponent(id)}`).catch(() => null);
    if (!r || st.current !== id) return;
    if (r.session && !st.sessions.has(id)) st.sessions.set(id, r.session);
    // The server sends the newest BLOCKS_PAGE commands and how many there are in all. Older ones are
    // counted, not listed (null: a full page from a server that does not say, so maybe some).
    const listed = (r.blocks || []).length;
    st.blocksOlder = Number.isInteger(r.totalBlocks) ? Math.max(0, r.totalBlocks - listed) : (listed >= BLOCKS_PAGE ? null : 0);
    for (const b of r.blocks || []) st.blocks.set(b.seq, b);
    renderBlocks();
  }
  /** A permalink's command, fetched on its own when it is older than the newest page. */
  async function ensureBlock(id, seq) {
    if (st.blocks.has(seq)) return true;
    const b = await api('GET', `/api/terminal/sessions/${encodeURIComponent(id)}/blocks/${seq}`).catch(() => null);
    if (!b || st.current !== id) return false;
    if (st.blocksOlder) st.blocksOlder -= 1;             // it is listed now
    st.blocks.set(seq, { ...b, output: undefined });
    renderBlocks();
    return true;
  }
  function stopCurrent() {
    if (st.current) api('POST', `/api/terminal/sessions/${encodeURIComponent(st.current)}/stop`).catch(showError);
  }
  // ── xterm ────────────────────────────────────────────────────────────────────────────────────────
  function themeNow() {
    const cs = win.getComputedStyle(screen);
    const theme = { background: cs.backgroundColor, foreground: cs.color, cursor: cs.color, selectionBackground: win.getComputedStyle(probe).backgroundColor };
    for (const [name, p] of ansiProbes) {
      const c = win.getComputedStyle(p).color;
      if (c) theme[name] = c;                            // unresolved (no stylesheet): xterm keeps its default
    }
    return theme;
  }
  async function ensureTerm() {
    if (st.term) return st.term;
    const { Terminal, FitAddon } = await load();
    const term = new Terminal({ fontFamily: win.getComputedStyle(screen).fontFamily, fontSize: 12, cursorBlink: true, scrollback: 5000, theme: themeNow() });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    term.onData((d) => onKeys(d));
    st.term = term;
    st.fit = fit;
    fitNow();
    if (typeof win.ResizeObserver === 'function') new win.ResizeObserver(() => fitNow()).observe(host);
    return term;
  }
  let fitTimer = null;
  function fitNow() {
    if (!st.fit || root.hidden) return;
    try { st.fit.fit(); } catch { return; }
    win.clearTimeout(fitTimer);
    fitTimer = win.setTimeout(() => {
      if (st.current && st.term) send({ type: 'term-resize', sessionId: st.current, cols: st.term.cols, rows: st.term.rows });
    }, 100);
  }
  function onKeys(data) {
    const s = st.sessions.get(st.current);
    if (!s || s.status !== 'running') {
      // No shell: Enter starts a new one for this page (and is not sent anywhere); other keys do nothing.
      if (st.restartKey && st.online && /[\r\n]/.test(data) && st.restartKey === startKey() && !st.starting) start(st.restartKey);
      return;
    }
    if (!st.online) return;                              // reconnecting: the banner says keys are not sent
    if (!st.line) { send({ type: 'term-input', sessionId: s.id, data }); return; }
    const r = st.line.feed(data);
    if (r.echo) st.term.write(r.echo);
    if (r.send && !send({ type: 'term-input', sessionId: s.id, data: r.send })) st.term.write('[not sent: reconnecting]\r\n');
    if (r.interrupt) stopCurrent();                      // over pipes Ctrl+C has no tty to reach: the stop API does it
  }
  function runAgain(command) {
    const s = st.sessions.get(st.current);
    if (!s || s.status !== 'running') return;
    // Never type into a running program (a REPL, a prompt): only at the shell's prompt.
    if (s.currentBlock) { st.note = 'A command is still running in this terminal. Stop it first with Ctrl+C.'; render(); return; }
    if (!st.online) return;
    // Under a PTY, Ctrl+U first clears anything half-typed at the prompt. Over pipes the half-typed line is
    // only ours: drop it (and its echo), then echo the command, as the shell will not.
    if (st.line && st.term) st.term.write(`${st.line.clear()}${command}\r\n`);
    send({ type: 'term-input', sessionId: s.id, data: st.line ? `${command}\n` : `\x15${command}\r` });
    setView('term');
  }

  // ── frames ───────────────────────────────────────────────────────────────────────────────────────
  function onFrame(msg) {
    if (msg.type === 'term-status' && msg.snapshot) {
      const prev = st.sessions.get(msg.snapshot.id);
      st.sessions.set(msg.snapshot.id, msg.snapshot);
      if (msg.snapshot.id === st.current && prev?.status === 'running' && msg.snapshot.status !== 'running' && st.term) {
        // `exit`, a crash or a close: say so, and never start another shell unasked (Enter does).
        const why = msg.snapshot.status === 'closed' ? 'terminal closed'
          : `shell exited${msg.snapshot.exitCode == null ? '' : ` with code ${msg.snapshot.exitCode}`}`;
        const key = startKey();
        if (key) { st.restartKey = null; promptRestart(key, why); } else st.term.write(`\r\n\x1b[2m[${why}]\x1b[0m\r\n`);
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
    const wasOffline = !st.online;
    st.online = true;
    if (restarted) {                                     // the server restarted: its shells are gone, and none respawns
      const had = st.current;
      resetCurrent();
      st.sessions.clear();
      if (had) st.why = 'the worca server restarted';
      const say = () => {
        if (!had || st.current) return;
        st.note = 'The worca server restarted, which closed its terminals. Press Enter in the terminal for a new one.';
        const key = startKey();
        if (key) promptRestart(key);
        st.why = null;
        render();
      };
      if (st.open) refreshInfo().then(() => refreshContext(true)).then(say);
      else { render(); say(); }
      return;
    }
    if (st.current && st.sessions.get(st.current)?.status === 'running') send({ type: 'term-attach', sessionId: st.current });
    if (wasOffline) renderBanners();
  }
  /** app.js tells the pane when /ws drops; onHello says it is back. */
  function onConnection(up) {
    if (!!up === st.online) return;
    st.online = !!up;
    renderBanners();
  }
  const onContextChange = () => { win.setTimeout(() => { if (!st.destroyed) refreshContext(); }, 0); };   // after showView syncs the hash

  // ── render ───────────────────────────────────────────────────────────────────────────────────────
  function render() {
    // The picker lists the open (running) terminals, and the attached one: shown only when there is a choice.
    const all = [...st.sessions.values()].filter((x) => x.status === 'running' || x.id === st.current)
      .sort((a, z) => (a.status === 'running' ? 0 : 1) - (z.status === 'running' ? 0 : 1) || newestFirst(a, z));
    const pickerKey = JSON.stringify([st.current, all.map((x) => [x.id, x.label, x.status])]);
    if (pickerKey !== drawn.picker) {
      drawn.picker = pickerKey;
      picker.replaceChildren();
      picker.hidden = all.length < 2;
      if (all.length && !st.sessions.has(st.current)) {   // nothing attached: say so rather than show another shell's name
        const o = make('option', null, 'Pick a terminal');
        o.value = ''; o.selected = true; o.disabled = true;
        picker.append(o);
      }
      for (const x of all) {
        const o = make('option', null, x.status === 'running' ? (x.label || x.id) : `${x.label || x.id} — ${x.status}`);
        o.value = x.id;
        o.selected = x.id === st.current;
        picker.append(o);
      }
    }
    renderContext();
    renderBanners();
    renderBlocks();
    renderToggle();
  }
  function renderToggle() {
    const list = st.view === 'blocks';
    const label = list ? 'Back to terminal' : 'Commands';
    if (cmdsBtn.getAttribute('aria-label') === label) return;
    cmdsBtn.setAttribute('aria-label', label);
    cmdsBtn.setAttribute('aria-pressed', String(list));
    cmdsBtn.replaceChildren(icon(list ? PROMPT_ICON : LIST_ICON));
  }
  function setView(view) {
    st.view = view;
    screen.hidden = view !== 'term';
    blocksEl.hidden = view !== 'blocks';
    render();
    if (view === 'term') { fitNow(); focusTerm(); }
  }

  const LIVE_WARNING = 'This pipeline is still running and changing these files.';
  /** The amber line of the attached shell: a live run's (while it runs), or what its open returned. */
  function sessionWarning(s) {
    if (s.scope === 'run') return s.status === 'running' && s.runLive ? (st.warnings.get(s.id) || LIVE_WARNING) : null;
    return st.warnings.get(s.id) || null;
  }
  /** What the context line shows, as data: it is rebuilt only when this changes (an open select stays open). */
  function contextParts() {
    if (!st.enabled) return [['note', 'The terminal is turned off on this hosted deployment. An administrator can enable it with WORCA_TERMINAL_REMOTE=1.']];
    const parts = [];
    if (st.note) parts.push(['error', st.note]);
    if (st.busy) parts.push(['note', st.busy]);
    const s = st.sessions.get(st.current);
    const c = st.ctx;
    const m = st.target.kind === 'run' ? memberNow() : null;
    if (m && c.members.length > 1) parts.push(['members', c.members.map((x) => [x.projectKey, x.projectName]), st.member]);
    if (m && m.state === 'unavailable' && !s) parts.push(['note', m.reason || 'This run has no folder.']);
    const folder = s?.cwd || m?.cwd || (st.target.kind === 'project' ? c?.dir : null);
    if (folder) parts.push(['folder', folder]);
    const warn = s ? sessionWarning(s) : m?.warning;
    if (warn) parts.push(['warn', warn]);
    if (st.target.kind === 'pending') parts.push(['note', 'This run is starting. Its terminal opens in a moment.']);
    if (st.target.kind === 'other' && !s) parts.push(['note', 'Open a run or a project to start a terminal.']);
    return parts;
  }
  function renderContext() {
    const parts = contextParts();
    const key = JSON.stringify(parts);
    if (key === drawn.context) return;
    drawn.context = key;
    context.replaceChildren();
    for (const [kind, value, chosen] of parts) {
      if (kind === 'members') {
        const sel = make('select', 'term-member');
        sel.setAttribute('aria-label', 'Project');
        for (const [k, name] of value) { const o = make('option', null, name); o.value = k; o.selected = k === chosen; sel.append(o); }
        sel.addEventListener('change', () => {
          st.member = sel.value;
          st.restartKey = null;
          // this project's shell, never the other's: let go first, then follow (attach or start once)
          if (st.current && !sessionsForTarget().some((x) => x.id === st.current)) detachCurrent();
          render();
          follow().then(render);
        });
        context.append(sel);
      } else if (kind === 'folder') {
        const f = make('span', 'term-folder', value);
        f.title = value;
        context.append(f);
      } else {
        context.append(make('p', { error: 'term-note term-error', warn: 'term-warn', note: 'term-note' }[kind], value));
      }
    }
  }

  function renderBanners() {
    banners.replaceChildren();
    const s = st.sessions.get(st.current);
    if (!st.online && st.open) banners.append(make('p', 'term-warn term-offline', 'Reconnecting to the worca server. Keys typed now are not sent.'));
    root.classList.toggle('term-is-offline', !st.online);
    if (!s) return;
    if (s.mode === 'pipes') banners.append(make('p', 'term-banner', `Full-screen programs (vim, top, less) do not work here: ${st.pty.reason || 'node-pty is not available on this server'}. Commands, blocks and Ctrl+C still work.`));
    if (s.folder === 'gone') banners.append(make('p', 'term-banner', 'This folder was removed when the run finished. Type exit, then press Enter for a new terminal on the run.'));
    if (s.folder === 'replaced') banners.append(make('p', 'term-banner', 'This folder was re-created when the run finished. Run cd "$PWD" here, or type exit and press Enter for a new terminal.'));
  }

  // Rows are kept by seq and patched (status, meta): rebuilding them would close an expanded Output.
  const noteNoBlocks = make('p', 'term-note', 'Commands are not recorded as blocks in this shell. Use bash or zsh to get them.');
  const noteTrimmed = make('p', 'term-note term-trimmed');
  function renderBlocks() {
    // The list is the newest page plus what arrived since; the count is every command (or "+" when unknown).
    const shown = st.blocks.size;
    const total = st.blocksOlder == null ? null : shown + st.blocksOlder;
    cmdsBtn.title = shown ? `Commands (${total == null ? `${shown}+` : total})` : 'Commands';
    noteTrimmed.textContent = `Showing the latest ${shown}${total == null ? '' : ` of ${total}`} commands. Older ones are recorded but not listed here.`;
    const s = st.sessions.get(st.current);
    const want = [];
    if (s && !s.integration) want.push(noteNoBlocks);
    const sorted = [...st.blocks.values()].sort((a, z) => z.seq - a.seq);
    for (const b of sorted) {
      let r = rows.get(b.seq);
      if (!r) { r = blockRow(b); rows.set(b.seq, r); }
      r.update(b);
      want.push(r.row);
    }
    for (const seq of [...rows.keys()]) if (!st.blocks.has(seq)) rows.delete(seq);
    if (st.blocksOlder !== 0) want.push(noteTrimmed);
    const have = [...blocksEl.children];
    if (have.length !== want.length || have.some((n, i) => n !== want[i])) blocksEl.replaceChildren(...want);   // moving keeps each row's state
  }
  function blockRow(b) {
    const row = make('div', 'term-block');
    row.dataset.seq = String(b.seq);
    const badge = make('span', 'term-badge');
    const top = make('div', 'term-block-top');
    top.append(badge, make('code', 'term-cmd', b.command));
    const meta = make('div', 'term-block-meta');
    const out = make('pre', 'term-out');
    out.hidden = true;
    const copy = (text) => { try { win.navigator.clipboard?.writeText(text); } catch { /* no clipboard */ } };
    const acts = make('div', 'term-block-acts');
    acts.append(
      button('Output', 'btn-ghost btn-mini', async () => {
        if (out.hidden && !out.textContent) {
          const full = await api('GET', `/api/terminal/sessions/${encodeURIComponent(b.sessionId)}/blocks/${b.seq}`).catch(showError);
          if (full) out.textContent = `${full.truncated ? `(earlier output trimmed; ${full.outputBytes} bytes in total)\n` : ''}${stripAnsi(full.output)}`;
        }
        out.hidden = !out.hidden;
      }),
      button('Copy', 'btn-ghost btn-mini', () => copy(b.command)),
      button('Run again', 'btn-ghost btn-mini', () => runAgain(b.command)),
      button('Copy link', 'btn-ghost btn-mini', () => copy(`${win.location.origin}/?terminal=${encodeURIComponent(b.sessionId)}&block=${b.seq}`)),
    );
    row.append(top, meta, acts, out);
    let status = null;
    const update = (nb) => {
      const lab = blockStatusLabel(nb);
      badge.className = `term-badge term-badge-${lab.tone}`;
      badge.textContent = lab.text;
      const when = nb.startedAt ? new Date(nb.startedAt).toLocaleTimeString() : '';
      meta.textContent = [nb.runBy && nb.runBy !== 'local' ? `by ${nb.runBy}` : null, when, formatDuration(nb.durationMs)].filter(Boolean).join(' · ');
      // A fetched output of a command that has since finished is stale: closed, it is fetched again next time.
      if (status && status !== nb.status && out.hidden) out.textContent = '';
      status = nb.status;
    };
    return { row, update };
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
    st.linking = true;                                     // the link's session, not a new shell for this page
    open().then(async () => {
      const id = link.get('terminal');
      await attach(id);
      st.linking = false;
      setView('blocks');
      const seq = link.get('block');
      const n = Number(seq);                               // a seq is an integer: no selector escaping needed
      if (seq == null || !Number.isInteger(n)) return;
      // The list carries the newest commands only: an older one is fetched on its own; a missing one is said.
      if (!(await ensureBlock(id, n))) { if (st.current === id) { st.note = `Command #${n} of this terminal was not found.`; render(); } return; }
      win.setTimeout(() => blocksEl.querySelector(`.term-block[data-seq="${n}"]`)?.scrollIntoView?.({ block: 'center' }), 300);
    });
  } else if (readStore(OPEN_KEY) === '1') {
    open();
  }

  function destroy() {
    st.destroyed = true;
    win.clearTimeout(st.pendingTimer);
    doc.removeEventListener('keydown', onDocKey, true);
    doc.removeEventListener('worca:theme', onTheme);
    win.removeEventListener('hashchange', onHash);
    try { st.term?.dispose(); } catch { /* already gone */ }
  }

  return { root, handle, open, close, toggle, isOpen: () => st.open, onFrame, onHello, onConnection, onContextChange, destroy };
}
