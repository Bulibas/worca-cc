import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { migrate, SCHEMA_VERSION } from '../src/core/db.mjs';
import { useTempHome } from './helpers/temp-home.mjs';
import { projectKey } from '../src/core/store.mjs';
import {
  createWorkspace, readWorkspaceStacks, updateWorkspaceStacks, workspaceMembers,
} from '../src/core/workspaces.mjs';

useTempHome(after);

test('v47 adds workspaces.actions_json to a v46 DB without touching rows', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.exec('ALTER TABLE workspaces DROP COLUMN actions_json');
  db.prepare("INSERT INTO workspaces (id, name, description, created_at, updated_at) VALUES ('wks-a-0cea65fb','A','', 'x','x')").run();
  db.exec('PRAGMA user_version = 46');
  migrate(db);
  const cols = db.prepare('PRAGMA table_info(workspaces)').all().map((c) => c.name);
  assert.ok(cols.includes('actions_json'));
  assert.equal(db.prepare('SELECT actions_json FROM workspaces').get().actions_json, null);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.ok(SCHEMA_VERSION >= 47);
});

test('workspace stacks: [] by default, update round-trips, members sorted by key', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'worca-v47-ws-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirs = ['web', 'api'].map((n) => {
    const d = join(root, n);
    execFileSync('git', ['init', '-q', d]);
    return d;
  });
  const ws = await createWorkspace({ name: 'Stack WS', projectPaths: dirs });

  assert.deepEqual(readWorkspaceStacks(ws.id), []);
  assert.deepEqual(readWorkspaceStacks('wks-missing-00000000'), []);

  const stacks = [{ id: 'dev', label: 'Dev stack', kind: 'service', steps: [] }];
  assert.deepEqual(await updateWorkspaceStacks(ws.id, stacks), stacks);
  assert.deepEqual(readWorkspaceStacks(ws.id), stacks);
  await assert.rejects(updateWorkspaceStacks('wks-missing-00000000', stacks), { code: 'NOT_FOUND' });

  const members = await workspaceMembers(ws.id);
  const expected = dirs.map((d) => ({ projectKey: projectKey(d), name: basename(d) }))
    .sort((a, b) => a.projectKey.localeCompare(b.projectKey));
  assert.deepEqual(members.map(({ projectKey: k, name }) => ({ projectKey: k, name })), expected);
  assert.ok(members.every((m) => typeof m.projectDir === 'string' && m.projectDir));
  assert.equal(await workspaceMembers('wks-missing-00000000'), null);
});
