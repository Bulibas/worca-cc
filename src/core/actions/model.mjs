// Actions (issue #529): the stored shape of a project's setup + actions and a
// workspace's stacks, validated in ONE place. Pure: no fs, no DB, no spawn.
import { resolve, relative, isAbsolute, sep } from 'node:path';

export const ACTION_KINDS = Object.freeze(['service', 'task']);
export const READY_KINDS = Object.freeze(['port', 'output', 'immediate']);
export const BUILTIN_KEYS = Object.freeze(['editor', 'terminal', 'fileManager', 'copyCommand']);
export const RAW_COMMAND_FIELDS = Object.freeze(['cmd', 'cmdWin32', 'command', 'setup', 'env', 'cwd', 'shell', 'args']);
export const SETUP_ACTION_ID = '__setup';
export const DEFAULT_READY_TIMEOUT_MS = 60_000;

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// {name} or {alias.NAME}; anything else (shell {} / ${X} / unknown names) is left as-is.
// (?<!\$): `${PORT}` is shell syntax, never a placeholder (D19). Declared before isSafeOpenUrl uses it.
const PLACEHOLDER_RE = /(?<!\$)\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\}/g;
const MAX_ACTIONS = 30;
const MAX_CMD = 4000;

export class ActionConfigError extends Error {
  constructor(message, field = null) { super(message); this.code = 'BAD_REQUEST'; this.field = field; }
}
const fail = (msg, field) => { throw new ActionConfigError(msg, field); };
const str = (v) => (typeof v === 'string' ? v.trim() : '');

export function validatePortValue(v) {
  if (v === 'auto' || v === '' || v == null) return 'auto';
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) fail('a port must be "auto" or a whole number');
  const n = Number(s);
  if (n < 1024 || n > 65535) fail('a port must be between 1024 and 65535');
  return n;
}

function normCwd(raw, field) {
  const c = str(raw) || '.';
  if (isAbsolute(c) || c.split(/[\\/]+/).includes('..')) fail('the working directory must stay inside the worktree', field);
  return c;
}

function normEnv(rows, field) {
  if (rows == null) return [];
  if (!Array.isArray(rows)) fail('env must be a list', field);
  const seen = new Set();
  return rows.map((r, i) => {
    const name = str(r?.name);
    if (!ENV_NAME_RE.test(name)) fail(`env name "${name}" is not a valid variable name`, `${field}.env[${i}]`);
    if (seen.has(name)) fail(`env name "${name}" is listed twice`, `${field}.env[${i}]`);
    seen.add(name);
    const type = r?.type === 'port' ? 'port' : 'text';
    const value = type === 'port' ? validatePortValue(r?.value) : String(r?.value ?? '');
    return { name, type, value };
  });
}

function normReady(raw, kind, env, field) {
  if (kind === 'task') return { kind: 'immediate' };
  const k = READY_KINDS.includes(raw?.kind) ? raw.kind : 'immediate';
  const timeoutMs = Number.isSafeInteger(raw?.timeoutMs) && raw.timeoutMs >= 1000 && raw.timeoutMs <= 600_000
    ? raw.timeoutMs : DEFAULT_READY_TIMEOUT_MS;
  if (k === 'port') {
    const ports = env.filter((e) => e.type === 'port').map((e) => e.name);
    const port = str(raw?.port) || ports[0];
    if (!port || !ports.includes(port)) fail('"port answers" needs a port variable in the environment table', `${field}.ready`);
    return { kind: 'port', port, timeoutMs };
  }
  if (k === 'output') {
    const text = str(raw?.text);
    if (!text) fail('"output contains" needs the text to wait for', `${field}.ready`);
    return { kind: 'output', text, timeoutMs };
  }
  return { kind: 'immediate' };
}

export function normalizeAction(a, i) {
  const field = `actions[${i}]`;
  const id = str(a?.id);
  if (!ID_RE.test(id)) fail('an action id is lowercase letters, digits and dashes', `${field}.id`);
  const label = str(a?.label) || id;
  const kind = a?.kind;
  if (!ACTION_KINDS.includes(kind)) fail('kind must be service or task', `${field}.kind`);
  const cmd = str(a?.cmd);
  if (!cmd || cmd.length > MAX_CMD) fail('a command is required (up to 4000 characters)', `${field}.cmd`);
  const cmdWin32 = str(a?.cmdWin32) || null;
  if (cmdWin32 && cmdWin32.length > MAX_CMD) fail('the Windows command is too long', `${field}.cmdWin32`);
  const env = normEnv(a?.env, field);
  const openUrl = str(a?.openUrl) || null;
  if (openUrl && !isSafeOpenUrl(openUrl)) fail('the open link must be an http:// or https:// address', `${field}.openUrl`);
  return {
    id, label: label.slice(0, 40), kind, cmd, cmdWin32, cwd: normCwd(a?.cwd, `${field}.cwd`), env,
    openUrl,
    ready: normReady(a?.ready, kind, env, field),
  };
}

