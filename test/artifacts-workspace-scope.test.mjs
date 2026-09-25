// test/artifacts-workspace-scope.test.mjs — what a workspace row says about its
// members.
//
// ROUND 3, F7. listAllPipelines tags a workspace pipeline with the PRIMARY
// member's path as `projectDir` and nothing else about the others. Chat's /direct
// scopes by project — `lastPathSegment(projectDir) === scope || projectNames
// includes scope` — and the live runs-Map entry has carried `projectNames` all
// along, so the scoping worked while the run was live and stopped working the
// moment it left the Map (any server restart). From a non-primary member's chat
// the run then vanished and /direct refused a direction that postDirection, which
// has no project scope at all, accepts with a 201 — the same drift between the two
// surfaces that DIRECTABLE was widened to end.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetForTests } from '../src/core/db.mjs';
import { seedPipelineRow } from './helpers/db-seed.mjs';
import { writeStoreMeta, listAllPipelines } from '../src/core/artifacts.mjs';

let home, prevHome;
const WKEY = 'ws-abcd1234';
const MEMBERS = ['/repos/worca-api', '/repos/worca-web', '/repos/worca-docs'];

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'worca-cc-wsscope-'));
  prevHome = process.env.WORCA_HOME;
  process.env.WORCA_HOME = home;
  _resetForTests();
  writeStoreMeta(WKEY, 'workspace', { key: WKEY, name: 'Platform', projectPaths: MEMBERS });
  seedPipelineRow({
    id: 'pipe-ws000001', projectKey: `workspaces/${WKEY}`, workspaceKey: WKEY,
    target: 'workspace', title: 'interrupted by a restart', status: 'interrupted',
  });
});

after(async () => {
  _resetForTests();
  if (prevHome === undefined) delete process.env.WORCA_HOME; else process.env.WORCA_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

test('a workspace history row names every member, not just the primary', async () => {
  const rows = await listAllPipelines({ lite: true });
  const row = rows.find((r) => r.id === 'pipe-ws000001');
  assert.ok(row, 'the seeded workspace pipeline is missing from the listing');
  assert.equal(row.target, 'workspace');
  assert.equal(row.projectDir, MEMBERS[0], 'projectDir is still the primary member');
  assert.deepEqual(row.projectNames, ['worca-api', 'worca-web', 'worca-docs']);

  // The scope test /direct actually applies, for every member — the non-primary
  // ones are what regressed.
  const inScope = (r, scope) => !scope
    || String(r.projectDir || '').split(/[\\/]/).filter(Boolean).pop() === scope
    || (r.projectNames || []).includes(scope);
  for (const name of ['worca-api', 'worca-web', 'worca-docs']) {
    assert.equal(inScope(row, name), true, `a chat scoped to ${name} cannot see the run`);
  }
  assert.equal(inScope(row, 'some-other-project'), false, 'and the scope still excludes non-members');
});
