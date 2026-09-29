// test/clarify-secret-fields.test.mjs
// A `secret` text field through the REAL clarifier executor: whatever the human types (or the
// environment supplies unattended), the answers PORT FILE, the returned values and every
// persisted row carry a marker — the value lives only in runCtx.secretEnv, in memory, for the
// script children of this run.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClarifierExecution } from '../src/core/graph/executor.mjs';

const META = JSON.parse(await readFile(new URL('../agents/deckOutputs.meta.json', import.meta.url), 'utf8'));
const GEN = 'Generate narration audio (ElevenLabs)';
const TYPED = 'typed-SECRET-abcdef';
const ENVKEY = 'env-SECRET-123456';

const dirs = [];
after(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 3 }))));
const prevHome = {};
before(async () => {
  const home = await mkdtemp(join(tmpdir(), 'worca-secret-home-'));
  dirs.push(home);
  for (const k of ['HOME', 'USERPROFILE']) { prevHome[k] = process.env[k]; process.env[k] = home; }
});
after(() => { for (const [k, v] of Object.entries(prevHome)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

async function ctxFor({ askImpl }) {
  const pipelineDir = await mkdtemp(join(tmpdir(), 'worca-cc-secret-'));
  dirs.push(pipelineDir);
  const secretEnv = {};
  return {
    projectDir: pipelineDir, pipelineDir, pipelineId: null, taskPrompt: 'demo',
    node: { id: 'n_outputs', kind: 'agent', key: 'deckOutputs',
      agentPrompt: `Raise the form.\n\nMOCK_ROLE: clarify\nMOCK_ASK_FORM: ${JSON.stringify({ form: 'deck-outputs', data: {} })}\n` },
    meta: { key: 'deckOutputs', displayName: 'Deck Outputs', runnerType: 'clarifier', ask: META.ask },
    ports: { inputs: [{ id: 'task', type: 'md', required: true, as: 'file' }],
      outputs: [{ id: 'answers', type: 'json', when: 'always', filename: 'deck-outputs.json', store: 'run', artifactKind: 'deck-outputs' }] },
    bindings: {},
    outputs: { answers: { path: join(pipelineDir, 'deck-outputs.json'), type: 'json' } },
    verdict: null, ordinal: 1, executionId: 'x:n_outputs:1',
    runCtx: { pipelineDir, baseName: 'demo', secretEnv },
    claudeOpts: { mock: true },
    onEvent: () => {},
    ask: askImpl,
  };
}

const withEnv = async (vars, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};

const noSecret = (label, ...blobs) => {
  for (const b of blobs) {
    const text = typeof b === 'string' ? b : JSON.stringify(b);
    assert.ok(!text.includes(TYPED) && !text.includes(ENVKEY), `${label}: carries a secret`);
  }
};

test('a typed key: the port file and returned values carry a marker; the key lives only in secretEnv', async () => {
  await withEnv({ ELEVENLABS_API_KEY: ENVKEY, ELEVENLABS_VOICE_ID: 'voice-9' }, async () => {
    const seen = [];
    const ctx = await ctxFor({ askImpl: async (q) => {
      seen.push(q);
      return { form: q.form, version: q.version, values: { deliverables: 'PDF only', audio: GEN, voiceId: 'voice-9', apiKey: TYPED } };
    } });
    const out = await runClarifierExecution(ctx);

    // what the surface was told: the variable is set, never its value
    noSecret('the broadcast ask', seen[0].layout, seen[0].answerSchema, seen[0].autoValues);
    assert.equal(seen[0].layout.find((i) => i.field === 'apiKey').envSet, true);

    const file = await readFile(ctx.outputs.answers.path, 'utf8');
    noSecret('deck-outputs.json', file);
    assert.equal(JSON.parse(file).values.apiKey, '[typed]');
    assert.equal(JSON.parse(file).values.voiceId, 'voice-9', 'the voice id is not sensitive and is kept');
    noSecret('the returned values', out.values);
    assert.equal(ctx.runCtx.secretEnv.ELEVENLABS_API_KEY, TYPED, 'typed wins over the environment');
  });
});

test('an empty key means "use the environment": marker names the variable, the env value is held', async () => {
  await withEnv({ ELEVENLABS_API_KEY: ENVKEY }, async () => {
    const ctx = await ctxFor({ askImpl: async (q) => ({ form: q.form, version: q.version,
      values: { deliverables: 'PDF + standalone HTML', audio: GEN, voiceId: 'v', apiKey: '' } }) });
    await runClarifierExecution(ctx);
    const file = await readFile(ctx.outputs.answers.path, 'utf8');
    noSecret('deck-outputs.json', file);
    assert.equal(JSON.parse(file).values.apiKey, '[env:ELEVENLABS_API_KEY]');
    assert.equal(ctx.runCtx.secretEnv.ELEVENLABS_API_KEY, ENVKEY);
  });
});

test('unattended (no ask channel): the defaults apply and the environment supplies voice and key', async () => {
  await withEnv({ ELEVENLABS_API_KEY: ENVKEY, ELEVENLABS_VOICE_ID: 'voice-env' }, async () => {
    const ctx = await ctxFor({ askImpl: undefined });
    await runClarifierExecution(ctx);
    const file = JSON.parse(await readFile(ctx.outputs.answers.path, 'utf8'));
    assert.equal(file.values.deliverables, 'PDF + standalone HTML');
    assert.equal(file.values.audio, 'No audio', 'audio is opt-in: unattended never spends money by default');
    assert.equal(file.values.voiceId, 'voice-env');
    noSecret('deck-outputs.json', JSON.stringify(file));
  });
});

test('no key anywhere: an empty marker and nothing held', async () => {
  await withEnv({ ELEVENLABS_API_KEY: undefined, ELEVENLABS_VOICE_ID: undefined }, async () => {
    const ctx = await ctxFor({ askImpl: async (q) => ({ form: q.form, version: q.version,
      values: { deliverables: 'Deck files only', audio: GEN, voiceId: 'v', apiKey: '' } }) });
    await runClarifierExecution(ctx);
    assert.equal(JSON.parse(await readFile(ctx.outputs.answers.path, 'utf8')).values.apiKey, '');
    assert.deepEqual(ctx.runCtx.secretEnv, {});
  });
});
