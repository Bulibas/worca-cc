// test/skills-pipeline-resume.test.mjs — skills registry design §4.3 / §2b-15: resume re-resolves the
// set skills and re-materializes the mount before the first resumed spawn (a missing --plugin-dir
// path is silently ignored by the CLI), minus the stored opt-out — on detached and legacy runs —
// and does not repeat a warning the run already reported. Mock runs, custom runners, temp WORCA_HOME.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { useTempHome } from './helpers/temp-home.mjs';
import { withEnv } from './helpers/with-env.mjs';
import { skillSetFixture, addSkills, spawnRecord } from './helpers/skill-sets.mjs';
import { createOrchestrator } from '../src/core/orchestrator.mjs';
import { readPipelineForResume } from '../src/core/artifacts.mjs';
import { readRunManifest } from '../src/core/run-manifest.mjs';
import { resolveSkillRegistry } from '../src/core/skills-registry/resolve.mjs';
import { skillSkipMessage } from '../src/core/skills-registry/texts.mjs';

useTempHome(after);

/** Producer/verifier runners that record each dispatch at spawn time; the first producer call can park the run. */
function runners(seen, box = null) {
  let hang = !!box;
  return {
    producer: async (ctx) => {
      seen.push(spawnRecord(ctx));
      if (hang) {
        hang = false;
        queueMicrotask(() => box.orch.pause());
        return new Promise((_r, rej) => {
          const onAbort = () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); };
          if (ctx.signal.aborted) onAbort(); else ctx.signal.addEventListener('abort', onAbort, { once: true });
        });
      }
      return { status: 'ok', summary: 'ok' };
    },
    verifier: async (ctx) => { seen.push(spawnRecord(ctx)); return { status: 'ok', issues: [], review: { issues: [] }, summary: '' }; },
  };
}

/** A problem skip the real resolution does not produce (a membership whose skill left the catalog). */
const GHOST = { setId: 'general', setName: 'General', skillId: 'skill:library:ghost', name: 'ghost', reason: 'missing-skill' };
const withGhost = (orch) => { orch._skillRegistry = async (opts) => { const r = await resolveSkillRegistry(opts); return { ...r, skipped: [...r.skipped, GHOST] }; }; };

test('detached resume: the mount is rebuilt from the live set before the first resumed spawn, minus the stored opt-out; a reported warning is not repeated', async () => {
  const { dir, set } = await skillSetFixture();
  const optOut = [`${set.id}|skill:library:release-notes`];
  const run1 = [];
  const box = {};
  const orch1 = createOrchestrator({ projectDir: dir, prompt: 'x', auto: true, claude: { mock: true }, mcpOptOut: optOut, runners: runners(run1, box) });
  box.orch = orch1;
  withGhost(orch1);
  assert.equal((await orch1.run()).status, 'paused');
  const pdir = orch1.getState().pipelineDir;
  const plugin = join(pdir, 'skills', set.slug);
  assert.deepEqual(run1[0].skills, [['deploy-checklist']]);
  // While paused: the mount is lost and a skill joins the set.
  await rm(join(pdir, 'skills'), { recursive: true, force: true });
  await addSkills(set.id, ['incident-triage']);
  const run2 = [];
  const orch2 = createOrchestrator({ projectDir: dir, auto: true, claude: { mock: true }, runners: runners(run2), resume: readPipelineForResume(orch1.state.id) });
  withGhost(orch2);
  assert.equal((await orch2.resume()).status, 'done');
  assert.deepEqual(orch2.mcpOptOut, optOut);
  assert.equal(run2[0].dirs[0], plugin);
  assert.ok(run2[0].present, 're-materialized before the first resumed spawn');
  assert.deepEqual(run2[0].skills, [['deploy-checklist', 'incident-triage']], 'the live set, minus the stored opt-out');
  const line = skillSkipMessage(GHOST);
  const log = await readFile(join(pdir, 'live-log.ndjson'), 'utf8');
  assert.equal(log.split('\n').filter((l) => l.includes(JSON.stringify(line).slice(1, -1))).length, 1, 'warned once across both segments');
  assert.equal((await readRunManifest(pdir)).warnings.filter((w) => w === line).length, 1, 'kept in run.json after the re-assembly rewrote it');
});

test('legacy resume: the layer is resolved and the mount rebuilt too; a reported warning is not repeated', async () => {
  const { dir, set } = await skillSetFixture();
  await withEnv({ WORCA_RUN_ROOT: 'legacy' }, async () => {
    const run1 = [];
    const box = {};
    const orch1 = createOrchestrator({ projectDir: dir, prompt: 'x', auto: true, claude: { mock: true }, runners: runners(run1, box) });
    box.orch = orch1;
    withGhost(orch1);
    assert.equal((await orch1.run()).status, 'paused');
    const pdir = orch1.getState().pipelineDir;
    await rm(join(pdir, 'skills'), { recursive: true, force: true });
    const run2 = [];
    const orch2 = createOrchestrator({ projectDir: dir, auto: true, claude: { mock: true }, runners: runners(run2), resume: readPipelineForResume(orch1.state.id) });
    withGhost(orch2);
    assert.equal((await orch2.resume()).status, 'done');
    assert.equal(orch2.runRoot, null);
    assert.deepEqual(run2[0].dirs, [join(pdir, 'skills', set.slug)]);
    assert.ok(run2[0].present);
    assert.deepEqual(run2[0].skills, [['deploy-checklist', 'release-notes']]);
    const line = skillSkipMessage(GHOST);
    const log = await readFile(join(pdir, 'live-log.ndjson'), 'utf8');
    assert.equal(log.split('\n').filter((l) => l.includes(JSON.stringify(line).slice(1, -1))).length, 1, 'warned once across both segments (read back from the run log)');
  });
});
