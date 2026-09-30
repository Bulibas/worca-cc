// ui/public/speech-worker.mjs
// Ask Worca's in-browser speech engines (docs/speech.md), off the main thread.
// One worker per engine, both on transformers.js: `?kind=stt` runs Whisper,
// `?kind=tts` runs Kokoro with our own English G2P (src/shared/speech-g2p.mjs on
// misaki's dictionaries) — deliberately not kokoro-js, whose bundle carries
// eSpeak NG (GPL-3.0). Every file — the bundle, the onnxruntime wasm, the
// dictionaries and the model weights — comes from worca's own /vendor/speech/*
// (src/core/speech-assets.mjs), never from a CDN.
//
// Protocol: in  { id, op: 'load' } | { id, op: 'transcribe', audio, language } | { id, op: 'speak', text, voice, speed }
//           out { id, ok: true, ... } | { id, ok: false, error } | { op: 'progress', loaded, total }
const KIND = new URL(self.location.href).searchParams.get('kind');
const LIB = `${self.location.origin}/vendor/speech/lib/`;
const HF = 'https://huggingface.co/';
const STT_MODEL = 'onnx-community/whisper-base';
const TTS_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const TTS_VOICE_RE = /^[ab][fm]_[a-z]+$/;
const TTS_DEFAULT_VOICE = 'af_heart';
const TTS_RATE = 24000;

// transformers.js fetches models from huggingface.co: route every such request
// through worca's pinned, allow-listed cache instead.
const netFetch = self.fetch.bind(self);
self.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return url.startsWith(HF) ? netFetch(`${self.location.origin}/vendor/speech/hf/${url.slice(HF.length)}`, init) : netFetch(input, init);
};

// One copy on disk: worca's ~/.worca-cc/speech-cache. transformers.js would also keep
// every model in the browser's Cache Storage (another ~500 MB); hand it a cache that
// never stores, and drop what earlier versions stored there. Loading from worca on
// localhost is about as fast.
const realCaches = self.caches;
if (realCaches) for (const name of ['transformers-cache', 'kokoro-voices']) realCaches.delete(name).catch(() => {});
const noCache = { match: async () => undefined, put: async () => {} };
Object.defineProperty(self, 'caches', { value: { open: async () => noCache, delete: async () => false, has: async () => false }, configurable: true });

// Per-file progress → one overall fraction for the composer chip.
const files = new Map();
function progress(p) {
  if (!p || p.status !== 'progress' || !p.file) return;
  files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
  let loaded = 0, total = 0;
  for (const f of files.values()) { loaded += f.loaded; total += f.total; }
  self.postMessage({ op: 'progress', loaded, total });
}

async function webgpu() {
  try { return !!(self.navigator.gpu && await self.navigator.gpu.requestAdapter()); } catch { return false; }
}

let engine = null;
function load() {
  engine ||= (async () => {
    if (KIND === 'stt') {
      const { pipeline, env } = await import(`${LIB}transformers.min.js`);
      env.allowLocalModels = false;
      env.backends.onnx.wasm.wasmPaths = LIB;
      env.backends.onnx.logLevel = 'error';        // not the per-session "nodes not assigned to the EP" warnings
      const gpu = await webgpu();
      return pipeline('automatic-speech-recognition', STT_MODEL, {
        device: gpu ? 'webgpu' : 'wasm',
        dtype: gpu ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
        progress_callback: progress,
      });
    }
    if (KIND === 'tts') return loadKokoro();
    throw new Error(`unknown speech engine ${KIND}`);
  })();
  engine.catch(() => { engine = null; });          // a failed load (offline, …) may be retried
  return engine;
}

