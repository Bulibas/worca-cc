// test/codex-guardrails-subagents.test.mjs — what a Codex spawn holds of worca's guardrails (command rules in a
// worca-managed CODEX_HOME), worca's investigator as a codex agent role, the Codex fan-out and skills prompts,
// the skills mount folder and the memory block intro on an engine that does not load `.claude/rules`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, lstatSync, readlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTempHome } from './helpers/temp-home.mjs';
import { fakeCodex } from './helpers/fake-codex.mjs';
import {
  codexRulePlan, codexRulesFile, unenforcedRules, partialRules, guardedCodexHome, codexInvestigatorRole, runCodexProcess, CODEX_INVESTIGATOR_ROLE,
} from '../src/core/engines/codex.mjs';
import { fanOutDirective } from '../src/core/phases.mjs';
import { assembleSkills, skillsRelFor } from '../src/core/run-context.mjs';
import { renderMemoryBlock, MEMORY_BLOCK_INTRO } from '../src/core/memory-store.mjs';

useTempHome(after);
const POSIX = { skip: process.platform === 'win32' };
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'codex-g-'))); dirs.push(d); return d; };

test('codexRulePlan: a bare Bash and WebSearch are held, command prefixes only in part; paths, MCP tools and globs are not', () => {
  const p = codexRulePlan({ deny: ['Bash(git push)', 'Bash(git push:*)', 'Bash(npm run *)', 'Bash', 'WebSearch', 'WebFetch', 'Read(.env*)', 'Edit(*.pem)', 'mcp__pg__drop', 'Bash(rm *foo*)', 'Bash(echo "x")'], allow: ['Bash(ls:*)'] });
  assert.deepEqual(p.prefixes, [['git', 'push'], ['npm', 'run']]);
  assert.equal(p.shellOff, true);
  assert.equal(p.webSearchOff, true);
  assert.deepEqual(p.unenforced, ['Read(.env*)', 'Edit(*.pem)', 'mcp__pg__drop', 'Bash(rm *foo*)', 'Bash(echo "x")']);
  assert.deepEqual(p.enforced, ['Bash', 'WebSearch', 'WebFetch']);
  assert.deepEqual(p.partial, ['Bash(git push)', 'Bash(git push:*)', 'Bash(npm run *)']);
  assert.deepEqual(unenforcedRules({ deny: ['Bash(curl:*)'] }), []);
  assert.deepEqual(partialRules({ deny: ['Bash(curl:*)'] }), ['Bash(curl:*)']);
  assert.deepEqual(codexRulePlan(null), { prefixes: [], shellOff: false, webSearchOff: false, enforced: [], partial: [], unenforced: [] });
});

test('codexRulesFile: one forbidden prefix rule per command, quoted as Starlark strings', () => {
  assert.equal(codexRulesFile([['git', 'push']]),
    'prefix_rule(pattern=["git","push"], decision="forbidden", justification="worca guardrail: Bash(git push:*)")\n');
});

test('guardedCodexHome: one home per rule set, the rules written, the user\'s sign-in linked in', POSIX, () => {
  const base = tmp(); const user = tmp();
  writeFileSync(join(user, 'auth.json'), '{}');
  const a = guardedCodexHome('A\n', { base, userHome: user });
  assert.equal(guardedCodexHome('A\n', { base, userHome: user }), a, 'the same rules: the same home (a resumed thread is found)');
  assert.notEqual(guardedCodexHome('B\n', { base, userHome: user }), a);
  assert.equal(readFileSync(join(a, 'rules', 'worca.rules'), 'utf8'), 'A\n');
  assert.ok(lstatSync(join(a, 'auth.json')).isSymbolicLink());
  assert.equal(readlinkSync(join(a, 'auth.json')), join(user, 'auth.json'));
});

