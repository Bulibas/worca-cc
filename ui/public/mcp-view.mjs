// ui/public/mcp-view.mjs
// Settings › MCP servers (docs/mcp-servers.md): the Sets view (configure), the Servers view (read-only
// catalog), the member cards and Add server — plus the project MCP tab, the workspace overview card
// and the Settings › Ask Worca block. The manual definition form is mcp-definition-form.mjs.
// Every write goes through `api(method, path, body)` and repaints from the server's read models; no
// secret value is ever fetched. The modal shells (#plugin-modal, confirm) are app.js's, passed in.
import { relTime } from './plugins-view.mjs';
import { compileDefinition, formFromDefinition, blankDefinitionForm, createDefinitionForm } from './mcp-definition-form.mjs';

const enc = encodeURIComponent;
function h(doc, tag, cls, text) {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function button(doc, cls, label, data = {}) {
  const b = h(doc, 'button', cls, label);
  b.type = 'button';
  Object.assign(b.dataset, data);
  return b;
}

// ── routes: #settings/mcp (General), #settings/mcp/sets/<id>, #settings/mcp/servers ─────────────────
export function parseMcpParam(sub = '') {
  if (sub === 'servers') return { view: 'servers', setId: null };
  if (sub.startsWith('sets/') && sub.length > 5) {
    let setId = sub.slice(5);
    try { setId = decodeURIComponent(setId); } catch { /* a malformed %-escape reads as typed: the set GET refuses it (400), show() never throws */ }
    return { view: 'sets', setId };
  }
  return { view: 'sets', setId: 'general' };
}
export function mcpRoute(setId) {
  if (setId === null) return 'settings/mcp/servers';
  return setId === 'general' ? 'settings/mcp' : `settings/mcp/sets/${enc(setId)}`;
}

// The team-requirements strip (docs/team-policy.md) is filled by team-policy code: fn(el) after each render.
let stripRenderer = null;
export function setMcpStripRenderer(fn) { stripRenderer = fn; }

/** A member card's state line (spec §7.1). */
export function memberStateText(m, now = Date.now()) {
  if (m.testing) return { text: 'testing…', tone: '' };
  if (m.problem) return { text: m.reason.startsWith('missing:') ? `${m.problem} · skipped until set` : m.problem, tone: 'err' };
  if (m.reason === 'off' || m.reason === 'needs-consent') return { text: 'off', tone: '' };
  if (!m.test) return { text: 'not tested', tone: '' };
  if (!m.test.ok) return { text: m.test.error === 'token rejected' ? 'token rejected' : `test failed: ${m.test.error}`, tone: 'err' };
  if (m.test.stale) return { text: 'stale · test again', tone: 'warn' };
  if (m.tooLong) return { text: `tool too long for ${m.tooLong.limit}: ${m.tooLong.tool}`, tone: 'warn' };
  return { text: `${m.test.tools} tools · tested ${relTime(m.test.at, now)}`, tone: 'ok' };
}

// ── field inputs for one membership (Add server; values and secrets of a set) ────────────────────
function fieldInputs(doc, fields) {
  const root = h(doc, 'div', 'mcp-fields');
  for (const f of fields) {
    const row = h(doc, 'div', 'field');
    row.appendChild(h(doc, 'label', '', f.label + (f.required ? '' : ' (optional)')));
    const inp = h(doc, 'input', 'input mono');
    inp.type = f.secret ? 'password' : 'text';
    inp.dataset.input = f.key;
    inp.dataset.secret = f.secret ? '1' : '';
    inp.value = '';   // empty keeps the definition's default, so a later default change still reaches this set
    inp.placeholder = f.secret ? '' : (f.default || '');
    inp.autocomplete = 'off';
    inp.setAttribute('aria-label', f.label);
    row.appendChild(inp);
    if (f.secret) {
      const env = h(doc, 'input', 'input mono');
      Object.assign(env, { type: 'text', placeholder: 'or read it from an MCP_… variable', autocomplete: 'off' });
      env.dataset.env = f.key;
      env.setAttribute('aria-label', `${f.label} variable`);
      row.appendChild(env);
    }
    root.appendChild(row);
  }
  return root;
}
/** Inputs → `{ values, secrets }`; an empty secret keeps what is stored. */
export function collectFieldInputs(root) {
  const values = {};
  const secrets = {};
  for (const i of root.querySelectorAll('[data-input]')) {
    const env = root.querySelector(`[data-env="${i.dataset.input}"]`);
    if (!i.dataset.secret) values[i.dataset.input] = i.value.trim();
    else if (env && env.value.trim()) secrets[i.dataset.input] = { $env: env.value.trim() };
    else if (i.value) secrets[i.dataset.input] = i.value;
  }
  return { values, secrets };
}

// ── the Settings tab controller ──────────────────────────────────────────────────────────────────
export function createMcpView({ host, api, navigate, confirm, modal, doc = globalThis.document, now = () => Date.now() }) {
  const st = { view: 'sets', setId: 'general', sets: null, set: null, servers: null, testing: new Set(), msg: '', msgKind: '' };
  const say = (text, kind = '') => { st.msg = text; st.msgKind = kind; const el = host.querySelector('.form-msg'); if (el) { el.textContent = text; el.className = `form-msg${kind ? ` ${kind}` : ''}`; } };
  const fail = (r) => say((r.data && r.data.error) || `HTTP ${r.status}`, 'err');
  const setPath = (id) => `/api/mcp/sets/${enc(id)}`;
  const isTeam = (set) => set.group === 'team';
  const memberPath = (id, serverId) => `${setPath(id)}/members/${enc(serverId)}`;

  // Only the latest load paints: a slower answer for a set the user already left never lands (the
  // cards on screen, and so every write they make, always belong to the set they were painted from).
  let loadSeq = 0;
  async function load() {
    const seq = ++loadSeq;
    if (st.view === 'servers') {
      const [r, s] = await Promise.all([api('GET', '/api/mcp/servers'), st.sets ? null : api('GET', '/api/mcp/sets')]);
      if (seq !== loadSeq) return;
      st.servers = r.ok ? r.data.servers : [];
      if (s) st.sets = s.ok ? s.data.sets : [];
      if (!r.ok) fail(r);
      else if (r.data.newer) say('MCP registry files need a newer Worca', 'err');
    } else {
      const [l, s] = await Promise.all([api('GET', '/api/mcp/sets'), api('GET', setPath(st.setId))]);
      if (seq !== loadSeq) return;
      st.sets = l.ok ? l.data.sets : [];
      st.set = s.ok ? s.data : null;
      if (!s.ok) fail(s);
      else if (l.data.newer) say('MCP registry files need a newer Worca', 'err');
    }
    paint();
  }

  function topbar() {
    const bar = h(doc, 'div', 'topbar');
    const title = h(doc, 'div');
    title.append(h(doc, 'h1', '', 'MCP servers'), h(doc, 'div', 'sub', 'Servers worca’s agents and Ask Worca can call, grouped in sets that hold their configuration'));
    const seg = h(doc, 'div', 'seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'View');
    for (const [v, label] of [['sets', 'Sets'], ['servers', 'Servers']]) {
      const b = button(doc, st.view === v ? 'on' : '', label, { mcpView: v });
      b.setAttribute('aria-pressed', String(st.view === v));
      seg.appendChild(b);
    }
    const primary = st.view === 'sets' ? button(doc, 'btn-go', 'New set', { act: 'new-set' }) : button(doc, 'btn-go', 'Add MCP server', { act: 'add-server' });
    bar.append(title, seg, primary);
    return bar;
  }

  function usedByText(s) {
    if (s.group === 'general') return `Ask Worca · ${s.usedBy.length} project${s.usedBy.length === 1 ? '' : 's'}`;
    if (s.greyed) return `no project here follows ${s.home}`;
    return s.usedBy.length ? s.usedBy.map((p) => p.name).join(', ') : 'no projects';
  }

  function setList() {
    const list = h(doc, 'div', 'card mcp-setlist');
    for (const s of st.sets || []) {
      const row = button(doc, `mcp-setrow${s.id === (st.set ? st.set.set.id : st.setId) ? ' on' : ''}${s.greyed ? ' greyed' : ''}`, null, { set: s.id });
      const head = h(doc, 'span', 'mcp-setrow-head');
      head.appendChild(h(doc, 'b', '', s.name));
      if (s.group === 'general') head.appendChild(h(doc, 'span', 'badge', 'Built in'));
      if (s.problem) { const dot = h(doc, 'span', 'mcp-dot'); dot.setAttribute('aria-label', 'Has a problem'); head.appendChild(dot); }
      row.append(head, h(doc, 'small', 'hint', `${s.serverCount} server${s.serverCount === 1 ? '' : 's'} · ${usedByText(s)}`));
      list.appendChild(row);
    }
    return list;
  }

  function memberCard(set, m) {
    const team = set.group === 'team';
    const card = h(doc, 'div', 'card mcp-member');
    card.dataset.server = m.serverId;
    const head = h(doc, 'div', 'pl-head');
    const sw = h(doc, 'label', 'pl-enable');
    const cb = h(doc, 'input', 'sw-input');
    cb.type = 'checkbox';
    cb.checked = m.enabled;
    cb.dataset.toggle = m.serverId;
    cb.disabled = team && !m.team.consented;
    cb.setAttribute('aria-label', `Use ${m.copy} in ${set.name}`);
    sw.append(cb, h(doc, 'span', 'switch switch-sm'));
    head.append(sw, h(doc, 'b', 'mono', m.copy));
    if (m.provisional) head.appendChild(h(doc, 'span', 'badge amber', 'name provisional'));
    head.appendChild(h(doc, 'span', 'badge', m.sourceLabel));
    head.appendChild(h(doc, 'span', 'mono hint', m.type || ''));
    head.appendChild(h(doc, 'span', 'hint', m.description));
    const test = button(doc, 'btn-ghost btn-mini', 'Test', { test: m.serverId });
    test.disabled = team && !m.team.consented;
    head.appendChild(test);
    if (!team) head.appendChild(button(doc, 'btn-ghost btn-mini', 'Remove', { remove: m.serverId }));
    card.appendChild(head);
    if (team && !m.team.consented) card.appendChild(h(doc, 'small', 'hint', 'Turn on in the team checklist'));
    for (const f of m.fields) {
      const row = h(doc, 'div', 'mcp-fld');
      row.appendChild(h(doc, 'label', 'mcp-fl', f.label));
      if (f.secret) {
        const box = h(doc, 'div', 'mcp-secret');
        if (f.state.set) {
          box.appendChild(h(doc, 'span', 'mono', f.state.env ? `$${f.state.env}` : '••••••••'));
          if (f.oauth) box.appendChild(h(doc, 'span', 'badge', 'OAuth'));
          box.appendChild(h(doc, 'span', `badge${f.state.old ? ' amber' : ''}`, `set · updated ${relTime(f.state.updatedAt, now())}`));
          box.appendChild(button(doc, 'btn-ghost btn-mini', 'Replace', { secret: f.key, server: m.serverId }));
        } else {
          box.appendChild(h(doc, 'span', 'hint err', 'not set'));
          box.appendChild(button(doc, 'btn btn-primary btn-mini', 'Set', { secret: f.key, server: m.serverId }));
        }
        row.appendChild(box);
      } else {
        const inp = h(doc, 'input', 'input mono');
        Object.assign(inp, { type: 'text', value: f.value, placeholder: f.default || '' });
        inp.dataset.field = f.key;
        inp.dataset.server = m.serverId;
        inp.dataset.saved = f.value;   // what the set holds: a change or a focusout saves only a different value
        inp.setAttribute('aria-label', f.label);
        row.appendChild(inp);
      }
      card.appendChild(row);
      const tip = team && m.team.suggests.find((x) => x.key === f.key);
      if (tip) {
        const note = h(doc, 'small', 'hint mcp-suggest', `Team suggests ${tip.value} · `);
        note.appendChild(button(doc, 'linkish', 'Use team value', { useTeam: f.key, server: m.serverId, value: tip.value }));
        card.appendChild(note);
      }
    }
    const state = memberStateText({ ...m, testing: st.testing.has(`${set.id}|${m.serverId}`) }, now());
    card.appendChild(h(doc, 'div', `mcp-state hint${state.tone ? ` ${state.tone}` : ''}`, state.text));
    return card;
  }

  function setDetail() {
    const card = h(doc, 'section', 'card mcp-set');
    if (!st.set) { card.appendChild(h(doc, 'div', 'hist-empty', 'No such set.')); return card; }
    const { set, members } = st.set;
    const user = set.group === 'set';
    const head = h(doc, 'div', 'card-head');
    head.appendChild(h(doc, 'h2', '', set.name));
    const acts = h(doc, 'div', 'pl-actions');
    if (user) acts.appendChild(button(doc, 'btn-ghost btn-mini', 'Rename', { act: 'rename' }));
    if (!set.greyed) acts.appendChild(button(doc, 'btn-ghost btn-mini', 'Duplicate', { act: 'duplicate' }));
    if (user) acts.appendChild(button(doc, 'btn-ghost btn-mini', 'Delete', { act: 'delete' }));
    if (set.greyed) acts.appendChild(button(doc, 'btn-ghost btn-mini', 'Forget', { act: 'forget' }));
    head.appendChild(acts);
    card.appendChild(head);
    if (set.greyed) {
      card.appendChild(h(doc, 'p', 'hint', `No project here follows ${set.home}. Forget drops this Team set's values, secrets and test results.`));
      return card;
    }
    const used = h(doc, 'div', 'mcp-usedby');
    used.appendChild(h(doc, 'span', 'label', 'Used by'));
    for (const p of set.usedBy) {
      const chip = h(doc, 'span', 'chip mcp-chip', p.name);
      if (!isTeam(set)) {
        const x = button(doc, 'mcp-x', '×', { unassign: p.key });
        x.title = set.group === 'general' ? `Turn Include General off for ${p.name}` : `Remove ${set.name} from ${p.name}`;
        x.setAttribute('aria-label', x.title);
        chip.appendChild(x);
      }
      used.appendChild(chip);
    }
    if (set.group === 'general') used.appendChild(h(doc, 'span', 'chip mcp-chip', 'Ask Worca'));
    if (!isTeam(set)) used.appendChild(button(doc, 'btn-ghost btn-mini', '+ Add project', { act: 'add-project' }));
    card.appendChild(used);
    const sh = h(doc, 'div', 'mcp-usedby');
    sh.appendChild(h(doc, 'span', 'label', 'Servers'));
    if (!isTeam(set)) sh.appendChild(button(doc, 'btn-ghost btn-mini', '+ Add server', { act: 'add-member' }));
    card.appendChild(sh);
    if (!members.length) card.appendChild(h(doc, 'div', 'hist-empty', 'No servers in this set yet.'));
    for (const m of members) card.appendChild(memberCard(set, m));
    return card;
  }

  function serverRow(s) {
    const row = h(doc, 'div', 'card mcp-server-row');
    row.dataset.server = s.id;
    const head = h(doc, 'div', 'pl-head');
    head.append(h(doc, 'b', 'mono', s.base), h(doc, 'span', 'badge', s.sourceLabel), h(doc, 'span', 'mono hint', s.type));
    const badges = [[s.provisional, 'name provisional'], [s.pluginDisabled, 'plugin disabled'],
      [s.inClaudeConfig, 'also in your Claude Code config'], [s.retired, `no longer required by ${s.retired}`]];
    for (const [on, text] of badges) if (on) head.appendChild(h(doc, 'span', 'badge amber', text));
    row.append(head, h(doc, 'small', 'hint', s.description));
    const sets = h(doc, 'div', 'mcp-usedby');
    sets.appendChild(h(doc, 'span', 'label', 'In sets'));
    if (!s.inSets.length) sets.appendChild(h(doc, 'span', 'hint', 'not in a set'));
    for (const x of s.inSets) {
      const a = h(doc, 'a', 'chip', x.name);
      a.href = `#${mcpRoute(x.id)}`;
      sets.appendChild(a);
    }
    sets.appendChild(h(doc, 'span', 'hint', s.tools == null ? '— tools' : `${s.tools} tools`));
    row.appendChild(sets);
    const acts = h(doc, 'div', 'pl-actions');
    acts.appendChild(button(doc, 'btn-ghost btn-mini', 'Add to set', { addTo: s.id }));
    if (s.source === 'manual') acts.appendChild(button(doc, 'btn-ghost btn-mini', 'Edit definition', { edit: s.id }));
    if (s.source === 'manual' || s.retired) acts.appendChild(button(doc, 'btn-ghost btn-mini', 'Remove', { removeServer: s.id }));
    row.appendChild(acts);
    return row;
  }

  let painted = null;   // the view and set of the last paint: a kept input never crosses to another set
  function paint() {
    // Every save repaints the pane: the input the user is in (Tab to the next field, Enter, a switch) keeps its
    // text, caret and focus, or the next keystrokes land nowhere and an unsaved value is wiped.
    const a = doc.activeElement;
    const keyOf = (el) => (el.dataset.field ? `f|${el.dataset.server}|${el.dataset.field}` : el.dataset.toggle ? `t|${el.dataset.toggle}` : el.dataset.test ? `b|${el.dataset.test}` : null);
    const where = `${st.view}|${st.set ? st.set.set.id : ''}`;
    const keep = where === painted && a && a !== doc.body && host.contains(a) ? { key: keyOf(a), value: a.value, from: a.selectionStart, to: a.selectionEnd } : null;
    const strip = h(doc, 'div', 'mcp-req-strip');
    strip.dataset.mcpStrip = '';
    strip.hidden = true;
    const msg = h(doc, 'p', `form-msg${st.msgKind ? ` ${st.msgKind}` : ''}`, st.msg);
    msg.setAttribute('aria-live', 'polite');
    const body = h(doc, 'div', st.view === 'servers' ? 'run-list mcp-servers' : 'mcp-sets');
    if (st.view === 'servers') {
      for (const s of st.servers || []) body.appendChild(serverRow(s));
      if (!(st.servers || []).length) body.appendChild(h(doc, 'div', 'hist-empty', 'No MCP servers yet. Install a plugin that ships some, or Add MCP server.'));
    } else {
      body.append(setList(), setDetail());
    }
    host.replaceChildren(topbar(), strip, msg, body);
    painted = where;
    const again = keep && keep.key && [...host.querySelectorAll('[data-field], [data-toggle], [data-test]')].find((x) => keyOf(x) === keep.key);
    if (again) {
      if (again.dataset.field) { again.value = keep.value; again.focus(); again.setSelectionRange(keep.from, keep.to); } else again.focus();
    }
    if (stripRenderer) stripRenderer(strip);
  }

  // ── actions ──
  /** `msgEl`: a modal's own message line — an error behind the modal's scrim is never seen. */
  async function write(method, path, body, okText = '', msgEl = null) {
    const r = await api(method, path, body);
    if (!r.ok) {
      if (!msgEl) { fail(r); return null; }
      msgEl.textContent = (r.data && r.data.error) || `HTTP ${r.status}`;
      msgEl.className = 'form-msg err';
      return null;
    }
    say(okText, okText ? 'ok' : '');
    return r;
  }
  async function runTest(setId, serverId) {
    const key = `${setId}|${serverId}`;
    st.testing.add(key);
    paint();
    const r = await api('POST', `${memberPath(setId, serverId)}/test`);
    st.testing.delete(key);
    if (!r.ok) fail(r);
    await load();
  }

  function pickModal(title, label, options, onPick, extra = null) {
    const body = h(doc, 'div', 'field');
    body.appendChild(h(doc, 'label', '', label));
    const sel = h(doc, 'select', 'select');
    for (const o of options) {
      const opt = h(doc, 'option', '', o.label);
      opt.value = o.value;
      opt.disabled = !!o.disabled;
      sel.appendChild(opt);
    }
    body.appendChild(sel);
    const slot = h(doc, 'div');
    body.appendChild(slot);
    const msg = h(doc, 'p', 'form-msg');
    msg.setAttribute('aria-live', 'polite');
    body.appendChild(msg);
    const renderExtra = () => { if (extra) slot.replaceChildren(extra(sel.value)); };
    sel.addEventListener('change', renderExtra);
    const first = options.find((o) => !o.disabled);
    if (!first) {   // every choice is already there: an empty value would address no set or server
      body.replaceChildren(h(doc, 'p', 'hint', `${label}: every choice is already there.`));
      modal.open(title, body, [['Close', 'btn btn-ghost btn-mini', () => modal.close()]]);
      return;
    }
    sel.value = first.value;
    renderExtra();
    modal.open(title, body, [['Cancel', 'btn btn-ghost btn-mini', () => modal.close()], [onPick.label, 'btn btn-primary btn-mini', () => onPick.fn(sel.value, slot, msg)]]);
  }

  /** Add a server to a set: server (or set) picker, then that server's fields; Save and test. */
  async function addMember({ setId = null, serverId = null }) {
    const inSet = new Set(setId ? (st.set?.members || []).map((m) => m.serverId) : []);   // before the await
    const cat = ((await api('GET', '/api/mcp/servers')).data?.servers) || [];   // fresh: a plugin may have come or gone since
    const setName = (id) => (st.sets || []).find((s) => s.id === id)?.name || id;
    const extra = (pickServer) => {
      const s = cat.find((x) => x.id === (serverId || pickServer));
      if (!s) return h(doc, 'div');
      const wrap = h(doc, 'div');
      wrap.append(h(doc, 'small', 'hint', s.description), fieldInputs(doc, s.fields));
      return wrap;
    };
    const save = async (picked, slot, msg) => {
      const target = setId || picked;
      const server = serverId || picked;
      const { values, secrets } = collectFieldInputs(slot);
      const r = await write('PUT', memberPath(target, server), { enabled: true, values, secrets }, '', msg);
      if (!r) return;
      modal.close();
      st.setId = target;
      navigate(mcpRoute(target));
      await load();
      await runTest(target, server);
    };
    if (setId) {
      pickModal(`Add server to ${setName(setId)}`, 'Server',
        cat.map((s) => ({ value: s.id, label: `${s.base} · ${s.sourceLabel} · ${s.type}`, disabled: inSet.has(s.id) })),
        { label: 'Save and test', fn: save }, extra);
    } else {
      const s = cat.find((x) => x.id === serverId);
      const inSets = new Set((s?.inSets || []).map((x) => x.id));
      pickModal(`Add ${s ? s.base : 'server'} to a set`, 'Set',
        (st.sets || []).filter((x) => x.group !== 'team').map((x) => ({ value: x.id, label: x.name, disabled: inSets.has(x.id) })),
        { label: 'Save and test', fn: save }, () => extra(serverId));
    }
  }

  async function assignment(key) {
    const r = await api('GET', `/api/mcp/projects/${enc(key)}`);
    return r.ok ? r.data : null;
  }
  async function putAssignment(key, a, msgEl = null) {
    return write('PUT', `/api/mcp/projects/${enc(key)}`, { sets: a.sets.map((s) => s.id ?? s), includeGeneral: a.includeGeneral }, '', msgEl);
  }

  async function onClick(e) {
    const b = e.target.closest && e.target.closest('button');
    if (!b || !host.contains(b)) return;
    const d = b.dataset;
    // The set these cards were painted from, read before any await: Back/Forward while a prompt, a confirm or a
    // fetch is pending paints another set, and the answer must still act on this one.
    const cur = st.set ? st.set.set : null;
    if (d.mcpView) return navigate(d.mcpView === 'servers' ? mcpRoute(null) : mcpRoute(st.setId || 'general'));
    if (d.set) return navigate(mcpRoute(d.set));
    if (d.act === 'new-set') {
      const v = await promptName('New set', '');
      if (!v) return;
      const r = await write('POST', '/api/mcp/sets', { name: v });
      if (r) navigate(mcpRoute(r.data.id));
      return;
    }
    if (d.act === 'add-server') return openDefinition(null);
    if (d.act === 'rename') {
      const v = await promptName('Rename set', cur.name);
      if (v && await write('PUT', setPath(cur.id), { name: v })) await load();
      return;
    }
    if (d.act === 'duplicate') {
      // P1 reserves "Team · " names and caps one at 40: a Team set's copy is named after its home.
      const v = await promptName(`Duplicate ${cur.name}`, `${cur.group === 'team' ? cur.name.slice('Team · '.length) : cur.name} copy`.slice(0, 40));
      if (!v) return;
      const r = await write('POST', `${setPath(cur.id)}/duplicate`, { name: v });
      if (r) navigate(mcpRoute(r.data.id));
      return;
    }
    if (d.act === 'delete') return deleteSet();
    if (d.act === 'forget') {
      const ok = await confirm({ title: 'Forget Team set', message: `Forget ${cur.name}? Its values, secrets and test results go.`, confirmLabel: 'Forget', danger: true });
      if (ok && await write('POST', `/api/mcp/teams/${enc(cur.home)}/forget`, {})) navigate(mcpRoute('general'));
      return;
    }
    if (d.act === 'add-project') return addProject();
    if (d.act === 'add-member') return addMember({ setId: cur.id });
    if (d.unassign) {
      const a = await assignment(d.unassign);
      if (!a) return;
      const next = cur.group === 'general' ? { ...a, includeGeneral: false } : { ...a, sets: a.sets.filter((s) => s.id !== cur.id) };
      if (await putAssignment(d.unassign, next)) await load();
      return;
    }
    if (d.test) return runTest(cur.id, d.test);
    if (d.remove) {
      const m = st.set.members.find((x) => x.serverId === d.remove);
      const ok = await confirm({ title: 'Remove from set', message: `Remove ${m.copy} from ${cur.name}? Its values, secrets and test result go.`, confirmLabel: 'Remove', danger: true });
      if (ok && await write('DELETE', memberPath(cur.id, d.remove))) await load();
      return;
    }
    if (d.secret) return replaceSecret(d.server, d.secret);
    if (d.useTeam) {
      if (await write('PUT', memberPath(cur.id, d.server), { values: { [d.useTeam]: d.value } })) await load();
      return;
    }
    if (d.addTo) return addMember({ serverId: d.addTo });
    if (d.edit) {
      const s = st.servers.find((x) => x.id === d.edit);
      return openDefinition(s);
    }
    if (d.removeServer) {
      const s = st.servers.find((x) => x.id === d.removeServer);
      const leaves = s.inSets.length ? ` It leaves ${s.inSets.map((x) => x.name).join(', ')}.` : '';
      const ok = await confirm({ title: 'Remove MCP server', message: `Remove ${s.base} from worca?${leaves} Its values, secrets and test results go.`, confirmLabel: 'Remove', danger: true });
      if (ok && await write('DELETE', `/api/mcp/servers/${enc(s.id)}`)) await load();
    }
  }

  async function onChange(e) {
    const t = e.target;
    if (!host.contains(t)) return;
    if (t.dataset.toggle) {
      if (await write('PUT', memberPath(st.set.set.id, t.dataset.toggle), { enabled: t.checked })) await load();
      else t.checked = !t.checked;
    } else if (t.dataset.field) {
      // A value paint() restored after a repaint is no "change" to the browser any more: leaving the field (focusout)
      // saves it too, and the one of change/focusout that comes second finds it saved.
      const v = t.value.trim();
      if (v === t.dataset.saved) return;
      const prev = t.dataset.saved;
      t.dataset.saved = v;
      if (await write('PUT', memberPath(st.set.set.id, t.dataset.server), { values: { [t.dataset.field]: v } })) await load();
      else t.dataset.saved = prev;
    }
  }

  async function promptName(title, value) {
    const body = h(doc, 'div', 'field');
    const inp = h(doc, 'input', 'input');
    Object.assign(inp, { type: 'text', value, maxLength: 40 });
    inp.setAttribute('aria-label', 'Name');
    body.append(h(doc, 'label', '', 'Name'), inp);
    return new Promise((resolve) => {
      modal.open(title, body, [['Cancel', 'btn btn-ghost btn-mini', () => { modal.close(); resolve(null); }],
        ['Save', 'btn btn-primary btn-mini', () => { modal.close(); resolve(inp.value.trim() || null); }]]);
    });
  }

  function replaceSecret(serverId, key) {
    const m = st.set.members.find((x) => x.serverId === serverId);
    const f = m.fields.find((x) => x.key === key);
    const setId = st.set.set.id;
    const body = h(doc, 'div');
    const msg = h(doc, 'p', 'form-msg');
    msg.setAttribute('aria-live', 'polite');
    body.append(fieldInputs(doc, [{ ...f, required: true }]), msg);
    modal.open(`${f.label} · ${m.copy}`, body, [['Cancel', 'btn btn-ghost btn-mini', () => modal.close()],
      ['Save', 'btn btn-primary btn-mini', async () => {
        const { secrets } = collectFieldInputs(body);
        if (!Object.keys(secrets).length) { modal.close(); return; }
        if (await write('PUT', memberPath(setId, serverId), { secrets }, '', msg)) { modal.close(); await load(); }
      }]]);
  }

  async function addProject() {
    const { id: setId, group, name, usedBy } = st.set.set;   // before the await (see onClick's `cur`)
    const r = await api('GET', '/api/projects');
    const used = new Set(usedBy.map((p) => p.key));
    const projects = (r.ok ? r.data.projects : []).filter((p) => !used.has(p.key));
    pickModal(`Use ${name} in a project`, 'Project', projects.map((p) => ({ value: p.key, label: p.name })), {
      label: 'Add', fn: async (key, _slot, msg) => {
        const a = await assignment(key);
        if (!a) return;
        const next = group === 'general' ? { ...a, includeGeneral: true } : { ...a, sets: [...a.sets, { id: setId }] };
        if (await putAssignment(key, next, msg)) { modal.close(); await load(); }
      },
    });
  }

  async function deleteSet() {
    const { set } = st.set;
    const left = [];
    for (const p of set.usedBy) {
      const a = await assignment(p.key);
      if (a && !a.includeGeneral && !a.team && a.sets.every((s) => s.id === set.id)) left.push(p.name);
    }
    const uses = set.usedBy.length ? `\nUsed by ${set.usedBy.map((p) => p.name).join(', ')}.` : '';
    const none = left.length ? `\n${left.join(', ')} will have no MCP servers in runs.` : '';
    const ok = await confirm({ title: 'Delete set', message: `Delete ${set.name}? Its values, secrets and test results go.${uses}${none}`, confirmLabel: 'Delete set', danger: true });
    if (ok && await write('DELETE', setPath(set.id))) navigate(mcpRoute('general'));
  }

  function openDefinition(server) {
    const edit = !!server;
    const form = edit ? formFromDefinition(server.base, server.def) : blankDefinitionForm();
    const body = createDefinitionForm(doc, api, form, { edit });
    const msg = h(doc, 'p', 'form-msg');
    msg.setAttribute('aria-live', 'polite');
    const wrap = h(doc, 'div');
    wrap.append(body, msg);
    const save = async (thenAdd) => {
      if (!(await body.check())) return;
      const { name, def } = compileDefinition(form);
      const r = edit ? await write('PUT', `/api/mcp/servers/${enc(server.id)}`, def, `Saved ${name} · re-testing its sets`, msg)
        : await write('POST', '/api/mcp/servers', { name, ...def }, `Added ${name}`, msg);
      if (!r) return;
      modal.close();
      st.servers = null;
      if (st.view !== 'servers') navigate(mcpRoute(null));
      await load();
      if (thenAdd) await addMember({ serverId: `manual:${name}` });
    };
    const list = [['Cancel', 'btn btn-ghost btn-mini', () => modal.close()], ['Save', 'btn btn-ghost btn-mini', () => save(false)]];
    if (!edit) list.push(['Save and add to set', 'btn btn-primary btn-mini', () => save(true)]);
    modal.open(edit ? `Edit definition · ${server.base}` : 'Add MCP server', wrap, list);
  }

  host.addEventListener('click', (e) => { void onClick(e); });
  host.addEventListener('change', (e) => { void onChange(e); });
  host.addEventListener('focusout', (e) => { if (e.target.dataset && e.target.dataset.field) void onChange(e); });

  return {
    /** Route entry: '' | 'sets/<id>' | 'servers' (the part after #settings/mcp/). */
    show(sub = '') {
      const r = parseMcpParam(sub);
      st.view = r.view;
      if (r.setId) st.setId = r.setId;
      st.msg = '';
      return load();
    },
  };
}

// ── resolution tables: the project MCP tab and the workspace overview (spec §8) ───────────────────
function statusFor(row, sets) {
  if (row.why) return row.reason === 'off' ? 'off' : row.reason === 'needs-consent' ? `off — ${row.why}` : `${row.why} in ${row.setName}`;
  const member = (sets || []).find((s) => s.id === row.setId)?.members.find((m) => m.serverId === row.serverId);
  return { ok: 'ok', stale: 'stale', none: 'not tested', failed: 'test failed' }[member ? member.test : 'none'];
}
/** `preview` = POST /api/mcp/preview (a skipped row's reason text is its `why`); `sets` = GET /api/mcp/sets .sets
 *  (for test states). */
export function renderResolution(doc, title, preview, sets, what = 'project') {
  const card = h(doc, 'section', 'card mcp-resolution');
  card.appendChild(h(doc, 'h2', '', title));
  // A missing-server skip has no copy name (copy: null): it reads as its server id.
  const nameOf = (r) => r.copy ?? r.serverId;
  const rows = [...(preview.copies || []), ...(preview.skipped || [])]
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b)) || a.setId.localeCompare(b.setId));
  if (!rows.length) { card.appendChild(h(doc, 'p', 'hint', `No MCP servers in runs on this ${what}`)); return card; }
  for (const r of rows) {
    const row = h(doc, 'div', 'mcp-res-row');
    const a = h(doc, 'a', '', r.setName);
    a.href = `#${mcpRoute(r.setId)}`;
    const status = statusFor(r, sets);
    row.append(h(doc, 'span', 'mono', r.provisional ? `${nameOf(r)} · name provisional` : nameOf(r)), a,
      h(doc, 'span', `hint${status === 'ok' ? '' : ' mcp-res-skip'}`, status));
    card.appendChild(row);
  }
  card.appendChild(h(doc, 'small', 'hint', 'A copy whose name is taken in a run is renamed with _w when the run starts.'));
  return card;
}
export async function paintMcpResolution(host, { target, title, api, doc = globalThis.document }) {
  const [p, s] = await Promise.all([api('POST', '/api/mcp/preview', { target }), api('GET', '/api/mcp/sets')]);
  if (!p.ok) { host.replaceChildren(h(doc, 'small', 'hint err', p.data?.error || `HTTP ${p.status}`)); return; }
  host.replaceChildren(renderResolution(doc, title, p.data, s.ok ? s.data.sets : [], target.workspaceId ? 'workspace' : 'project'));
}

