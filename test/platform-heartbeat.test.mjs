// test/platform-heartbeat.test.mjs
// W3 / B1 / B5: the heartbeat a hosting control plane receives. The body (counts by state from the
// live-run list and the DB, health, suspendable, next scheduled run, today's counts), that it holds
// no strings besides health and version, and that nothing is sent unless both env vars are set —
// the case of a self-hosted deployment such as worca-01.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { useTempHome } from './helpers/temp-home.mjs';
import { getDb } from '../src/core/db.mjs';
import { AFTER_RUN_AT } from '../src/core/scheduler.mjs';
import {
  buildHeartbeatBody, classifyLiveRun, heartbeatConfig, startPlatformHeartbeat, nextScheduledAt,
  dbPipelineCounts, todayCounts, dbWritable, diskNearlyFull, PIPELINE_KEYS,
} from '../src/core/platform-heartbeat.mjs';

useTempHome(after);

const V = '1.9.0';
const zero = { running: 0, waiting: 0, done: 0, failed: 0, stopped: 0 };

/** Every leaf that isn't a number, a boolean or null, with its path. */
function nonNumericLeaves(obj, path = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;
    if (v && typeof v === 'object') out.push(...nonNumericLeaves(v, p));
    else if (v !== null && typeof v !== 'number' && typeof v !== 'boolean') out.push(p);
  }
  return out;
}

test('an idle instance: fixed keys at zero, ok, suspendable', () => {
  const b = buildHeartbeatBody({ liveRuns: [], version: V });
  assert.deepEqual(b, { health: 'ok', version: V, pipelines: zero, nextScheduledAt: null, suspendable: true, today: { done: 0, failed: 0, stopped: 0 } });
});

test('live runs through each state land in the right bucket', () => {
  const cases = [
    [{ status: 'created' }, 'running'],
    [{ status: 'starting' }, 'running'],
    [{ status: 'running' }, 'running'],
    [{ status: 'pausing' }, 'running'],
    [{ status: 'running', pendingQuestion: { q: 'which?' } }, 'waiting'],
    [{ status: 'paused', pauseReason: 'cost_pipeline' }, 'waiting'],
    [{ status: 'paused', pauseReason: 'cost_total' }, 'waiting'],
    [{ status: 'paused', pauseReason: 'error' }, 'waiting'],
    [{ status: 'paused', pauseReason: 'You have hit your usage limit · resets 5pm' }, 'waiting'],
    [{ status: 'paused', pauseReason: null }, 'stopped'],
    [{ status: 'paused', pauseReason: 'drain' }, 'stopped'],
    [{ status: 'done' }, null],
    [{ status: 'error' }, null],
    [{ status: 'running', kind: 'scriptbench' }, null],
    [{ status: 'running', kind: 'action' }, null],
  ];
  for (const [r, want] of cases) assert.equal(classifyLiveRun(r), want, JSON.stringify(r));

  const b = buildHeartbeatBody({ liveRuns: cases.map(([r]) => r), version: V, dbCounts: { done: 4, failed: 2, stopped: 1 } });
  assert.deepEqual(b.pipelines, { running: 4, waiting: 5, done: 4, failed: 2, stopped: 3 });
  assert.equal(b.suspendable, false);
});

test('suspendable: false for an active run, a bench, an Ask turn, a terminal, an action or a setup job', () => {
  assert.equal(buildHeartbeatBody({ liveRuns: [{ status: 'running', kind: 'agentgen' }], version: V }).suspendable, false);
  assert.equal(buildHeartbeatBody({ liveRuns: [{ status: 'running', kind: 'scriptbench' }], version: V }).suspendable, false);
  for (const k of ['askTurns', 'terminals', 'actions', 'setupJobs']) {
    assert.equal(buildHeartbeatBody({ version: V, busy: { [k]: 1 } }).suspendable, false, k);
    assert.equal(buildHeartbeatBody({ version: V, busy: { [k]: 0 } }).suspendable, true, k);
  }
  // A paused run holds no process: the container may stop.
  assert.equal(buildHeartbeatBody({ liveRuns: [{ status: 'paused', pauseReason: 'cost_total' }], version: V }).suspendable, true);
});