test('guardedCodexHome: runs starting together never leave the rules file empty or partial', POSIX, async () => {
  // Each worker calls guardedCodexHome on the same fresh homes at once (a barrier per home), then reads the
  // rules file: it must always hold the whole rule set, never a truncated write of another run.
  const base = tmp(); const user = tmp();
  const rules = `${'prefix_rule(pattern=["git","push"], decision="forbidden")\n'.repeat(4000)}`;
  const workers = 6; const rounds = 30;
  const script = join(tmp(), 'writer.mjs');
  writeFileSync(script, `import { workerData, parentPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const { guardedCodexHome } = await import(workerData.mod);
const gate = new Int32Array(workerData.gate);
const bad = [];
for (let i = 0; i < workerData.rounds; i++) {
  Atomics.add(gate, i, 1);
  while (Atomics.load(gate, i) < workerData.workers) { /* barrier: every worker writes this home together */ }
  const home = guardedCodexHome(workerData.rules, { base: join(workerData.base, String(i)), userHome: workerData.user });
  const got = readFileSync(join(home, 'rules', 'worca.rules'), 'utf8');
  if (got !== workerData.rules) bad.push(got.length);
}
parentPort.postMessage(bad);
`);
  const { Worker } = await import('node:worker_threads');
  const gate = new SharedArrayBuffer(4 * rounds);
  const mod = new URL('../src/core/engines/codex.mjs', import.meta.url).href;
  const results = await Promise.all(Array.from({ length: workers }, () => new Promise((res, rej) => {
    const w = new Worker(script, { workerData: { mod, gate, rules, base, user, rounds, workers } });
    w.once('message', res); w.once('error', rej);
  })));
  assert.deepEqual(results.flat(), [], 'every read saw the complete rules file');
  for (let i = 0; i < rounds; i++) {
    const [home] = readdirSync(join(base, String(i)));
    assert.deepEqual(readdirSync(join(base, String(i), home, 'rules')), ['worca.rules'], 'no temp file is left behind');
  }
});

test('runCodexProcess: deny rules put codex under the guarded home and turn web search off; no rules leave CODEX_HOME alone', POSIX, async () => {
  const dir = tmp();
  const fake = fakeCodex(dir, 'ok');
  await runCodexProcess({ cwd: dir, bin: fake.bin, prompt: 'P', usageDir: dir, permissionRules: { deny: ['Bash(git push:*)', 'WebSearch', 'Read(.env)'] } });
  const home = fake.env().CODEX_HOME;
  assert.match(readFileSync(join(home, 'rules', 'worca.rules'), 'utf8'), /pattern=\["git","push"\]/);
  assert.ok(fake.args().includes('web_search="disabled"'));
  const prev = process.env.CODEX_HOME; delete process.env.CODEX_HOME;
  try {
    await runCodexProcess({ cwd: dir, bin: fake.bin, prompt: 'P', usageDir: dir, permissionRules: { deny: ['Read(.env)'] } });
    assert.equal(fake.env().CODEX_HOME, undefined);
  } finally { if (prev !== undefined) process.env.CODEX_HOME = prev; }
});

test('codexInvestigatorRole: worca\'s prompt plus the memory block; a Codex model and effort kept, a Claude one dropped', () => {
  const r = codexInvestigatorRole({ agents: { 'worca-investigator': { description: 'D', prompt: 'Investigate.', model: 'gpt-5.6-luna', effort: 'max' } }, subagentSystemPrompt: '## Worca memory\nx' });
  assert.equal(r.description, 'D');
  assert.equal(r.toml, 'developer_instructions = "Investigate.\\n\\n## Worca memory\\nx"\nmodel = "gpt-5.6-luna"\nmodel_reasoning_effort = "xhigh"\n');
  const c = codexInvestigatorRole({ agents: { x: { prompt: 'P', model: 'sonnet', effort: 'medium' } } });
  assert.equal(c.toml.includes('model = '), false, 'a Claude alias means nothing to codex: the role inherits the node\'s model');
  assert.match(codexInvestigatorRole({}).toml, /read-only investigator/);
});