/** The project page's MCP tab: its sets (chips, Add set, Include General in runs, the Team chip) and
 *  the servers its runs get. No configuration here. */
export async function mountProjectMcp(sec, { key, name, api, doc = globalThis.document }) {
  const r = await api('GET', `/api/mcp/projects/${enc(key)}`);
  if (!r.ok) { sec.replaceChildren(h(doc, 'small', 'hint err', r.data?.error || `HTTP ${r.status}`)); return; }
  const a = r.data;
  const save = async (next) => {
    const w = await api('PUT', `/api/mcp/projects/${enc(key)}`, { sets: next.sets.map((s) => s.id), includeGeneral: next.includeGeneral });
    if (w.ok) await mountProjectMcp(sec, { key, name, api, doc });
    else sec.querySelector('.mcp-proj-msg').textContent = w.data?.error || `HTTP ${w.status}`;
  };
  const card = h(doc, 'section', 'card mcp-proj-sets');
  card.appendChild(h(doc, 'h2', '', 'Sets'));
  const chips = h(doc, 'div', 'mcp-usedby');
  for (const s of a.sets) {
    const chip = h(doc, 'span', 'chip mcp-chip');
    const link = h(doc, 'a', '', s.name);
    link.href = `#${mcpRoute(s.id)}`;
    const x = button(doc, 'mcp-x', '×', { drop: s.id });
    x.setAttribute('aria-label', `Remove ${s.name}`);
    x.addEventListener('click', () => save({ ...a, sets: a.sets.filter((y) => y.id !== s.id) }));
    chip.append(link, x);
    chips.appendChild(chip);
  }
  if (a.team) {
    const t = h(doc, 'a', 'chip mcp-chip', a.team.name);
    t.href = `#${mcpRoute(a.team.id)}`;
    chips.appendChild(t);
  }
  if (a.choices.length) {
    const sel = h(doc, 'select', 'select mcp-add-set');
    sel.setAttribute('aria-label', 'Add set');
    sel.appendChild(Object.assign(h(doc, 'option', '', 'Add set…'), { value: '' }));
    for (const c of a.choices) sel.appendChild(Object.assign(h(doc, 'option', '', c.name), { value: c.id }));
    sel.addEventListener('change', () => { if (sel.value) save({ ...a, sets: [...a.sets, { id: sel.value }] }); });
    chips.appendChild(sel);
  }
  card.appendChild(chips);
  const sw = h(doc, 'label', 'switch-row');
  const cb = h(doc, 'input', 'sw-input');
  cb.type = 'checkbox';
  cb.checked = a.includeGeneral;
  cb.setAttribute('aria-label', 'Include General in runs');
  cb.addEventListener('change', () => save({ ...a, includeGeneral: cb.checked }));
  sw.append(cb, h(doc, 'span', 'switch switch-sm'), h(doc, 'span', 'txt', 'Include General in runs'));
  card.append(sw, h(doc, 'small', 'hint', 'Ask Worca always includes General; a workspace run includes it when any member does'));
  if (a.none) card.appendChild(h(doc, 'p', 'hint err', 'No MCP servers in runs on this project'));
  card.appendChild(h(doc, 'small', 'hint err mcp-proj-msg'));
  const servers = h(doc, 'div');
  sec.replaceChildren(card, servers);
  await paintMcpResolution(servers, { target: { projectKey: key }, title: `Servers in runs on ${name}`, api, doc });
}

/** Settings › Ask Worca: the General set in one line, with a link to edit it (spec §9.5). */
export async function paintAskMcpBlock(host, { api, doc = globalThis.document }) {
  const r = await api('GET', '/api/mcp/sets');
  const general = r.ok && Array.isArray(r.data?.sets) ? r.data.sets.find((s) => s.id === 'general') : null;
  const row = h(doc, 'div', 'mcp-usedby');
  row.appendChild(h(doc, 'span', 'hint', 'General set'));
  for (const m of general ? general.members : []) row.appendChild(h(doc, 'span', 'chip mono', m.copy));
  if (general && !general.members.length) row.appendChild(h(doc, 'span', 'hint', 'no servers yet'));
  row.appendChild(h(doc, 'span', 'hint', 'plus the sets of the projects a chat works on'));
  const a = h(doc, 'a', '', 'Edit General set');
  a.href = '#settings/mcp/sets/general';
  row.appendChild(a);
  const label = h(doc, 'div', 'label-row');
  label.appendChild(h(doc, 'label', '', 'MCP servers'));
  host.replaceChildren(label, row);
}
