// src/core/actions/stack.mjs — a workspace stack: ordered steps over members' own actions.
import { instanceIdFor } from './registry.mjs';

const TERMINAL = new Set(['exited', 'failed', 'stopped']);

export async function runStack({ runId, stack, aliases, registry, resolveStep, onState = () => {}, isCancelled = () => false }) {
  const vars = {};                                 // 'alias.NAME' -> port, grows step by step
  // D26: `instances` = ids THIS stack started (owned); a service that was already running is reused, not owned.
  const state = { stackId: stack.id, runId, status: 'starting', step: 0, error: null, instances: [] };
  const snapshot = () => ({ ...state, instances: [...state.instances] });
  const fail = async (error) => {
    state.status = 'failed'; state.error = error; onState(snapshot());
    if (stack.kind === 'service') for (const id of state.instances.slice().reverse()) await registry.stop(id);
    return snapshot();
  };
  // Stop pressed mid-start: the route already stopped what was started. Stop anything started since, then end.
  const cancelled = async () => {
    for (const id of state.instances.slice().reverse()) await registry.stop(id);
    state.status = 'stopped'; onState(snapshot()); return snapshot();
  };
  // A Stop during a step's wait must not leave that step running until its ready timeout (up to 65 s).
  const CANCELLED = Symbol('cancelled');
  const orCancel = (p) => new Promise((resolve) => {
    let settled = false;
    const t = setInterval(() => { if (!settled && isCancelled()) { settled = true; clearInterval(t); resolve(CANCELLED); } }, 250);
    t.unref?.();
    p.then((v) => { if (!settled) { settled = true; clearInterval(t); resolve(v); } },
      () => { if (!settled) { settled = true; clearInterval(t); resolve(null); } });
  });
  for (const [i, st] of stack.steps.entries()) {
    if (isCancelled()) return cancelled();
    state.step = i + 1; onState(snapshot());
    // resolveStep may be async: the server's version awaits the member's setup (D25/D29), which can take
    // minutes (npm ci). A Stop during that wait ends the stack at once; the setup itself keeps going.
    const resolved = await orCancel(Promise.resolve().then(() => resolveStep(st)));
    if (resolved === CANCELLED) return cancelled();
    const { worktreeDir, branch, action, error } = resolved || {};
    if (!action) return fail(`step ${i + 1}: ${st.member} no longer has the action "${st.action}"`);
    if (!worktreeDir) return fail(`step ${i + 1}: ${error || `${st.member} is not checked out`}`);
    let snap;
    try {
      snap = await registry.start({ runId, member: st.member, worktreeDir, branch, action,
        extraEnv: st.env, extraVars: { ...vars }, stackId: stack.id });
    } catch (e) { return fail(`step ${i + 1} (${st.member} › ${action.label}) could not start: ${e?.message || e}`); }
    if (!snap.alreadyActive) state.instances.push(snap.instanceId);
    if (isCancelled()) return cancelled();
    const label = `step ${i + 1} (${st.member} › ${action.label})`;
    if (action.kind === 'task') {
      const end = await orCancel(registry.waitFor(snap.instanceId, (s) => TERMINAL.has(s.status), 24 * 3600_000));
      if (end === CANCELLED) return cancelled();
      if (!end || end.status !== 'exited' || end.exitCode !== 0) {
        return fail(`${label} failed${end?.exitCode != null ? ` with exit code ${end.exitCode}` : ''}`);
      }
    } else {
      const done = await orCancel(registry.waitFor(snap.instanceId,
        (s) => s.status === 'ready' || !!s.readyError || TERMINAL.has(s.status),
        (action.ready?.timeoutMs || 60_000) + 5_000));
      if (done === CANCELLED) return cancelled();
      if (!done || done.status !== 'ready') {
        return fail(`${label} ${done?.readyError || `did not become ready (${done?.status || 'timeout'})`}`);
      }
    }
    const alias = aliases[st.member];
    if (alias) for (const [name, port] of Object.entries(registry.get(snap.instanceId)?.ports || {})) vars[`${alias}.${name}`] = port;
  }
  if (isCancelled()) return cancelled();
  state.status = stack.kind === 'task' ? 'done' : 'running';
  onState(snapshot());
  return snapshot();
}

/** D26: stop exactly what the stack started, newest first. `stackState` is the object runStack reported. */
export async function stopStack(registry, stackState) {
  for (const id of (stackState?.instances || []).slice().reverse()) await registry.stop(id);
}
export { instanceIdFor };
