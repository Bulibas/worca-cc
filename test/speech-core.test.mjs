// test/speech-core.test.mjs
// src/core/speech.mjs against an injected fetch: state masking, the multipart
// STT call, the JSON TTS call, typed-over-stored test overrides, and errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateSpeech } from '../src/core/settings.mjs';
import { speechState, transcribe, synthesize, testSpeech, SpeechError, MAX_TTS_CHARS } from '../src/core/speech.mjs';
import { encodeWav } from '../src/shared/speech.mjs';

async function withSandbox(fn) {
  const home = await mkdtemp(join(tmpdir(), 'worca-cc-speechcore-'));
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, WORCA_TEST_ALLOW_HOME_FALLBACK: process.env.WORCA_TEST_ALLOW_HOME_FALLBACK };
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.WORCA_TEST_ALLOW_HOME_FALLBACK = '1';
  try { return await fn(home); } finally {
    for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    await rm(home, { recursive: true, force: true });
  }
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('speechState masks literal keys, echoes ${VAR} refs, flags an unset ref', async () => {
  await withSandbox(async () => {
    await updateSpeech({ stt: { apiKey: 'sk-local-abcdef1234' }, tts: { baseUrl: 'http://127.0.0.1:8880/v1', apiKey: '${TTS_KEY_UNSET_X}' } });
    const s = speechState();
    assert.equal(s.stt.keyMasked, '••••••1234');
    assert.equal(JSON.stringify(s).includes('sk-local'), false);
    assert.equal(s.stt.configured, true);
    assert.equal(s.tts.keyRef, '${TTS_KEY_UNSET_X}');
    assert.equal(s.tts.keyMissing, true);
    assert.equal('apiKey' in s.stt, false);
  });
});

test('transcribe posts multipart with model/language/file and the bearer key', async () => {
  await withSandbox(async () => {
    await updateSpeech({ stt: { language: 'bg', apiKey: 'k-123' } });
    let seen = null;
    const f = async (url, init) => {
      const form = init.body;
      seen = { url: String(url), auth: init.headers.authorization, model: form.get('model'), language: form.get('language'), fmt: form.get('response_format'), file: form.get('file') };
      return json(200, { text: '  здравей  ' });
    };
    const r = await transcribe({ audio: encodeWav(new Float32Array(160)), fetch: f });
    assert.deepEqual(r, { text: 'здравей' });
    assert.equal(seen.url, 'http://127.0.0.1:8080/v1/audio/transcriptions');
    assert.equal(seen.auth, 'Bearer k-123');
    assert.equal(seen.model, 'whisper-1');
    assert.equal(seen.language, 'bg');
    assert.equal(seen.fmt, 'json');
    assert.equal(seen.file.type, 'audio/wav');
    assert.equal(seen.file.size, 44 + 320);
  });
});

test('transcribe: language auto is omitted, keyless local call has no auth header, errors are SpeechErrors', async () => {
  await withSandbox(async () => {
    let seen = null;
    const r = await transcribe({ audio: new Uint8Array(50), fetch: async (url, init) => { seen = init; return json(200, { text: 'hi' }); } });
    assert.equal(r.text, 'hi');
    assert.equal(seen.body.get('language'), null);
    assert.equal(seen.headers.authorization, undefined);
    await assert.rejects(transcribe({ audio: new Uint8Array(0), fetch: async () => json(200, {}) }), (e) => e instanceof SpeechError && e.status === 400);
    await assert.rejects(transcribe({ audio: new Uint8Array(9), fetch: async () => json(401, {}) }), /rejected the key \(401\)/);
    await assert.rejects(transcribe({ audio: new Uint8Array(9), fetch: async () => { throw new Error('ECONNREFUSED'); } }), /unreachable.*ECONNREFUSED/);
    await assert.rejects(transcribe({ audio: new Uint8Array(9), fetch: async () => json(200, { nope: 1 }) }), /without a transcript/);
  });
});

test('synthesize: not configured is 409; configured posts the OpenAI speech body', async () => {
  await withSandbox(async () => {
    await assert.rejects(synthesize({ text: 'hi', fetch: async () => json(200, {}) }), (e) => e.status === 409);
    await updateSpeech({ tts: { baseUrl: 'http://127.0.0.1:8880/v1', voice: 'af_heart', speed: 1.2 } });
    let body = null;
    const up = await synthesize({ text: ' Hello. ', fetch: async (url, init) => { body = [String(url), JSON.parse(init.body)]; return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/wav' } }); } });
    assert.equal(up.headers.get('content-type'), 'audio/wav');
    assert.deepEqual(body, ['http://127.0.0.1:8880/v1/audio/speech', { model: 'tts-1', voice: 'af_heart', input: 'Hello.', speed: 1.2, response_format: 'wav' }]);
    await assert.rejects(synthesize({ text: 'x'.repeat(MAX_TTS_CHARS + 1), fetch: async () => json(200, {}) }), (e) => e.status === 400);
  });
});

test('testSpeech: typed values win over stored, masked echo keeps the stored key (same origin only), never throws', async () => {
  await withSandbox(async () => {
    await updateSpeech({ stt: { apiKey: 'stored-key-99999' } });
    let asked = null;
    const f = async (url, init) => { asked = [String(url), init.headers.authorization]; return json(200, { text: '' }); };
    assert.deepEqual(await testSpeech('stt', { baseUrl: 'http://127.0.0.1:8080/v1/', apiKey: '••••••9999' }, f), { ok: true, detail: 'transcription endpoint answered' });
    assert.deepEqual(asked, ['http://127.0.0.1:8080/v1/audio/transcriptions', 'Bearer stored-key-99999']);
    await testSpeech('stt', { baseUrl: 'http://127.0.0.1:9999/v1', apiKey: '••••••9999' }, f);
    assert.deepEqual(asked, ['http://127.0.0.1:9999/v1/audio/transcriptions', undefined]);   // stored key never leaves its origin
    await testSpeech('stt', { baseUrl: 'http://127.0.0.1:9999/v1', apiKey: 'typed-key' }, f);
    assert.equal(asked[1], 'Bearer typed-key');
    assert.equal((await testSpeech('tts', {}, f)).ok, false);
    assert.match((await testSpeech('tts', {}, f)).message, /not configured/);
    assert.deepEqual(await testSpeech('asr', {}, f), { ok: false, message: 'unknown speech service asr' });
    const tts = await testSpeech('tts', { baseUrl: 'http://127.0.0.1:8880/v1' }, async () => new Response(new Uint8Array(10)));
    assert.deepEqual(tts, { ok: true, detail: '10 bytes of audio' });
  });
});
