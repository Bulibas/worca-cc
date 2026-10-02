import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStack, stopStack, instanceIdFor } from '../src/core/actions/stack.mjs';

// A fake registry: records starts/stops and resolves statuses on demand.
function fakeRegistry({ readyAfter = 0, exitCodes = {}, failReady = null, alreadyRunning = [], neverReady = [] } = {}) {
  const snaps = new Map();
  const ports = new Map();
  let n = 0;
  const memberOf = (id) => id.split(':')[2];
  return {
    starts: [],
    stopped: [],
    async start(spec) {
      this.starts.push(spec);
      const instanceId = instanceIdFor(spec.runId, spec.member, spec.action.id);
      if (!ports.has(spec.member)) ports.set(spec.member, 4400 + n++);
      const already = alreadyRunning.includes(spec.member);
      const snap = { instanceId, status: already ? 'ready' : 'running', ports: { PORT: ports.get(spec.member) } };
      snaps.set(instanceId, snap);
      return already ? { ...snap, warnings: [], alreadyActive: true } : { ...snap };
    },
    get(id) { return snaps.get(id) || null; },
    waitFor(id) {
      const member = memberOf(id);
      if (neverReady.includes(member)) return new Promise(() => {});
      const snap = snaps.get(id);
      return new Promise((resolve) => setTimeout(() => {
        if (member in exitCodes) Object.assign(snap, { status: 'exited', exitCode: exitCodes[member] });
        else if (failReady === member) Object.assign(snap, { readyError: `${member} never listened` });
        else snap.status = 'ready';
        resolve({ ...snap });
      }, readyAfter));
    },
    async stop(id) { this.stopped.push(id); const s = snaps.get(id); if (s) s.status = 'stopped'; },
    portOf(member) { return ports.get(member); },
  };
}

const svc = (id) => ({ id, label: id, kind: 'service', cmd: 'x', env: [], ready: { kind: 'port', timeoutMs: 1000 } });
const task = (id) => ({ id, label: id, kind: 'task', cmd: 'x', env: [], ready: { kind: 'immediate' } });
const svcStack = (members) => ({ id: 'dev', kind: 'service', steps: members.map((member) => ({ member, action: 'run', env: [] })) });
const taskStack = (members) => ({ id: 'ci', kind: 'task', steps: members.map((member) => ({ member, action: 'test', env: [] })) });
const svcStep = (st) => ({ worktreeDir: `/w/${st.member}`, branch: 'b', action: svc(st.action) });
const taskStep = (st) => ({ worktreeDir: `/w/${st.member}`, branch: 'b', action: task(st.action) });

test('service stack starts in order, waits for ready, passes {alias.PORT} on', async () => {
  const reg = fakeRegistry({ readyAfter: 10 });
  const res = await runStack({
    runId: 'r1', stack: { id: 'dev', kind: 'service', steps: [
      { member: 'api-1', action: 'run', env: [] },
      { member: 'web-2', action: 'run', env: [{ name: 'API_URL', type: 'text', value: 'http://localhost:{api.PORT}' }] } ] },
    aliases: { 'api-1': 'api', 'web-2': 'web' }, registry: reg,
    resolveStep: (st) => ({ worktreeDir: `/w/${st.member}`, branch: 'b', action: svc(st.action) }),
  });
  assert.equal(res.status, 'running');
  assert.deepEqual(reg.starts.map((s) => s.member), ['api-1', 'web-2']);
  assert.equal(reg.starts[1].extraEnv[0].value, 'http://localhost:{api.PORT}');
  assert.deepEqual(reg.starts[1].extraVars, { 'api.PORT': reg.portOf('api-1') });
});

test('task stack stops at the first failure', async () => {
  const reg = fakeRegistry({ exitCodes: { 'a-1': 0, 'b-2': 1, 'c-3': 0 } });
  const res = await runStack({ runId: 'r1', stack: taskStack(['a-1', 'b-2', 'c-3']), aliases: {}, registry: reg, resolveStep: taskStep });
  assert.equal(res.status, 'failed');
  assert.deepEqual(reg.starts.map((s) => s.member), ['a-1', 'b-2']);
  assert.match(res.error, /b-2/);
});

test('task stack with every step at exit 0 ends done', async () => {
  const reg = fakeRegistry({ exitCodes: { 'a-1': 0, 'b-2': 0 } });
  const res = await runStack({ runId: 'r1', stack: taskStack(['a-1', 'b-2']), aliases: {}, registry: reg, resolveStep: taskStep });
  assert.equal(res.status, 'done');
  assert.deepEqual(reg.stopped, []);
});