test('health: any signal makes it degraded, and no reason is carried', () => {
  for (const k of ['brokerDown', 'dbWriteFailed', 'diskFull', 'bootFailed', 'schedulerStale']) {
    const b = buildHeartbeatBody({ version: V, signals: { [k]: true } });
    assert.equal(b.health, 'degraded', k);
    assert.ok(!JSON.stringify(b).includes(k));
  }
  assert.equal(buildHeartbeatBody({ version: V, signals: { brokerDown: false } }).health, 'ok');
});

test('the body has no strings besides health and version (no titles, projects or people)', () => {
  const b = buildHeartbeatBody({
    liveRuns: [{ status: 'running', title: 'Secret project', projectDir: '/home/ada/acme', startedBy: 'ada@acme.com', pendingQuestion: { text: 'ship?' } }],
    version: V, nextScheduledAt: 1_900_000_000, today: { done: 1, failed: 0, stopped: 2 },
  });
  assert.deepEqual(Object.keys(b).sort(), ['health', 'nextScheduledAt', 'pipelines', 'suspendable', 'today', 'version']);
  assert.deepEqual(Object.keys(b.pipelines), PIPELINE_KEYS);
  const { health, version, ...rest } = b;
  assert.deepEqual(nonNumericLeaves(rest), []);
  assert.equal(typeof health, 'string');
  assert.equal(typeof version, 'string');
  assert.ok(!/Secret|acme|ada|ship/.test(JSON.stringify(b)));
});

test('config: off unless both vars are set (worca-01 sets neither); https only, http for loopback', () => {
  assert.equal(heartbeatConfig({}), null);
  assert.equal(heartbeatConfig({ WORCA_ALLOWED_HOSTS: 'worca-01.example.com', WORCA_CF_ACCESS_TEAM_DOMAIN: 't.cloudflareaccess.com', WORCA_CF_ACCESS_AUD: 'a' }), null);
  assert.equal(heartbeatConfig({ WORCA_HEARTBEAT_URL: 'https://app.example.com/api/heartbeat' }), null);
  assert.equal(heartbeatConfig({ WORCA_HEARTBEAT_TOKEN: 't' }), null);
  assert.deepEqual(heartbeatConfig({ WORCA_HEARTBEAT_URL: 'https://app.example.com/api/heartbeat', WORCA_HEARTBEAT_TOKEN: 't' }), { url: 'https://app.example.com/api/heartbeat', token: 't' });
  assert.ok(heartbeatConfig({ WORCA_HEARTBEAT_URL: 'http://localhost:8787/api/heartbeat', WORCA_HEARTBEAT_TOKEN: 't' }).url);
  assert.match(heartbeatConfig({ WORCA_HEARTBEAT_URL: 'http://app.example.com/api/heartbeat', WORCA_HEARTBEAT_TOKEN: 't' }).error, /https/);
  assert.match(heartbeatConfig({ WORCA_HEARTBEAT_URL: 'not a url', WORCA_HEARTBEAT_TOKEN: 't' }).error, /https/);
});

test('start: nothing is scheduled or fetched when off; one warning for an insecure URL', async () => {
  let fetched = 0;
  const fetchImpl = async () => { fetched++; return new Response(null, { status: 200 }); };
  assert.equal(startPlatformHeartbeat({ env: {}, collect: () => ({}), fetchImpl, firstDelayMs: 0 }), null);
  const logs = [];
  assert.equal(startPlatformHeartbeat({ env: { WORCA_HEARTBEAT_URL: 'http://evil.example/x', WORCA_HEARTBEAT_TOKEN: 't' }, collect: () => ({}), fetchImpl, log: (m) => logs.push(m), firstDelayMs: 0 }), null);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fetched, 0);
  assert.equal(logs.length, 1);
});

