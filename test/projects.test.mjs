// test/projects.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import {
  addProject,
  addProjects,
  removeProject,
  listProjects,
  normalizeProjectPath,
} from '../src/core/projects.mjs';
import { _resetForTests } from '../src/core/db.mjs';

const created = [];
async function freshHome() {
  const dir = await mkdtemp(join(tmpdir(), 'worca-cc-home-'));
  created.push(dir);
  _resetForTests();
  process.env.WORCA_HOME = dir;
  return dir;
}
after(async () => {
  _resetForTests();
  delete process.env.WORCA_HOME;
  await Promise.all(created.map((d) => rm(d, { recursive: true, force: true })));
});

test('add then list returns the entry, flagged existing', async () => {
  const home = await freshHome();
  const list = await addProject({ name: 'demo', path: home });
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'demo');
  assert.equal(list[0].path, home);
  assert.equal(list[0].exists, true);
  assert.deepEqual(await listProjects(), list);
});

test('duplicate name is rejected (case-insensitive)', async () => {
  const home = await freshHome();
  await addProject({ name: 'Demo', path: home });
  await assert.rejects(() => addProject({ name: 'demo', path: home }), /already exists/);
});

test('remove drops the entry; removing an absent name is a no-op', async () => {
  const home = await freshHome();
  await addProject({ name: 'demo', path: home });
  let list = await removeProject('demo');
  assert.deepEqual(list, []);
  list = await removeProject('nope'); // no-op
  assert.deepEqual(list, []);
});

test('a path that is a file is rejected', async () => {
  const home = await freshHome();
  const file = join(home, 'afile.txt');
  await writeFile(file, 'x', 'utf8');
  await assert.rejects(() => addProject({ name: 'f', path: file }), /not a directory/);
});

test('a non-existent path is accepted and flagged missing', async () => {
  await freshHome();
  const list = await addProject({ name: 'ghost', path: '/no/such/dir/here' });
  assert.equal(list[0].exists, false);
});

test('missing registry file yields an empty list', async () => {
  await freshHome();
  assert.deepEqual(await listProjects(), []);
});

test('an empty registry yields an empty list (never throws)', async () => {
  await freshHome();
  // No JSON file exists under SQLite; a fresh home simply has no project rows.
  assert.deepEqual(await listProjects(), []);
});

test('leading ~ in a path is expanded', () => {
  const out = normalizeProjectPath('~/somewhere');
  assert.equal(out, join(process.env.HOME || homedir(), 'somewhere'));
});

test('addProjects adds the valid rows and reports each skipped row with its reason, in input order', async () => {
  const home = await freshHome();
  const a = join(home, 'a'); const b = join(home, 'b'); const c = join(home, 'c');
  await mkdir(a); await mkdir(b); await mkdir(c);
  const file = join(home, 'readme.txt');
  await writeFile(file, 'x');
  await addProject({ name: 'existing', path: c });

  const { results, projects } = await addProjects([
    { name: 'alpha', path: a },                 // 0 added
    { name: 'ALPHA', path: b },                 // 1 duplicate name within the batch
    { name: 'again', path: c },                 // 2 path already registered
    { name: 'gone', path: join(home, 'nope') }, // 3 no longer exists
    { name: 'file', path: file },               // 4 not a directory
    { name: '  ', path: b },                    // 5 empty name
    { name: 'beta', path: b },                  // 6 added
  ]);

  assert.deepEqual(results.map((r) => [r.index, r.status]), [
    [0, 'added'], [1, 'skipped'], [2, 'skipped'], [3, 'skipped'], [4, 'skipped'], [5, 'skipped'], [6, 'added'],
  ]);
  assert.match(results[1].reason, /already exists/);
  assert.match(results[2].reason, /already registered/);
  assert.equal(results[3].reason, 'folder does not exist');
  assert.equal(results[4].reason, 'path is not a directory');
  assert.equal(results[5].reason, 'project name is required');
  assert.equal(results[0].path, a);
  assert.equal(results[6].name, 'beta');
  assert.deepEqual(projects.map((p) => p.name).sort(), ['alpha', 'beta', 'existing']);
});

test('addProjects tolerates a non-array / junk items without throwing', async () => {
  await freshHome();
  assert.deepEqual((await addProjects(null)).results, []);
  const { results } = await addProjects([null, { name: 1, path: 2 }]);
  assert.deepEqual(results.map((r) => r.status), ['skipped', 'skipped']);
});

test('addProject keeps its contract after the insertProject refactor', async () => {
  const home = await freshHome();
  const list = await addProject({ name: 'demo', path: home });
  assert.equal(list.length, 1);
  assert.equal(list[0].exists, true);
});