/** D24: http(s) only. Placeholders are replaced by a dummy port first, so `http://localhost:{PORT}` parses. */
export function isSafeOpenUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  try {
    const u = new URL(raw.trim().replace(PLACEHOLDER_RE, '4400'));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

export function normalizeProjectActions(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(src.actions) ? src.actions : [];
  if (list.length > MAX_ACTIONS) fail(`at most ${MAX_ACTIONS} actions`, 'actions');
  const actions = list.map(normalizeAction);
  const ids = new Set();
  for (const a of actions) { if (ids.has(a.id)) fail(`action id "${a.id}" is used twice`, 'actions'); ids.add(a.id); }
  const b = src.builtins && typeof src.builtins === 'object' ? src.builtins : {};
  const setup = str(src.setup);
  if (setup.length > MAX_CMD) fail('the setup command is too long', 'setup');
  return {
    setup: setup || null,
    actions,
    builtins: Object.fromEntries(BUILTIN_KEYS.map((k) => [k, b[k] !== false])),
  };
}

export const EMPTY_PROJECT_ACTIONS = Object.freeze(normalizeProjectActions({}));

export function expandPlaceholders(text, vars) {
  if (typeof text !== 'string') return text;
  return text.replace(PLACEHOLDER_RE, (m, name) => (Object.hasOwn(vars, name) ? String(vars[name]) : m));
}

export function assertNoRawCommand(body) {
  const b = body && typeof body === 'object' ? body : {};
  const bad = RAW_COMMAND_FIELDS.find((k) => Object.hasOwn(b, k));
  if (bad) {
    const e = new Error(`actions are started by id; "${bad}" is not accepted here`);
    e.code = 'RAW_COMMAND';
    throw e;
  }
}

export function resolveCwd(worktreeDir, cwd) {
  const root = resolve(worktreeDir);
  const out = resolve(root, cwd || '.');
  const rel = relative(root, out);
  if (rel === '') return out;
  if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new ActionConfigError('the working directory must stay inside the worktree', 'cwd');
  }
  return out;
}

/** D17: order-independent — members are aliased sorted by projectKey, so every page agrees. */
export function memberAliases(members) {
  const out = {};
  const taken = new Set();
  const sorted = members.slice().sort((a, b) => String(a.projectKey).localeCompare(String(b.projectKey)));
  for (const m of sorted) {
    const base = String(m.name || m.projectKey || 'member').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'member';
    let alias = base; let n = 2;
    while (taken.has(alias)) alias = `${base}_${n++}`;
    taken.add(alias); out[m.projectKey] = alias;
  }
  return out;
}

/** Validate stacks against the members' action ids: memberActions = { [projectKey]: [{id, kind}] }. */
export function normalizeStacks(raw, { memberActions }) {
  const list = Array.isArray(raw?.stacks) ? raw.stacks : [];
  const ids = new Set();
  const stacks = list.map((s, i) => {
    const field = `stacks[${i}]`;
    const id = str(s?.id);
    if (!ID_RE.test(id) || ids.has(id)) fail('a stack id is unique, lowercase letters, digits and dashes', `${field}.id`);
    ids.add(id);
    const kind = s?.kind === 'task' ? 'task' : 'service';
    const steps = (Array.isArray(s?.steps) ? s.steps : []).map((st, j) => {
      const acts = memberActions[st?.member];
      if (!acts) fail('a step names a project that is not in this workspace', `${field}.steps[${j}].member`);
      const act = acts.find((a) => a.id === st?.action);
      if (!act) fail(`"${st?.action}" is not an action of that project`, `${field}.steps[${j}].action`);
      if (kind === 'task' && act.kind !== 'task') fail('a task stack can only run task actions', `${field}.steps[${j}].action`);
      // Step rows are always text (a port value like "http://…{api.PORT}" must not hit validatePortValue).
      const rows = Array.isArray(st?.env) ? st.env.map((r) => ({ ...r, type: 'text' })) : st?.env;
      const env = normEnv(rows, `${field}.steps[${j}]`);
      return { member: st.member, action: act.id, env };
    });
    if (!steps.length) fail('a stack needs at least one step', `${field}.steps`);
    return { id, label: str(s?.label).slice(0, 40) || id, kind, steps };
  });
  return { stacks };
}
