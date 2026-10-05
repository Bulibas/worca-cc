// test/deck-optional-outputs.test.mjs — the deckPdf and deckAudio cards, for real.
//
// Both are OPTIONAL and skip themselves from the deckOutputs answers, so each is proved in
// its three states: not requested (the default), requested-but-unavailable, requested-and-done.
// The ElevenLabs API is a local HTTP server (WORCA_DECK_ELEVENLABS_BASE) and Chrome is a
// script (WORCA_CHROME) — nothing here touches the network or needs a browser.
//
// Skipped when the host has no python: the cards are wired into the shipped Presentation
// workflow, and a python-less machine is a supported configuration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScriptExecution } from '../src/core/graph/script-runner.mjs';
import { loadScriptRegistry } from '../src/core/script-registry.mjs';
import { probePython } from '../src/core/graph/python-probe.mjs';
import { checkRows } from './helpers/rows.mjs';

const REG = loadScriptRegistry({ userScriptsDir: null });
const GEN = 'Generate narration audio (ElevenLabs)';
const KEY = 'sk-test-SECRET-1234567890';

const DECK = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<deck-stage width="1920" height="1080">
<section data-label="a"><h1>One</h1></section>
<section data-label="b"><h1>Two</h1></section>
<section data-label="c" data-deck-skip><h1>Skipped</h1></section>
</deck-stage>
<script type="application/json" id="speaker-notes">["Welcome to the deck.", "Here is the second point.", ""]</script>
<script src="deck-stage.js"></script>
</body></html>`;

async function fixture({ answers } = {}) {
  const pdir = await mkdtemp(join(tmpdir(), 'worca-deckopt-'));
  await mkdir(join(pdir, 'deck'), { recursive: true });
  await mkdir(join(pdir, 'deck-narration'), { recursive: true });
  await writeFile(join(pdir, 'deck', 'deck.html'), DECK, 'utf8');
  await writeFile(join(pdir, 'deck', 'deck-stage.js'), 'window.__stage = 1;\n', 'utf8');
  await writeFile(join(pdir, 'deck-narration', 'deck-narration.js'), 'window.__engine = 1;\n', 'utf8');
  await writeFile(join(pdir, 'deck-manifest.md'), '# Deck manifest\nMode: live   Slides: 2\n', 'utf8');
  if (answers !== undefined) await writeFile(join(pdir, 'deck-outputs.json'), JSON.stringify(answers), 'utf8');
  return pdir;
}

function ctxFor(key, pdir, { secretEnv } = {}) {
  const meta = REG[key];
  const bindings = { built: { path: join(pdir, 'deck-manifest.md') } };
  const report = join(pdir, `${key}-report.md`);
  return {
    node: { id: `n_${key}`, kind: 'script', key },
    ordinal: 1,
    ports: { inputs: meta.inputs, outputs: meta.outputs },
    bindings,
    outputs: { report: { path: report }, findings: { path: report } },
    verdict: { path: join(pdir, `${key}.json`) },
    pipelineDir: pdir,
    projectDir: pdir,
    runCtx: { pipelineDir: pdir, projectDir: pdir, secretEnv },
    script: { meta, runtime: meta.runtime, file: meta.scriptPath, params: {}, timeoutMs: 120000 },
    claudeOpts: {},
    onEvent: () => {},
  };
}

const values = (over) => ({ form: 'deck-outputs', version: 1, values: {
  deliverables: 'PDF + standalone HTML', audio: 'No audio', voiceId: '', apiKey: '', ...over } });

async function withPython(t) {
  const py = await probePython();
  if (!py.ok) { t.skip(`no python on this host: ${py.reason}`); return false; }
  return true;
}

/** A local stand-in for ElevenLabs: records the requests, answers with fake mp3 bytes. */
async function fakeElevenLabs({ status = 200 } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, key: req.headers['xi-api-key'], body: JSON.parse(body || '{}') });
      res.writeHead(status, { 'Content-Type': 'audio/mpeg' });
      res.end(status === 200 ? Buffer.from('FAKE-MP3-BYTES') : 'nope');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

async function everyFileUnder(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out.push(join(e.parentPath ?? e.path, e.name));
  }
  return out;
}

// ── deckAudio ────────────────────────────────────────────────────────────────

test('deckAudio: default and keyless requests skip without touching the deck', async (t) => {
  if (!(await withPython(t))) return;

  await checkRows([
    { name: 'deckAudio: the default is no audio, and it says so without touching the deck', run: async () => {
      const pdir = await fixture({ answers: values({}) });
      const res = await runScriptExecution(ctxFor('deckAudio', pdir));
      assert.deepEqual(res.verdict.issues, []);
      assert.match(res.verdict.summary, /skipped \(not requested\)/);
      assert.equal(await readFile(join(pdir, 'deck', 'deck.html'), 'utf8'), DECK);
      assert.ok(!(await readdir(join(pdir, 'deck'))).includes('narration-audio.js'));
    } },
    { name: 'deckAudio: requested but no key -> skipped, never a failure', run: async () => {
      const pdir = await fixture({ answers: values({ audio: GEN, voiceId: 'voice-1' }) });
      const saved = { a: process.env.ELEVENLABS_API_KEY, b: process.env.WORCA_DECK_ELEVENLABS_API_KEY };
      delete process.env.ELEVENLABS_API_KEY; delete process.env.WORCA_DECK_ELEVENLABS_API_KEY;
      try {
        const res = await runScriptExecution(ctxFor('deckAudio', pdir));
        assert.deepEqual(res.verdict.issues, []);
        assert.match(res.verdict.summary, /no key or voice/);
      } finally {
        if (saved.a !== undefined) process.env.ELEVENLABS_API_KEY = saved.a;
        if (saved.b !== undefined) process.env.WORCA_DECK_ELEVENLABS_API_KEY = saved.b;
      }
    } },
  ]);
});

test('deckAudio: requested with a key -> clips generated, files written, deck wired, key never on disk', async (t) => {
  if (!(await withPython(t))) return;
  const api = await fakeElevenLabs();
  const saved = { base: process.env.WORCA_DECK_ELEVENLABS_BASE, key: process.env.WORCA_DECK_ELEVENLABS_API_KEY };
  process.env.WORCA_DECK_ELEVENLABS_BASE = api.base;
  // The typed-key path: runCtx.secretEnv is merged into the child env by the script runner.
  const pdir = await fixture({ answers: values({ audio: GEN, voiceId: 'voice-1', apiKey: '[typed]' }) });
  try {
    const res = await runScriptExecution(ctxFor('deckAudio', pdir, { secretEnv: { WORCA_DECK_ELEVENLABS_API_KEY: KEY } }));
    assert.deepEqual(res.verdict.issues, [], JSON.stringify(res.verdict));
    // one request per non-empty note, sent to the chosen voice with the key in the header
    assert.equal(api.seen.length, 2);
    assert.match(api.seen[0].url, /^\/v1\/text-to-speech\/voice-1\?output_format=mp3_44100_128$/);
    assert.equal(api.seen[0].key, KEY);
    assert.equal(api.seen[0].body.text, 'Welcome to the deck.');
    assert.equal(api.seen[0].body.model_id, 'eleven_multilingual_v2');

    const audio = await readFile(join(pdir, 'deck', 'narration-audio.js'), 'utf8');
    assert.match(audio, /window\.__NARRATION_AUDIO = /);
    const clips = JSON.parse(audio.slice(audio.indexOf('{'), audio.lastIndexOf('}') + 1));
    assert.deepEqual(Object.keys(clips).sort(), ['0:0', '1:0'], 'cue keys are "slide:step", as the Studio writes them');
    assert.ok(clips['0:0'].startsWith('data:audio/mpeg;base64,'));
    const script = await readFile(join(pdir, 'deck', 'narration-script.js'), 'utf8');
    assert.match(script, /window\.__NARRATION = /);
    assert.match(script, /Here is the second point\./);
    assert.equal(await readFile(join(pdir, 'deck', 'deck-narration.js'), 'utf8'), 'window.__engine = 1;\n');

    const deck = await readFile(join(pdir, 'deck', 'deck.html'), 'utf8');
    for (const src of ['narration-script.js', 'narration-audio.js', 'deck-narration.js']) {
      assert.ok(deck.includes(`<script src="${src}"></script>`), `${src} is wired into the deck`);
    }
    assert.ok(deck.indexOf('narration-script.js') < deck.indexOf('deck-narration.js'), 'script before engine');

    // THE property: the key is in no file the run leaves behind — reports, verdict, envelope audit copy.
    for (const f of await everyFileUnder(pdir)) {
      assert.ok(!(await readFile(f, 'utf8').catch(() => '')).includes(KEY), `${f} must not contain the API key`);
    }
  } finally {
    await api.close();
    if (saved.base === undefined) delete process.env.WORCA_DECK_ELEVENLABS_BASE; else process.env.WORCA_DECK_ELEVENLABS_BASE = saved.base;
  }
});

test('deckAudio: running twice does not wire the scripts twice', async (t) => {
  if (!(await withPython(t))) return;
  const api = await fakeElevenLabs();
  const saved = process.env.WORCA_DECK_ELEVENLABS_BASE;
  process.env.WORCA_DECK_ELEVENLABS_BASE = api.base;
  const pdir = await fixture({ answers: values({ audio: GEN, voiceId: 'v' }) });
  try {
    const c = () => ctxFor('deckAudio', pdir, { secretEnv: { WORCA_DECK_ELEVENLABS_API_KEY: KEY } });
    await runScriptExecution(c());
    await runScriptExecution(c());
    const deck = await readFile(join(pdir, 'deck', 'deck.html'), 'utf8');
    assert.equal(deck.split('narration-audio.js').length - 1, 1);
  } finally {
    await api.close();
    if (saved === undefined) delete process.env.WORCA_DECK_ELEVENLABS_BASE; else process.env.WORCA_DECK_ELEVENLABS_BASE = saved;
  }
});

test('deckAudio: every clip failing is a blocking finding that does not echo the response body', async (t) => {
  if (!(await withPython(t))) return;
  const api = await fakeElevenLabs({ status: 401 });
  const saved = process.env.WORCA_DECK_ELEVENLABS_BASE;
  process.env.WORCA_DECK_ELEVENLABS_BASE = api.base;
  const pdir = await fixture({ answers: values({ audio: GEN, voiceId: 'v' }) });
  try {
    const res = await runScriptExecution(ctxFor('deckAudio', pdir, { secretEnv: { WORCA_DECK_ELEVENLABS_API_KEY: KEY } }));
    assert.equal(res.verdict.issues.length, 1);
    assert.equal(res.verdict.issues[0].severity, 'major');
    assert.match(res.verdict.issues[0].detail, /HTTP 401/);
    assert.ok(!(await readdir(join(pdir, 'deck'))).includes('narration-audio.js'), 'no half-written audio file');
  } finally {
    await api.close();
    if (saved === undefined) delete process.env.WORCA_DECK_ELEVENLABS_BASE; else process.env.WORCA_DECK_ELEVENLABS_BASE = saved;
  }
});

// ── deckPdf ──────────────────────────────────────────────────────────────────

/** A stand-in for Chrome: writes a "PDF" with N pages to whatever --print-to-pdf names. */
async function fakeChrome(pdir, pages) {
  const bin = join(pdir, 'fake-chrome.sh');
  const body = Array.from({ length: pages }, (_, i) => `<< /Type /Page /N ${i} >>`).join('\\n');
  await writeFile(bin, `#!/bin/sh