test('service stack failure stops the already-started services in reverse order', async () => {
  const reg = fakeRegistry({ failReady: 'web-2' });
  const res = await runStack({ runId: 'r1', stack: svcStack(['api-1', 'web-2']), aliases: { 'api-1': 'api', 'web-2': 'web' }, registry: reg, resolveStep: svcStep });
  assert.equal(res.status, 'failed');
  assert.deepEqual(reg.stopped, ['act:r1:web-2:run', 'act:r1:api-1:run']);
});

test('a service that was already running is reused, not owned: stopStack leaves it alone (D26)', async () => {
  const reg = fakeRegistry({ alreadyRunning: ['api-1'] });
  const res = await runStack({ runId: 'r1', stack: svcStack(['api-1', 'web-2']), aliases: { 'api-1': 'api', 'web-2': 'web' }, registry: reg, resolveStep: svcStep });
  assert.deepEqual(res.instances, ['act:r1:web-2:run']);
  await stopStack(reg, res);
  assert.deepEqual(reg.stopped, ['act:r1:web-2:run']);
});

test('Stop during start: later steps never start, started ones are stopped', async () => {
  const reg = fakeRegistry({ readyAfter: 10 });
  let cancel = false;
  const origStart = reg.start.bind(reg);
  reg.start = async (spec) => { const s = await origStart(spec); cancel = true; return s; };   // Stop pressed after step 1 started
  const res = await runStack({ runId: 'r1', stack: svcStack(['api-1', 'web-2']), aliases: { 'api-1': 'api', 'web-2': 'web' },
    registry: reg, resolveStep: svcStep, isCancelled: () => cancel });
  assert.equal(res.status, 'stopped');
  assert.deepEqual(reg.starts.map((s) => s.member), ['api-1']);
  assert.deepEqual(reg.stopped, ['act:r1:api-1:run']);
});

test('Stop during a step\'s ready wait stops that step at once, not after its timeout', async (t) => {
  const reg = fakeRegistry({ neverReady: ['api-1'] });           // waitFor never resolves for api-1
  // runStack's cancel poll is unref'd; a never-settling fake wait holds no handle, so keep the loop alive here.
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  let cancel = false;
  const p = runStack({ runId: 'r1', stack: svcStack(['api-1', 'web-2']), aliases: { 'api-1': 'api', 'web-2': 'web' },
    registry: reg, resolveStep: svcStep, isCancelled: () => cancel });
  await new Promise((r) => setTimeout(r, 50)); cancel = true;
  const t0 = Date.now(); const res = await p;
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(res.status, 'stopped');
  assert.deepEqual(reg.stopped, ['act:r1:api-1:run']);
  assert.deepEqual(reg.starts.map((s) => s.member), ['api-1']);
});

test('an async resolveStep (member setup still to run) is awaited before the step starts (D29)', async () => {
  const reg = fakeRegistry({ readyAfter: 10 });
  const order = [];
  const res = await runStack({ runId: 'r1', stack: svcStack(['api-1', 'web-2']), aliases: { 'api-1': 'api', 'web-2': 'web' },
    registry: reg, resolveStep: async (st) => { await new Promise((r) => setTimeout(r, 20)); order.push(`setup:${st.member}`); return svcStep(st); } });
  assert.equal(res.status, 'running');
  assert.deepEqual(order, ['setup:api-1', 'setup:web-2']);
  assert.deepEqual(reg.starts.map((s) => s.member), ['api-1', 'web-2']);
});

test('a step whose setup failed fails the stack with the resolver\'s reason', async () => {
  const reg = fakeRegistry({});
  const res = await runStack({ runId: 'r1', stack: svcStack(['api-1']), aliases: {}, registry: reg,
    resolveStep: async (st) => ({ worktreeDir: null, action: svc(st.action), error: 'the setup command of api failed; run setup again' }) });
  assert.equal(res.status, 'failed');
  assert.match(res.error, /setup command of api failed/);
  assert.deepEqual(reg.starts, []);
});

test('a step whose action no longer exists fails the stack cleanly', async () => {
  const reg = fakeRegistry({});
  const res = await runStack({ runId: 'r1', stack: svcStack(['api-1']), aliases: {}, registry: reg,
    resolveStep: (st) => ({ worktreeDir: `/w/${st.member}`, branch: 'b', action: null }) });
  assert.equal(res.status, 'failed');
  assert.match(res.error, /no longer has the action/);
});