// ── Kokoro: phonemes → StyleTTS2 model → 24 kHz audio (what kokoro-js does, minus eSpeak) ──
async function loadKokoro() {
  const { StyleTextToSpeech2Model, AutoTokenizer, Tensor, env } = await import(`${LIB}transformers.min.js`);
  const { createG2P } = await import(`${self.location.origin}/src/shared/speech-g2p.mjs`);
  env.allowLocalModels = false;
  env.backends.onnx.wasm.wasmPaths = LIB;
  env.backends.onnx.logLevel = 'error';
  // Measured: WebGPU needs fp32 (fp16 and q8 come out garbled there) and runs several
  // times faster than real time; WASM q8 is correct but only about real time.
  const gpu = await webgpu();
  const [model, tokenizer] = await Promise.all([
    StyleTextToSpeech2Model.from_pretrained(TTS_MODEL, { dtype: gpu ? 'fp32' : 'q8', device: gpu ? 'webgpu' : 'wasm', progress_callback: progress }),
    AutoTokenizer.from_pretrained(TTS_MODEL, { progress_callback: progress }),
  ]);
  const g2ps = new Map();                            // 'us' | 'gb' → G2P over that accent's dictionaries
  const voices = new Map();                          // voice → Float32Array of 510 × 256 style vectors
  const json = async (name) => { const r = await fetch(`${LIB}${name}`); if (!r.ok) throw new Error(`${name} did not load (${r.status})`); return r.json(); };
  async function g2pFor(accent) {
    if (!g2ps.has(accent)) {
      const dicts = [json(`${accent}_gold.json`), json(`${accent}_silver.json`)];
      if (accent === 'gb') dicts.push(json('us_gold.json'));      // words the British lexicon lacks
      g2ps.set(accent, Promise.all(dicts).then(([gold, silver, also]) => createG2P({ gold, silver, british: accent === 'gb', also })));
      g2ps.get(accent).catch(() => g2ps.delete(accent));
    }
    return g2ps.get(accent);
  }
  async function voiceData(name) {
    if (!voices.has(name)) {
      voices.set(name, fetch(`${HF}${TTS_MODEL}/resolve/main/voices/${name}.bin`).then(async (r) => {
        if (!r.ok) throw new Error(`voice ${name} not found`);
        return new Float32Array(await r.arrayBuffer());
      }));
      voices.get(name).catch(() => voices.delete(name));
    }
    return voices.get(name);
  }
  await Promise.all([g2pFor('us'), voiceData(TTS_DEFAULT_VOICE)]);   // the default voice is ready once load() resolves
  return {
    async speak(text, voice, speed) {
      let name = TTS_VOICE_RE.test(voice || '') ? voice : TTS_DEFAULT_VOICE;
      let style;
      try { style = await voiceData(name); } catch { name = TTS_DEFAULT_VOICE; style = await voiceData(name); }
      const phonemes = (await g2pFor(name[0] === 'b' ? 'gb' : 'us')).phonemize(text);
      if (!phonemes) return { audio: new Float32Array(0), rate: TTS_RATE };
      const { input_ids } = tokenizer(phonemes, { truncation: true });
      // One 256-wide style vector per input length (kokoro-js's generate_from_ids).
      const at = 256 * Math.min(Math.max(input_ids.dims.at(-1) - 2, 0), 509);
      const { waveform } = await model({
        input_ids,
        style: new Tensor('float32', style.slice(at, at + 256), [1, 256]),
        speed: new Tensor('float32', [Number(speed) || 1], [1]),
      });
      return { audio: waveform.data, rate: TTS_RATE };
    },
  };
}

async function run(msg) {
  const e = await load();
  if (msg.op === 'load') return {};
  if (msg.op === 'transcribe') {
    const lang = msg.language && msg.language !== 'auto' ? msg.language : null;
    const out = await e(msg.audio, { task: 'transcribe', chunk_length_s: 30, stride_length_s: 5, ...(lang ? { language: lang } : {}) });
    return { text: (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text) || '' };
  }
  if (msg.op === 'speak') {
    const { audio, rate } = await e.speak(msg.text, msg.voice, msg.speed);
    return { audio, rate, transfer: [audio.buffer] };
  }
  throw new Error(`unknown op ${msg.op}`);
}

// One job at a time: inference is CPU/GPU bound, and the controller already
// prefetches only a sentence or two ahead.
let chain = Promise.resolve();
self.onmessage = (ev) => {
  const msg = ev.data || {};
  chain = chain.then(() => run(msg)).then(
    ({ transfer, ...out }) => self.postMessage({ id: msg.id, ok: true, ...out }, transfer || []),
    (err) => self.postMessage({ id: msg.id, ok: false, error: err && err.message ? err.message : String(err) }),
  );
};