for a in "$@"; do case "$a" in --print-to-pdf=*) out="\${a#--print-to-pdf=}";; esac; done
printf '%%PDF-1.4\\n${body}\\n<< /Type /Pages >>\\n' > "$out"
`, 'utf8');
  await chmod(bin, 0o755);
  return bin;
}

async function withChrome(bin, fn) {
  const saved = process.env.WORCA_CHROME;
  process.env.WORCA_CHROME = bin;
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.WORCA_CHROME; else process.env.WORCA_CHROME = saved;
  }
}

test('deckPdf: default prints, deselected skips, a page-count mismatch blocks', async (t) => {
  if (!(await withPython(t))) return;

  await checkRows([
    { name: 'deckPdf: prints by default; deselected skips without invoking Chrome', run: async () => {
      await checkRows([
        { name: 'deckPdf: the PDF is the default — an absent answers file still prints one', run: async () => {
          const pdir = await fixture();
          const bin = await fakeChrome(pdir, 2);
          const res = await withChrome(bin, () => runScriptExecution(ctxFor('deckPdf', pdir)));
          assert.deepEqual(res.verdict.issues, [], JSON.stringify(res.verdict));
          assert.match(res.verdict.summary, /2 slide\(s\), 2 PDF page\(s\)/, 'the data-deck-skip slide is not counted');
          assert.ok((await readdir(join(pdir, 'deck'))).includes('deck.pdf'));
        } },
        { name: 'deckPdf: deselected -> skipped, and Chrome is never invoked', run: async () => {
          const pdir = await fixture({ answers: values({ deliverables: 'Standalone HTML only' }) });
          const res = await withChrome('/nonexistent/chrome', () => runScriptExecution(ctxFor('deckPdf', pdir)));
          assert.deepEqual(res.verdict.issues, []);
          assert.match(res.verdict.summary, /skipped \(not requested\)/);
          assert.ok(!(await readdir(join(pdir, 'deck'))).includes('deck.pdf'));
        } },
      ]);
    } },
    { name: 'deckPdf: a page-count mismatch is a blocking finding against the print CSS', run: async () => {
      const pdir = await fixture({ answers: values({}) });
      const bin = await fakeChrome(pdir, 5);
      const res = await withChrome(bin, () => runScriptExecution(ctxFor('deckPdf', pdir)));
      assert.equal(res.verdict.issues.length, 1);
      assert.equal(res.verdict.issues[0].severity, 'major');
      assert.match(res.verdict.issues[0].title, /5 page\(s\) for 2 slide\(s\)/);
    } },
  ]);
});
