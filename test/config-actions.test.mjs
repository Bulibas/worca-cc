// test/config-actions.test.mjs
// Project actions (issue #529) live in project_config.extra.actions, and the
// setup-duration estimate in extra.actionsMeta. Neither may leak into run config.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { useTempHome } from './helpers/temp-home.mjs';
import {
  readRunConfig, readProjectActions, writeProjectActions, readActionsMeta, writeActionsMeta,
  readTeamMetricsPrefs, writeTeamMetricsPrefs,
} from '../src/core/config.mjs';
import { prepare } from '../src/core/db.mjs';
import { projectKey } from '../src/core/store.mjs';

useTempHome(after, 'worca-cc-cfg-actions-home-');
const dirs = [];
after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });
async function freshProject() {
  const d = await mkdtemp(join(tmpdir(), 'cfg-actions-'));
  dirs.push(d);
  return d;
}

test('actions round-trip in project_config.extra and stay out of run config', async () => {
  const dir = await freshProject();
  const key = projectKey(dir);
  writeProjectActions(key, { setup: 'npm ci', actions: [{ id: 'test', label: 'Test', kind: 'task', cmd: 'npm test' }] });
  writeActionsMeta(key, { lastSetupMs: 1234 });
  assert.equal(readProjectActions(key).setup, 'npm ci');
  assert.equal(readProjectActions(key).actions[0].ready.kind, 'immediate');
  assert.equal(readActionsMeta(key).lastSetupMs, 1234);
  const cfg = await readRunConfig(dir);
  assert.equal(cfg.actions, undefined);
  assert.equal(cfg.actionsMeta, undefined);
  assert.throws(() => readProjectActions('/abs/path'), /projectKey/);
  assert.throws(() => writeProjectActions(key, { actions: [{ id: 'x', kind: 'daemon', cmd: 'a' }] }), (e) => e.code === 'BAD_REQUEST');
});

test('an unknown project reads as empty actions and empty meta', async () => {
  const key = projectKey(await freshProject());
  const cfg = readProjectActions(key);
  assert.equal(cfg.setup, null);
  assert.deepEqual(cfg.actions, []);
  assert.equal(cfg.builtins.editor, true);
  assert.deepEqual(readActionsMeta(key), {});
});

test('a rejected write leaves the stored config untouched', async () => {
  const key = projectKey(await freshProject());
  writeProjectActions(key, { setup: 'npm ci' });
  assert.throws(() => writeProjectActions(key, { setup: 'make', actions: [{ id: 'BAD id', kind: 'task', cmd: 'x' }] }));
  assert.equal(readProjectActions(key).setup, 'npm ci');
});

test('invalid stored actions read as empty instead of throwing', async () => {
  const key = projectKey(await freshProject());
  writeProjectActions(key, {});
  prepare('UPDATE project_config SET extra = ? WHERE project_key = ?')
    .run(JSON.stringify({ actions: { actions: [{ id: 'x', kind: 'daemon', cmd: 'a' }] } }), key);
  assert.deepEqual(readProjectActions(key).actions, []);
});

test('actions writes keep sibling extra keys and meta merges shallowly', async () => {
  const key = projectKey(await freshProject());
  writeTeamMetricsPrefs(key, { enabled: true });
  writeActionsMeta(key, { lastSetupMs: 10 });
  writeActionsMeta(key, { other: 1 });
  writeProjectActions(key, { setup: 'npm ci' });
  assert.deepEqual(readActionsMeta(key), { lastSetupMs: 10, other: 1 });
  assert.equal(readTeamMetricsPrefs(key).enabled, true);
  assert.equal(readProjectActions(key).setup, 'npm ci');
});
