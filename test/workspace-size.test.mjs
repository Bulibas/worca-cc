// test/workspace-size.test.mjs
// Workspace size (D21–D23): the shared limits module, the 40-member create cap shared by
// createWorkspace and the scan launch, and the scan description budget that grows with the
// member count (300 -> 500 -> 800 lines).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { useTempHome } from './helpers/temp-home.mjs';
import { checkRows } from './helpers/rows.mjs';
import { workspaceSizeLevel, scanDescriptionBudget } from '../src/shared/workspace-size.mjs';
import { checkNewWorkspace, createWorkspace, listWorkspaces } from '../src/core/workspaces.mjs';

useTempHome(after);

// 41 throwaway repos: `git init` is all isGitRepo / canonicalProjectRoot need (no commit).
let root;
let repos = [];
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'worca-cc-wssize-'));
  repos = Array.from({ length: 41 }, (_, i) => join(root, `p${String(i).padStart(2, '0')}`));
  for (const dir of repos) spawnSync('git', ['init', '-q', dir]);
});
after(() => rm(root, { recursive: true, force: true }));

const tooMany = (e) => e.code === 'BAD_REQUEST' && /at most 40 member projects \(41 given\)/.test(e.message);

test('size thresholds: workspaceSizeLevel and scanDescriptionBudget boundaries', async () => {
  await checkRows([
    { name: 'the limits: 40 members at most, warnings above 10 and above 20', run: () => {
      assert.deepEqual([0, 2, 10, 11, 20, 21, 40, 41].map((n) => workspaceSizeLevel(n)),
        ['ok', 'ok', 'ok', 'big', 'big', 'very-big', 'very-big', 'over']);
    } },
    { name: 'the description budget grows past 5 and past 20 members, then tops out', run: () => {
      assert.deepEqual([2, 5, 6, 20, 21, 40, 57].map((n) => scanDescriptionBudget(n)), [300, 300, 500, 500, 800, 800, 800]);
    } },
  ]);
});

test('create cap: 40 distinct members pass (a duplicate path does not count); 41 are refused by the scan launch and createWorkspace', async () => {
  await checkRows([
    { name: 'the cap counts DISTINCT members: 41 paths naming 40 repos pass', run: () => {
      const ok = checkNewWorkspace({ name: 'Dup path', projectPaths: [...repos.slice(0, 40), repos[0]] });
      assert.equal(ok.projectPaths.length, 40);
    } },
    { name: 'create cap: 40 members pass; 41 are refused by the scan launch AND by createWorkspace', run: async () => {
      assert.throws(() => checkNewWorkspace({ name: 'Forty-one', projectPaths: repos }), tooMany);
      await assert.rejects(() => createWorkspace({ name: 'Forty-one', projectPaths: repos }), tooMany);
      assert.ok(!(await listWorkspaces()).some((w) => w.name === 'Forty-one'), 'nothing written');
    } },
  ]);
});
