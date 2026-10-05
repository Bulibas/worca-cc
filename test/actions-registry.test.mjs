import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActionRegistry, reapOrphans, busyRunIdsFromPidFile } from '../src/core/actions/registry.mjs';

const dir = mkdtempSync(join(tmpdir(), 'act-reg-'));
const server = join(dir, 'srv.mjs');
writeFileSync(server, `import http from 'node:http';
  http.createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('listening ' + process.env.PORT));`);
const deaf = join(dir, 'deaf.mjs');
writeFileSync(deaf, 'setInterval(() => {}, 1000);');
const node = `"${process.execPath}"`;
const reg = new ActionRegistry({ pidFile: join(dir, 'live.json'), portRange: () => ({ low: 4460, high: 4499 }) });
after(() => reg.stopAll());

const spec = (over) => ({ runId: 'ab12cd34', member: 'web-5e6f7a8b', worktreeDir: dir, branch: 'worca-cc/x',
  action: { id: 'run', label: 'Run', kind: 'service', cmd: `${node} "${server}"`, cwd: '.',
    env: [{ name: 'PORT', type: 'port', value: 'auto' }], openUrl: 'http://localhost:{PORT}',
    ready: { kind: 'port', port: 'PORT', timeoutMs: 10000 } }, ...over });

test('service gets an auto port, becomes ready, exposes its url, stops', async () => {
  const snap = await reg.start(spec());
  const ready = await reg.waitFor(snap.instanceId, (s) => s.status === 'ready');
  assert.ok(ready.ports.PORT >= 4460 && ready.ports.PORT <= 4499);
  assert.equal(ready.url, `http://localhost:${ready.ports.PORT}`);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'live.json'), 'utf8')).map((e) => e.instanceId), [snap.instanceId]);
  await reg.stop(snap.instanceId);
  assert.equal(reg.get(snap.instanceId).status, 'stopped');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'live.json'), 'utf8')), []);
});

test('auto never hands out a port held by another running action', async () => {
  const a = await reg.start(spec({ member: 'a-11111111' }));
  const b = await reg.start(spec({ member: 'b-22222222' }));
  assert.notEqual(reg.get(a.instanceId).ports.PORT, reg.get(b.instanceId).ports.PORT);
  await reg.stopAll();
});

test('typed port held by another action warns', async () => {   // out-of-range values are refused at save (Step 1)
  const a = await reg.start(spec({ member: 'a-11111111' }));
  const held = reg.get(a.instanceId).ports.PORT;
  const b = await reg.start(spec({ member: 'b-22222222', action: { ...spec().action, env: [{ name: 'PORT', type: 'port', value: held }] } }));
  assert.match(b.warnings.join(' '), new RegExp(`${held}.*already`));
  await reg.stopAll();
});

test('port ready check accepts a service that listens on ::1 only', async (t) => {
  const v6 = join(dir, 'v6.mjs');
  writeFileSync(v6, `import http from 'node:http';
    http.createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT), '::1').on('error', () => process.exit(9));`);
  const s = await reg.start(spec({ member: 'v-66666666', action: { ...spec().action, cmd: `${node} "${v6}"` } }));
  const r = await reg.waitFor(s.instanceId, (x) => x.status === 'ready' || x.readyError || x.status === 'exited');
  if (r.status === 'exited' && r.exitCode === 9) { await reg.stop(s.instanceId); return t.skip('no IPv6 loopback on this host'); }
  assert.equal(r.status, 'ready');
  await reg.stop(s.instanceId);
});

test('port ready check times out with a readable message, service keeps running', async () => {
  const s = await reg.start(spec({ action: { ...spec().action, cmd: `${node} "${deaf}"`, ready: { kind: 'port', port: 'PORT', timeoutMs: 1000 } } }));
  const r = await reg.waitFor(s.instanceId, (x) => x.readyError);
  assert.match(r.readyError, /never listened on port \d+ that Worca gave it \(PORT\)/);
  assert.equal(r.status, 'running');
  await reg.stop(s.instanceId);
});

test('task reports exit code; re-run replaces the finished instance', async () => {
  const f = join(dir, 'fail.mjs'); writeFileSync(f, 'console.log("x"); process.exit(2)');
  const t = { action: { id: 'test', label: 'Test', kind: 'task', cmd: `${node} "${f}"`, cwd: '.', env: [], openUrl: null, ready: { kind: 'immediate' } } };
  const s1 = await reg.start(spec(t));
  const done = await reg.waitFor(s1.instanceId, (x) => x.status === 'exited');
  assert.equal(done.exitCode, 2);
  const s2 = await reg.start(spec(t));
  assert.equal(s2.instanceId, s1.instanceId);
  assert.notEqual(s2.startedAt, done.startedAt);
});

test('concurrent starts neither crash nor share a port; a duplicate start is idempotent', async () => {
  const [a, b, a2] = await Promise.all([
    reg.start(spec({ member: 'a-11111111' })), reg.start(spec({ member: 'b-22222222' })), reg.start(spec({ member: 'a-11111111' }))]);
  assert.equal(a2.instanceId, a.instanceId);
  assert.equal(a2.alreadyActive, true);
  assert.notEqual(reg.get(a.instanceId).ports.PORT, reg.get(b.instanceId).ports.PORT);
  assert.equal(reg.list().filter((s) => s.instanceId === a.instanceId).length, 1);
  await reg.stopAll();
});

test('an escaping cwd is refused before anything is reserved', async () => {
  await assert.rejects(reg.start(spec({ member: 'c-33333333', action: { ...spec().action, cwd: '../x' } })), /inside the worktree/);
  assert.equal(reg.get('act:ab12cd34:c-33333333:run'), null);
  assert.equal(reg.heldPorts().size, 0);
});

test('busyRunIdsFromPidFile reads live rows only', () => {
  const f = join(dir, 'busy.json');
  writeFileSync(f, JSON.stringify([{ pid: 1, ownerPid: process.pid, instanceId: 'act:r1:m:run' }, { pid: 2, ownerPid: 999999, instanceId: 'act:r2:m:run' }]));
  assert.deepEqual([...busyRunIdsFromPidFile(f, { isAlive: (p) => p !== 999999 })], ['r1']);
});

test('reapOrphans kills entries whose owner is dead and clears the file', async () => {
  const killed = [];
  const file = join(dir, 'orph.json');
  writeFileSync(file, JSON.stringify([{ pid: 111, ownerPid: 999999, instanceId: 'act:x:y:z' }, { pid: 222, ownerPid: process.pid, instanceId: 'act:x:y:w' }]));
  const n = await reapOrphans({ pidFile: file, isAlive: (pid) => pid !== 999999, isGroupLeader: async () => true, kill: (pid) => killed.push(pid) });
  assert.equal(n, 1);
  assert.deepEqual(killed, [111]);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).map((e) => e.pid), [222]);
});