test('start: POSTs the collected body with the bearer token; a failure is logged once per streak', async () => {
  const calls = [];
  let status = 200;
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return new Response('{}', { status }); };
  const logs = [];
  const body = buildHeartbeatBody({ version: V });
  const hb = startPlatformHeartbeat({
    env: { WORCA_HEARTBEAT_URL: 'https://app.example.com/api/heartbeat', WORCA_HEARTBEAT_TOKEN: 'hb-secret' },
    collect: async () => body, fetchImpl, log: (m) => logs.push(m), firstDelayMs: 60_000, intervalMs: 60_000,
  });
  try {
    assert.equal(await hb.beat(), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://app.example.com/api/heartbeat');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.authorization, 'Bearer hb-secret');
    assert.equal(calls[0].init.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(calls[0].init.body), body);
    status = 503;
    assert.equal(await hb.beat(), false);
    assert.equal(await hb.beat(), false);
    assert.equal(logs.filter((l) => /not delivered/.test(l)).length, 1);
    assert.ok(!logs.join('\n').includes('hb-secret'));
    status = 200;
    assert.equal(await hb.beat(), true);
    assert.ok(logs.some((l) => /delivered again/.test(l)));
    // A throwing fetch or collect never escapes.
    const hb2 = startPlatformHeartbeat({
      env: { WORCA_HEARTBEAT_URL: 'https://app.example.com/h', WORCA_HEARTBEAT_TOKEN: 't' },
      collect: () => { throw new Error('boom'); }, fetchImpl, log: () => {}, firstDelayMs: 60_000,
    });
    assert.equal(await hb2.beat(), false);
    hb2.stop();
  } finally {
    hb.stop();
  }
});

test('DB: nextScheduledAt skips the "after another run" placeholder; counts and today come from pipelines', () => {
  const db = getDb();
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO scheduled_runs (id, run_at, request, status, created_at, updated_at) VALUES (?, ?, '{}', ?, ?, ?)`);
  assert.equal(nextScheduledAt(), null);
  ins.run('t-after', AFTER_RUN_AT, 'scheduled', now, now);
  assert.equal(nextScheduledAt(), null, 'the placeholder alone is no planned start');
  ins.run('t-late', '2031-01-02T00:00:00.000Z', 'scheduled', now, now);
  ins.run('t-early', '2030-06-01T12:00:00.000Z', 'scheduled', now, now);
  ins.run('t-fired', '2029-01-01T00:00:00.000Z', 'fired', now, now);
  assert.equal(nextScheduledAt(), Math.floor(Date.parse('2030-06-01T12:00:00.000Z') / 1000));

  const p = db.prepare(`INSERT INTO pipelines (id, project_key, status, started_at, updated_at, archived_at) VALUES (?, 'k', ?, ?, ?, ?)`);
  const old = '2020-01-01T00:00:00.000Z';
  p.run('p1', 'done', now, now, null);
  p.run('p2', 'done', old, old, null);
  p.run('p3', 'error', now, now, null);
  p.run('p4', 'stopped', now, now, null);
  p.run('p5', 'interrupted', old, old, null);
  p.run('p6', 'paused', old, old, null);
  p.run('p7', 'running', now, now, null);   // held live: excluded below
  p.run('p8', 'done', now, now, old);       // archived: never counted
  assert.deepEqual(dbPipelineCounts({ excludeIds: ['p7'] }), { running: 0, waiting: 0, done: 2, failed: 1, stopped: 3 });
  assert.deepEqual(todayCounts(), { done: 2, failed: 1, stopped: 1 });
  assert.equal(dbWritable(db), true);
});

test('disk: below 5% free is nearly full; an unreadable dir is not', async () => {
  assert.equal(await diskNearlyFull('/x', async () => ({ blocks: 1000, bsize: 4096, bavail: 40 })), true);
  assert.equal(await diskNearlyFull('/x', async () => ({ blocks: 1000, bsize: 4096, bavail: 60 })), false);
  assert.equal(await diskNearlyFull('/x', async () => { throw new Error('ENOENT'); }), false);
  assert.equal(typeof (await diskNearlyFull(process.cwd())), 'boolean');
});
