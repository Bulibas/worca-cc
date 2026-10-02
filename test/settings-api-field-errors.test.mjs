// test/settings-api-field-errors.test.mjs
// #555: a POST /api/settings validation failure answers 400 { error, field }, where `field` is the
// body path of the bad input (the path a Settings input carries in data-setting) and `error`
// names the visible label, never an internal camelCase or dotted key.
//
// SANDBOX: HOME/USERPROFILE point at a temp dir and WORCA_HOME is removed, so the settings file
// is never the real ~/.worca-cc one (same boot as test/settings-projects-root.test.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { _resetForTests } from '../src/core/db.mjs';

const NO_KEY = /\b[a-z]+[A-Z][a-z]\w*\b|\b(?:askWeb|memoryDefrag|workspaceScan|nightMode|actions|sync|schedule|criteria|chat|search)\.\w+/;

let home, srv, apiBase;
const prev = {};

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'worca-cc-fielderr-'));
  for (const k of ['HOME', 'USERPROFILE', 'WORCA_HOME', 'WORCA_TEST_ALLOW_HOME_FALLBACK',
    'WORCA_PROJECTS_ROOT']) prev[k] = process.env[k];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.WORCA_HOME;
  delete process.env.WORCA_PROJECTS_ROOT;
  process.env.WORCA_TEST_ALLOW_HOME_FALLBACK = '1';
  _resetForTests();
  const { app } = await import('../ui/server.mjs');
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  apiBase = `http://127.0.0.1:${srv.address().port}`;
});

after(async () => {
  if (srv) await new Promise((r) => srv.close(r));
  _resetForTests();
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  _resetForTests();
  await rm(home, { recursive: true, force: true });
});

const postApi = (body) => fetch(`${apiBase}/api/settings`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

// [bad body, expected field]
const cases = [
  [{ actions: { portLow: 5000, portHigh: 4000 } }, 'actions.portRange'],
  [{ actions: { portLow: 80 } }, 'actions.portLow'],
  [{ askMaxTurns: 0 }, 'askMaxTurns'],
  [{ askMaxBudgetUsd: 500 }, 'askMaxBudgetUsd'],
  [{ pipelineCostLimitUsd: -1 }, 'pipelineCostLimitUsd'],
  [{ schedule: { maxFailures: 101 } }, 'schedule.maxFailures'],
  [{ sync: { refreshMinutes: 9999 } }, 'sync.refreshMinutes'],
  [{ titleModel: 'nope-model' }, 'titleModel'],
  [{ projectsRoot: '/definitely/missing' }, 'projectsRoot'],
  [{ nightMode: { maxDecisions: 0 } }, 'nightMode.maxDecisions'],
];
for (const [body, field] of cases) {
  test(`POST /api/settings ${JSON.stringify(body)} → 400, field ${field}, no internal key`, async () => {
    const r = await postApi(body);
    const j = await r.json();
    assert.equal(r.status, 400, JSON.stringify(j));
    assert.equal(j.field, field, JSON.stringify(j));
    assert.equal(typeof j.error, 'string');
    assert.doesNotMatch(j.error, NO_KEY);
  });
}
