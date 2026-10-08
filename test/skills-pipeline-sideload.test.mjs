// test/skills-pipeline-sideload.test.mjs — skills registry design §4.1/§4.3, the safety net end to end:
// a mock run through the REAL executor whose runClaude seam refuses --plugin-dir before init (a managed
// `disableSideloadFlags` Worca could not read). The refused agent is dispatched again without the set
// plugins, every later agent spawns without them, and the run says so once and goes on.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempHome } from './helpers/temp-home.mjs';
import { skillSetFixture, scratchDir, scratchGitDir as gitDir } from './helpers/skill-sets.mjs';
import { createOrchestrator } from '../src/core/orchestrator.mjs';
import { readRunManifest } from '../src/core/run-manifest.mjs';
import { readPipeline } from '../src/core/artifacts.mjs';
import { runClaude } from '../src/core/claude-runner.mjs';
import { _testing } from '../src/core/graph/executor.mjs';
import { skillLayerText } from '../src/core/skills-registry/texts.mjs';

useTempHome(after);
afterEach(() => { _testing.runClaude = null; });

const REFUSAL = "claude exited with code 1: --plugin-dir is disabled by your organization's managed settings (disableSideloadFlags)";
const LINE = "skills from sets not loaded: this machine's Claude Code refuses --plugin-dir";
const AUDIT = "Set skills dropped: this machine's Claude Code refuses --plugin-dir; later agents run without them.";

test('a refused --plugin-dir drops the set skills for the rest of the run: one re-dispatch, one warning, the record says blocked', async () => {
  const { dir } = await skillSetFixture();
  const calls = [];
  _testing.runClaude = async (opts) => {
    calls.push(opts.pluginDirs);
    if (opts.pluginDirs?.length) throw new Error(REFUSAL);
    return runClaude(opts);                       // the offline mock runner
  };
  const orch = createOrchestrator({ projectDir: dir, prompt: 'x', auto: true, claude: { mock: true } });
  assert.equal((await orch.run()).status, 'done', 'the run goes on');
  assert.ok(calls.length >= 3, 'several agents spawned');
  assert.equal(calls[0]?.length, 1, 'the first agent carried the set plugin');
  assert.equal(calls[1], undefined, 'and was dispatched again without it');
  assert.equal(calls.filter(Boolean).length, 1, 'every later agent spawned without it');
  const m = await readRunManifest(orch.getState().pipelineDir);
  assert.equal(m.warnings.filter((w) => w === LINE).length, 1);
  const blocked = { blocked: 'sideload-disabled', text: skillLayerText('sideload-disabled') };
  assert.deepEqual(m.skillMount.layer, blocked);
  assert.deepEqual(orch.getState().skillMount.layer, blocked);
  assert.deepEqual(orch.skillLayer.pluginDirs, []);
  const audit = (await readPipeline(orch.projectDir, orch.state.id)).auditMarkdown;
  assert.equal(audit.split(AUDIT).length - 1, 1, 'the audit says so once (its Context line told what would load)');
});

test('onSkillSideloadRefused: fan-out siblings refused together say it once; a run without set skills has nothing to drop', async () => {
  const orch = createOrchestrator({ projectDir: gitDir('skills-refuse'), claude: { mock: true } });
  orch.runRoot = scratchDir('worca-skills-rr-');
  const logs = [];
  const states = [];
  orch.on('log', (l) => logs.push(l));
  orch.on('state', (s) => states.push(s));
  orch.onSkillSideloadRefused();
  await orch._mcpTail;
  assert.equal(orch.skillLayer, null);
  assert.equal(await readRunManifest(orch.runRoot), null, 'nothing recorded');
  assert.deepEqual([logs.length, states.length], [0, 0], 'nothing said');
  orch.skillLayer = { base: '/b', pluginDirs: ['/b/billing'], plugins: [], mounted: [{}], skipped: [], blocked: null };
  orch.state.skillMount = { base: '/b', plugins: [], skipped: [], layer: { blocked: null, text: null } };
  orch.onSkillSideloadRefused();
  orch.onSkillSideloadRefused();
  await orch._mcpTail;
  const m = await readRunManifest(orch.runRoot);
  assert.deepEqual(m.warnings, [LINE]);
  assert.deepEqual(m.skillMount.layer, { blocked: 'sideload-disabled', text: skillLayerText('sideload-disabled') });
  assert.deepEqual(orch.skillLayer.pluginDirs, []);
  assert.deepEqual(logs.filter((l) => l.text === LINE).map((l) => [l.source, l.level]), [['skills', 'warn']], 'said once, beside the run\'s other skills lines');
  assert.equal(states.length, 1, 'the run page hears it at once');
  assert.equal(states[0].skillMount.layer.blocked, 'sideload-disabled');
});
