// test/terminal-boot.test.mjs — boot order (#573): the terminal pid file is cleaned before the Actions
// keep policy and checkout cap read it. After a container restart the new server reuses the old one's pid,
// so a stale terminal row looks live and would keep its run "busy" (never evicted, never released).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { useTempHome } from './helpers/temp-home.mjs';
import { seedPipeline } from './helpers/db-seed.mjs';
import { getDb } from '../src/core/db.mjs';
import { worcaHome } from '../src/core/projects.mjs';
import { terminalPidFile } from '../src/core/terminal/paths.mjs';

useTempHome(after, 'worca-cc-termboot-');
// settings.json lives under HOME: never the real one.
const prevHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const home = await mkdtemp(join(tmpdir(), 'worca-cc-termboot-home-'));
Object.assign(process.env, { HOME: home, USERPROFILE: home });
const created = [home];
after(async () => {
  for (const [k, v] of Object.entries(prevHome)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await Promise.all(created.map((d) => rm(d, { recursive: true, force: true })));
});

let bootMaintenance, checkoutRun, listCheckouts, setActionsSettings;
before(async () => {
  ({ bootMaintenance } = await import('../ui/server.mjs'));
  ({ checkoutRun, listCheckouts } = await import('../src/core/checkout.mjs'));
  ({ setActionsSettings } = await import('../src/core/settings.mjs'));
});

const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
async function checkedOutRun(feature) {                     // as in test/checkout.test.mjs
  const repo = await mkdtemp(join(tmpdir(), 'worca-cc-termboot-repo-'));
  created.push(repo);
  git(repo, ['init', '-q', '-b', 'main']); git(repo, ['config', 'user.email', 't@t']); git(repo, ['config', 'user.name', 't']);
  await writeFile(join(repo, 'README.md'), '# hi\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'init']); git(repo, ['branch', feature]);
  const { id, key } = await seedPipeline(repo, { status: 'done',
    branch: { source: 'main', feature, runRootMode: 'detached', worktreeRemoved: true, branchKept: true } });
  getDb().prepare(`UPDATE pipelines SET branch = json_set(branch, '$.worktreeDir', ?) WHERE id = ?`)
    .run(join(worcaHome(), 'runs', id, 'repos', key), id);
  await checkoutRun({ id });
  return id;
}

test('a terminal row left by the previous server (same pid) does not keep its run out of the checkout cap', async () => {
  const older = await checkedOutRun('worca-cc/a');
  await new Promise((r) => setTimeout(r, 20));
  const newer = await checkedOutRun('worca-cc/b');
  await setActionsSettings({ maxCheckouts: 1 });
  const pidFile = terminalPidFile(worcaHome());
  await mkdir(dirname(pidFile), { recursive: true });
  // The old server's row: its owner pid is this process's (pid reuse), its shell is long gone.
  await writeFile(pidFile, JSON.stringify([{ pid: 2 ** 22 + 7, ownerPid: process.pid, sessionId: 't-old', instanceId: `term:${older}:t-old` }]));

  const summary = await bootMaintenance({ log: () => {} });
  assert.deepEqual(JSON.parse(await readFile(pidFile, 'utf8')), []);
  assert.equal(summary.actions.evicted, 1);
  assert.deepEqual(listCheckouts().map((c) => c.runId), [newer], 'the oldest checkout went, as with no terminal open');
});
