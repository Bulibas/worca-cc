// test/forms-secret-env.test.mjs — the text widget's `secret` and `envDefault` options.
//
// `envDefault` names an environment variable the ENGINE resolves (never an agent, never the
// browser). `secret` keeps the value out of every stored artifact: the stored ask carries only
// `envSet`, and the stored answer carries a marker. These tests pin both halves, and that the
// shipped deckOutputs form uses them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateFormDef } from '../src/shared/forms/form-def.mjs';
import { prepareFormAsk, redactSecrets, formAnswerValidator } from '../src/core/ask-forms.mjs';
import { checkRows } from './helpers/rows.mjs';

const META = JSON.parse(await readFile(new URL('../agents/deckOutputs.meta.json', import.meta.url), 'utf8'));
const FORM = META.ask.forms['deck-outputs'];
const GEN = 'Generate narration audio (ElevenLabs)';
const KEY = 'sk-test-SECRET-1234567890';

const def = (mutate) => {
  const d = JSON.parse(JSON.stringify(FORM));
  mutate?.(d);
  return d;
};

test('gate 1: secret/envDefault are typed, text-widget-only, and a secret field takes no default, enum or required', async () => {
  await checkRows([
    { name: 'gate 1: secret is a boolean and envDefault a variable NAME', run: async () => {
      const bad1 = validateFormDef(def((d) => { d.layout[3].secret = 'yes'; }));
      assert.match(JSON.stringify(bad1.errors), /secret.*true or false/);
      const bad2 = validateFormDef(def((d) => { d.layout[3].envDefault = 'not a name'; }));
      assert.match(JSON.stringify(bad2.errors), /environment variable NAME/);
    } },
    { name: 'gate 1: a secret field cannot carry a default, an enum, or be required', run: async () => {
      for (const [label, mutate] of [
        ['default', (d) => { d.answer.properties.apiKey.default = 'x'; }],
        ['enum', (d) => { d.answer.properties.apiKey.enum = ['a', 'b']; }],
        ['required', (d) => { d.answer.required = ['apiKey']; }],
      ]) {
        const r = validateFormDef(def(mutate));
        assert.equal(r.ok, false, label);
        assert.match(JSON.stringify(r.errors), /bad-secret/, label);
      }
    } },
    { name: 'gate 1: secret and envDefault belong to the text widget only', run: async () => {
      const r = validateFormDef(def((d) => { d.layout[0].secret = true; }));
      assert.equal(r.ok, false);
      assert.ok(r.errors.some((e) => e.message === '"select" has no "secret" key'), JSON.stringify(r.errors));
    } },
  ]);
});

async function ask(env) {
  const dir = await mkdtemp(join(tmpdir(), 'worca-secret-'));
  const r = await prepareFormAsk({
    agentMeta: META, payload: { form: 'deck-outputs', data: {} },
    cwd: dir, pipelineDir: dir, askId: 'clarify-n_outputs-1', env,
  });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r;
}

test('an env-set secret is reported as set, and its value reaches no stored structure', async () => {
  const r = await ask({ ELEVENLABS_API_KEY: KEY, ELEVENLABS_VOICE_ID: 'voice-abc' });
  const item = JSON.stringify(r.ask);
  assert.ok(!item.includes(KEY), 'the key must not be in the ask that gets persisted and broadcast');
  assert.ok(!JSON.stringify(r.autoValues).includes(KEY), 'nor in the auto answer');
  const keyItem = r.ask.layout.find((i) => i.field === 'apiKey');
  assert.equal(keyItem.envSet, true);
  assert.equal(r.secrets.apiKey.value, KEY);
  assert.equal(r.secrets.apiKey.env, 'ELEVENLABS_API_KEY');
  // The sidecar's own definition is not mutated by the resolution.
  assert.equal(META.ask.forms['deck-outputs'].layout.find((i) => i.field === 'apiKey').envSet, undefined);
});

test('envDefault prefills field and unattended answer; nothing set reproduces the standard defaults', async () => {
  await checkRows([
    { name: 'a plain envDefault prefills the field and the unattended answer', run: async () => {
      const r = await ask({ ELEVENLABS_VOICE_ID: 'voice-abc' });
      assert.equal(r.ask.answerSchema.properties.voiceId.default, 'voice-abc');
      assert.equal(r.autoValues.voiceId, 'voice-abc');
      assert.equal(r.ask.layout.find((i) => i.field === 'apiKey').envSet, false, 'no key in the env');
    } },
    { name: 'defaults reproduce the standard pipeline when nothing is set', run: async () => {
      const r = await ask({});
      assert.equal(r.autoValues.deliverables, 'PDF + standalone HTML');
      assert.equal(r.autoValues.audio, 'No audio');
      assert.equal(r.autoValues.apiKey, undefined);
    } },
  ]);
});

test('gate 3 accepts an empty secret (use the environment) and hides it unless audio is chosen', async () => {
  const r = await ask({ ELEVENLABS_API_KEY: KEY });
  const validate = formAnswerValidator(r.ask);
  const off = validate({ values: { deliverables: 'PDF only', audio: 'No audio', apiKey: 'leftover' } });
  assert.equal(off.ok, true);
  assert.equal(off.payload.values.apiKey, undefined, 'a `when`-hidden field is dropped, so a stale key never survives');
  const on = validate({ values: { deliverables: 'PDF only', audio: GEN, voiceId: 'v', apiKey: '' } });
  assert.equal(on.ok, true);
});

test('redactSecrets: typed wins, env is marked, and the real value is only ever held in memory', async () => {
  const r = await ask({ ELEVENLABS_API_KEY: KEY });
  const typed = redactSecrets({ audio: GEN, apiKey: 'typed-key-999' }, r.secrets);
  assert.equal(typed.values.apiKey, '[typed]');
  assert.deepEqual(typed.held, { ELEVENLABS_API_KEY: 'typed-key-999' });

  const viaEnv = redactSecrets({ audio: GEN, apiKey: '' }, r.secrets);
  assert.equal(viaEnv.values.apiKey, '[env:ELEVENLABS_API_KEY]');
  assert.deepEqual(viaEnv.held, { ELEVENLABS_API_KEY: KEY });

  const none = redactSecrets({ audio: 'No audio' }, (await ask({})).secrets);
  assert.equal(none.values.apiKey, '');
  assert.deepEqual(none.held, {});

  for (const v of [typed.values, viaEnv.values, none.values]) {
    assert.ok(!JSON.stringify(v).includes(KEY) && !JSON.stringify(v).includes('typed-key-999'),
      'the stored answer carries no secret');
  }
});
