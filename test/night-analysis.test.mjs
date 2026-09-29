// test/night-analysis.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAnalysis, buildAnalysisPrompt, runNightAnalysis } from '../src/core/night/analysis.mjs';
import { useTempHome } from './helpers/temp-home.mjs';

useTempHome(after);

test('normalizeAnalysis maps per-question decisions and drops junk', () => {
  const out = normalizeAnalysis({ decisions: [
    { id: 'q1', choice: 'A', confidence: 150, rationale: 'r', reversible: true, scores: { A: { reversible: 9, bogus: 3 } } },
    { id: 7 },
  ] });
  assert.deepEqual(Object.keys(out), ['q1']);
  assert.equal(out.q1.confidence, 100);
  assert.deepEqual(out.q1.scores, { A: { reversible: 9 } });
});

test('normalizeAnalysis redacts secrets from the rationale (stored, broadcast and served)', () => {
  const key = 'sk-ant-' + 'a'.repeat(24);
  const out = normalizeAnalysis({ decisions: [{ id: 'q1', choice: 'A', confidence: 80, rationale: `the .env holds ${key}`, reversible: true, scores: {} }] });
  assert.ok(!out.q1.rationale.includes(key));
  assert.match(out.q1.rationale, /sk-ant-<redacted>/);
});

test('prompt carries question, options, criteria weights, memory and task', () => {
  const p = buildAnalysisPrompt({ questions: [{ id: 'q1', question: 'Store?', options: ['Redis', 'Postgres'] }],
    task: 'build it', planPaths: ['/p/plan.md'], memory: '- prefer Postgres', criteria: { matchesMemory: 3, cost: 1 } });
  for (const s of ['Store?', 'Redis', 'Postgres', 'matchesMemory (weight 3)', 'prefer Postgres', 'build it', '/p/plan.md']) assert.ok(p.includes(s), s);
});

test('runNightAnalysis parses the reply and reports cost', async () => {
  let seen = null;
  const run = async (o) => {
    seen = o;
    o.onEvent({ type: 'result', costUsd: 0.02, raw: { usage: { input_tokens: 10, output_tokens: 5 } } });
    return { text: '```json\n{"decisions":[{"id":"q1","choice":"Redis","confidence":70,"rationale":"r","reversible":true,"scores":{}}]}\n```' };
  };
  const r = await runNightAnalysis({ questions: [{ id: 'q1', question: '?', options: ['Redis'] }], cwd: '/tmp', run, memory: '', task: 't' });
  assert.equal(r.byId.q1.choice, 'Redis');
  assert.ok(r.costUsd > 0);
  assert.deepEqual(r.usage, { input_tokens: 10, output_tokens: 5 });
  assert.deepEqual(seen.allowedTools, ['Read', 'Grep', 'Glob'], 'read-only tools only');
  // Its prompt carries agent-written question text: no MCP servers, user hooks/plugins or
  // slash commands, no edit mode, and the Ask Worca secret-path denies.
  assert.equal(seen.permissionMode, 'dontAsk');
  assert.equal(seen.strictMcpConfig, true);
  assert.deepEqual(seen.settingSources, ['project']);
  assert.equal(seen.disableSlashCommands, true);
  for (const rule of ['Bash', 'Edit', 'Write', 'Read(~/.ssh/**)', 'Read(//**/.env*)']) assert.ok(seen.permissionRules.deny.includes(rule), rule);
  // ...but it must still read the run's checkout and its plan files.
  assert.ok(!seen.permissionRules.deny.some((r) => /\.worca-cc\/(store|runs)\//.test(r)), 'the run checkout and plan stay readable');
});

test('mock mode answers offline: recommended else first, confident', async () => {
  const r = await runNightAnalysis({ mock: true, questions: [{ id: 'a', options: ['x', 'y'], recommended: 'y' }, { id: 'b', options: ['p'] }] });
  assert.deepEqual([r.byId.a.choice, r.byId.b.choice, r.costUsd], ['y', 'p', 0]);
});
