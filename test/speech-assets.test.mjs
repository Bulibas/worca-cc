// test/speech-assets.test.mjs
// The in-browser speech engines' file cache (docs/speech.md): allow-listed,
// pinned, SHA-256-checked runtime files; models pinned to a Hugging Face
// commit; one download shared by concurrent callers; nothing else fetched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { createSpeechAssets, SPEECH_LIBS, SPEECH_MODELS } from '../src/core/speech-assets.mjs';

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'worca-speech-assets-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const ok = (bytes) => new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });

test('lib: only allow-listed names; a hash mismatch is refused and leaves nothing behind', async () => {
  await withDir(async (dir) => {
    const body = Buffer.from('export const x = 1;');
    const name = 'transformers.min.js';
    const calls = [];
    const f = async (url) => { calls.push(url); return ok(body); };
    const assets = createSpeechAssets({ dir, fetch: f });
    await assert.rejects(assets.lib('evil.js'), (e) => e.status === 404);
    await assert.rejects(assets.lib(name), /integrity check/);          // real pin ≠ these bytes
    assert.deepEqual(await readdir(join(dir, 'lib')), []);              // no partial file left behind
    assert.equal(calls[0], SPEECH_LIBS[name].url);
    for (const spec of Object.values(SPEECH_LIBS)) assert.match(spec.sha256, /^[0-9a-f]{64}$/);
  });
});

test('lib: a matching download is stored and served from disk the second time', async () => {
  await withDir(async (dir) => {
    const body = Buffer.from('wasm bytes');
    const libs = { 'x.wasm': { url: 'https://cdn.example/x.wasm', sha256: crypto.createHash('sha256').update(body).digest('hex'), type: 'application/wasm' } };
    let n = 0;
    const assets = createSpeechAssets({ dir, libs, fetch: async () => { n += 1; return ok(body); } });
    const r = await assets.lib('x.wasm');
    assert.equal(r.type, 'application/wasm');
    assert.deepEqual(await readFile(r.file), body);
    await assets.lib('x.wasm');
    assert.equal(n, 1);
  });
});

test('model: allow-listed repo pinned to its commit; concurrent callers share one download; bad paths 404', async () => {
  await withDir(async (dir) => {
    const repo = 'onnx-community/whisper-base';
    const urls = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const f = async (url) => { urls.push(url); await gate; return ok(Buffer.from('{"a":1}')); };
    const assets = createSpeechAssets({ dir, fetch: f });
    const a = assets.model(repo, 'config.json');
    const b = assets.model(repo, 'config.json');
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(urls.length, 1);
    assert.equal(urls[0], `https://huggingface.co/${repo}/resolve/${SPEECH_MODELS[repo]}/config.json`);
    // The caller that started the download gets the bytes as they arrive; the other waits for the disk copy.
    assert.equal(ra.type, 'application/json');
    assert.equal(ra.length, 7);
    let streamed = '';
    for await (const c of ra.body) streamed += c;
    assert.equal(streamed, '{"a":1}');
    assert.equal(await readFile(rb.file, 'utf8'), '{"a":1}');
    assert.equal((await assets.model(repo, 'config.json')).file, rb.file);
    assert.equal(urls.length, 1);                                        // served from disk
    for (const bad of ['../x', 'onnx/../../x', '.hidden', 'a//b', '/abs']) {
      await assert.rejects(assets.model(repo, bad), (e) => e.status === 404, bad);
    }
    await assert.rejects(assets.model('openai/whisper-large', 'config.json'), (e) => e.status === 404);
    assert.equal(urls.length, 1);
  });
});

test('model: an upstream 404 is a 404 and is not cached; a network error is a 502', async () => {
  await withDir(async (dir) => {
    let mode = '404';
    const f = async () => { if (mode === 'throw') throw new Error('offline'); return new Response('nope', { status: 404 }); };
    const assets = createSpeechAssets({ dir, fetch: f });
    await assert.rejects(assets.model('onnx-community/whisper-base', 'processor_config.json'), (e) => e.status === 404);
    mode = 'throw';
    await assert.rejects(assets.model('onnx-community/whisper-base', 'processor_config.json'), (e) => e.status === 502 && /offline/.test(e.message));
  });
});

test('size counts every file; clear removes them and is refused mid-download', async () => {
  await withDir(async (dir) => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let gated = false;
    const f = async () => { if (gated) await gate; return ok(Buffer.from('12345')); };
    const assets = createSpeechAssets({ dir, fetch: f });
    const land = async (file) => {                   // the first caller streams: drain, then the disk copy exists
      const r = await assets.model('onnx-community/whisper-base', file);
      if (r.body) for await (const _ of r.body) { /* drain */ }
      await assets.model('onnx-community/whisper-base', file);
    };
    await land('config.json');
    await land('onnx/a.onnx');
    assert.equal(assets.size(), 10);
    gated = true;
    const pending = assets.model('onnx-community/whisper-base', 'tokenizer.json');
    assert.throws(() => assets.clear(), (e) => e.status === 409);
    release();
    const r = await pending;
    for await (const _ of r.body) { /* drain */ }
    await assets.model('onnx-community/whisper-base', 'tokenizer.json');
    assert.equal(assets.clear(), 15);
    assert.equal(assets.size(), 0);
  });
});

test('downloaded(): per engine, true once a finished .onnx of its model is on disk', async () => {
  await withDir(async (dir) => {
    const assets = createSpeechAssets({ dir, fetch: async () => ok(Buffer.from('x')) });
    assert.deepEqual(assets.downloaded(), { stt: false, tts: false });
    const r = await assets.model('onnx-community/whisper-base', 'onnx/encoder_model.onnx');
    for await (const _ of r.body) { /* drain */ }
    await assets.model('onnx-community/whisper-base', 'onnx/encoder_model.onnx');
    assert.deepEqual(assets.downloaded(), { stt: true, tts: false });
  });
});
