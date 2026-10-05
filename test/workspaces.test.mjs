// test/workspaces.test.mjs
// Unit coverage for the workspace registry (src/core/workspaces.mjs): key
// derivation (order-independent + rename-stable), the D1 duplicate-set dedupe
// key, canonical-root de-dupe, the full-length description and the delete
// traversal guard. Persist shape, derived read-time fields, rename
// and delete live in workspaces-db.test.mjs.
//
// Each test sandboxes via a throwaway WORCA_HOME (mirrors projects.test.mjs).
// Members must be real git repos because createWorkspace validates isGitRepo.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  workspaceKey,
  rootsHash,
  readWorkspace,
  createWorkspace,
  updateWorkspaceDescription,
  deleteWorkspace,
} from '../src/core/workspaces.mjs';
import { workspaceStorePath } from '../src/core/store.mjs';
import { getDb, _resetForTests } from '../src/core/db.mjs';
import { checkRows } from './helpers/rows.mjs';
import { templateRepo } from './helpers/git-dir.mjs';

const created = [];
after(async () => {
  _resetForTests();
  delete process.env.WORCA_HOME;
  await Promise.all(created.map((d) => rm(d, { recursive: true, force: true })));
});

async function freshHome() {
  const dir = await mkdtemp(join(tmpdir(), 'worca-cc-ws-home-'));
  created.push(dir);
  _resetForTests();
  process.env.WORCA_HOME = dir;
  return dir;
}

/** A real git repo so isGitRepo() validation passes for real. */
function freshRepo(prefix = 'worca-cc-ws-repo-') {
  const dir = templateRepo('ws-repo', { branch: 'main', user: true, files: { 'README.md': '# hi\n' }, prefix });
  created.push(dir);
  return dir;
}

test('workspaceKey / rootsHash: wks-<slug>-<hash>, order-independent, name changes the key but not the roots hash', async () => {
  const a = await freshRepo();
  const b = await freshRepo();
  await checkRows([
    { name: 'workspaceKey is "wks-<nameSlug>-<sha1[:8]>" and order-independent over roots', run: async () => {
      const k1 = workspaceKey({ name: 'IoT SP Platform', projectPaths: [a, b] });
      const k2 = workspaceKey({ name: 'IoT SP Platform', projectPaths: [b, a] }); // reversed
      assert.equal(k1, k2, 'sorted roots => order-independent key');
      assert.match(k1, /^wks-[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$/);
      assert.ok(k1.startsWith('wks-iot-sp-platform-'), 'name slug embedded');
    } },
    { name: 'rootsHash is name-independent and order-independent (D1 dedupe key)', run: async () => {
      const h1 = rootsHash([a, b]);
      const h2 = rootsHash([b, a]);
      assert.equal(h1, h2);
      assert.match(h1, /^[0-9a-f]{8}$/);
      // Two differently-named workspaces over the same set share the hash, differ in key.
      const kx = workspaceKey({ name: 'Alpha', projectPaths: [a, b] });
      const ky = workspaceKey({ name: 'Beta', projectPaths: [a, b] });
      assert.notEqual(kx, ky, 'name changes the key');
      assert.ok(kx.endsWith(h1) && ky.endsWith(h1), 'roots-hash tail is shared across names');
    } },
  ]);
});

test('createWorkspace de-dupes members by canonical root; collapse below 2 is BAD_REQUEST', async () => {
  await freshHome();
  const a = await freshRepo();
  const b = await freshRepo();
  // Same repo passed twice (plus a trailing-slash variant) collapses to one root -> <2 -> BAD_REQUEST.
  await assert.rejects(() => createWorkspace({ name: 'Collapse', projectPaths: [a, a + '/'] }),
    (e) => e.code === 'BAD_REQUEST');

  // a duplicated but b distinct => 2 distinct roots after de-dupe => OK, stored as 2.
  const ws = await createWorkspace({ name: 'Dedup OK', projectPaths: [a, a, b] });
  assert.equal(ws.projectPaths.length, 2, 'duplicate canonical roots collapsed to distinct set');
});

test('updateWorkspaceDescription stores the FULL description (cap-on-freeze, not cap-on-store)', async () => {
  await freshHome();
  const a = await freshRepo();
  const b = await freshRepo();
  const ws = await createWorkspace({ name: 'Long Desc', projectPaths: [a, b] });
  const big = 'x'.repeat(5000);
  const updated = await updateWorkspaceDescription(ws.id, big);
  assert.equal(updated.description.length, 5000, 'editable description is never truncated on store');
  const row = getDb().prepare('SELECT description FROM workspaces WHERE id = ?').get(ws.id);
  assert.equal(row.description.length, 5000);
});

test('deleteWorkspace rejects a path-traversal id and deletes NOTHING outside the namespace', async () => {
  const home = await freshHome();
  const a = await freshRepo();
  const b = await freshRepo();
  // A real workspace + its store dir, plus a sibling project store dir that a
  // crafted "../<key>" id would target. Both MUST survive a traversal attempt.
  const ws = await createWorkspace({ name: 'Victim', projectPaths: [a, b] });
  const wsStore = workspaceStorePath(ws.id);
  await mkdir(join(wsStore, 'pipelines'), { recursive: true });
  const store = join(home, '.worca-cc', 'store');
  const siblingProj = join(store, 'some-proj-12345678');
  await mkdir(siblingProj, { recursive: true });
  await writeFile(join(siblingProj, 'meta.json'), '{}', 'utf8');
  const outsideDir = join(home, '.worca-cc');        // would be hit by '../..'
  assert.ok(existsSync(outsideDir));

  for (const evil of ['../..', '../../store/some-proj-12345678', '..', 'wks-x/../../..', '/etc']) {
    await assert.rejects(() => deleteWorkspace(evil),
      (e) => e.code === 'NOT_FOUND', `crafted id ${JSON.stringify(evil)} must be NOT_FOUND`);
  }

  // Nothing outside the (untouched) namespace was removed.
  assert.ok(existsSync(siblingProj), 'sibling project store dir survives');
  assert.ok(existsSync(join(store, 'workspaces')), 'workspaces container survives');
  assert.ok(existsSync(outsideDir), '.worca-cc dir survives');
  assert.ok(existsSync(wsStore), 'the real workspace store dir survives (no membership match for evil ids)');
  assert.ok(await readWorkspace(ws.id), 'the real registry entry survives');
});