test('runCodexProcess: a fan-out spawn (the sub-agent tool granted) defines the investigator role for the call, then removes its file', POSIX, async () => {
  const dir = tmp();
  const fake = fakeCodex(dir, 'ok');
  await runCodexProcess({ cwd: dir, bin: fake.bin, prompt: 'P', usageDir: dir, allowedTools: ['Read', 'Task', 'Agent'], appendSubagentSystemPrompt: '## Worca memory\nm' });
  const args = fake.args();
  assert.ok(args.includes(`agents.${CODEX_INVESTIGATOR_ROLE}.description="Read-only investigator for one area; reports its findings to the agent that dispatched it."`));
  const cfg = args.find((a) => a.startsWith(`agents.${CODEX_INVESTIGATOR_ROLE}.config_file=`));
  assert.ok(cfg);
  assert.equal(existsSync(JSON.parse(cfg.split('=')[1])), false, 'the role file lives only as long as the spawn');
  await runCodexProcess({ cwd: dir, bin: fake.bin, prompt: 'P', usageDir: dir, allowedTools: ['Read'] });
  assert.equal(fake.args().some((a) => a.startsWith('agents.')), false, 'no fan-out: no role');
});

test('runCodexProcess: a fan-out\'s sub-agent rows carry the role and its model (the stream itself names neither)', POSIX, async () => {
  const dir = tmp();
  const lines = readFileSync(new URL('./fixtures/codex/collab-wait.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const fake = fakeCodex(dir, null, { lines });
  const events = [];
  await runCodexProcess({ cwd: dir, bin: fake.bin, prompt: 'P', usageDir: dir, allowedTools: ['Read', 'Task'], onEvent: (e) => events.push(e),
    agents: { 'worca-investigator': { prompt: 'Investigate.', model: 'gpt-5.6-luna' } } });
  const spawn = events.find((e) => e.type === 'subagent' && e.event === 'spawn');
  assert.equal(spawn.label, 'Codex sub-agents');
  assert.equal(spawn.subagentType, CODEX_INVESTIGATOR_ROLE);
  assert.equal(spawn.model, 'gpt-5.6-luna');
});

test('fanOutDirective on codex: spawn_agent with the investigator role, skills from .agents/skills, no Claude model block', () => {
  const t = fanOutDirective(true, { engine: 'codex', subagentModel: 'auto', investigator: true });
  assert.match(t, /agent_type: "worca_investigator"/);
  assert.match(t, /WITHOUT forking your history/);
  assert.match(t, /\.agents\/skills/);
  assert.equal(/Task\/Agent|subagent_type|sonnet/.test(t), false);
  assert.equal(fanOutDirective(false, { engine: 'codex' }), '');
  assert.match(fanOutDirective(true, {}), /Task\/Agent tool/, 'Claude unchanged');
});

test('skills mount where the engine reads them: codex gets .agents/skills, plus the user\'s ~/.claude/skills', async () => {
  const proj = tmp(); const home = tmp(); const target = join(tmp(), '.agents', 'skills');
  for (const [root, name] of [[proj, 'lint'], [home, 'mine']]) {
    mkdirSync(join(root, '.claude', 'skills', name), { recursive: true });
    writeFileSync(join(root, '.claude', 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
  }
  assert.equal(skillsRelFor('codex'), join('.agents', 'skills'));
  assert.equal(skillsRelFor('claude'), join('.claude', 'skills'));
  const out = await assembleSkills({ target, members: [{ projectKey: 'p-1', projectName: 'p', projectDir: proj }], homeDir: home, rel: skillsRelFor('codex') });
  assert.deepEqual(out.names.sort(), ['lint', 'mine']);
  assert.deepEqual(out.records.map((r) => r.path).sort(), [join('.agents', 'skills', 'lint'), join('.agents', 'skills', 'mine')]);
  const claude = await assembleSkills({ target: join(tmp(), '.claude', 'skills'), members: [{ projectKey: 'p-1', projectName: 'p', projectDir: proj }], homeDir: home });
  assert.deepEqual(claude.names, ['lint'], 'Claude Code reads ~/.claude/skills itself');
});

test('the memory block on codex says to read the rules (nothing loads them), and keeps one intro line', () => {
  const codex = renderMemoryBlock([{ label: 'Project', dir: '/m/p' }], { engine: 'codex' });
  const claude = renderMemoryBlock([{ label: 'Project', dir: '/m/p' }]);
  assert.ok(claude.includes(MEMORY_BLOCK_INTRO));
  assert.equal(codex.includes('Claude Code has already loaded'), false);
  assert.match(codex, /Nothing has loaded them for you: before you start, read the files/);
  assert.equal(codex.split('\n').length, claude.split('\n').length);
});
