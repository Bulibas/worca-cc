// test/deck-bundle-script.test.mjs — the deckBundle card's program, for real.
//
// Skipped when the host has no interpreter: the card is wired into the shipped
// Presentation workflow but build-standalone.mjs remains the fallback, so a
// python-less machine is a supported configuration, not a broken one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScriptExecution } from '../src/core/graph/script-runner.mjs';
import { loadScriptRegistry } from '../src/core/script-registry.mjs';
import { probePython } from '../src/core/graph/python-probe.mjs';

const REG = loadScriptRegistry({ userScriptsDir: null });
const META = REG.deckBundle;

// A deck whose inlined source CONTAINS a complete script tag pair, and an HTML
// comment that does too. Both are real: deck-stage.js:57 carries
// `<script src="deck-stage.js"></script>` in its header comment (inlining escapes
// its `</script` so the tag pair itself never survives as live markup — verified
// against docs/why-worca.standalone.html:942, which reads `<\/script>` there),
// and the kit's
// own bundler comments out the audio tag. A live-tag check that does not strip
// script bodies and HTML comments first reports a CORRECT bundle as broken.
const KIT_SRC = `/* usage:\n *   <script src="deck-stage.js"></script>\n */\nwindow.__kit = 1;\n`;

async function fixtureDeck() {
  const pdir = await mkdtemp(join(tmpdir(), 'worca-deckbundle-'));
  const deck = join(pdir, 'deck');
  await mkdir(deck, { recursive: true });
  await writeFile(join(deck, 'deck-stage.js'), KIT_SRC, 'utf8');
  await writeFile(join(deck, 'deck-enhance.js'), 'window.__enhance = 1;\n', 'utf8');
  // A 1x1 PNG the deck references, so the image branch is exercised.
  await writeFile(join(deck, 'logo.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  await writeFile(join(deck, 'deck.html'),
    '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><meta name="generator" content="OpenDeck 1.2.0">'
    + '<style>@font-face { font-family: X; src: url("logo.png"); }</style></head><body>\n'
    + '<!-- <script src="narration-audio.js"></script> -->\n'
    + '<deck-stage width="1920" height="1080"><section data-label="01"><h1>One</h1>'
    + '<img src="logo.png" alt="logo"></section></deck-stage>\n'
    + '<script src="deck-stage.js"></script>\n<script src="deck-enhance.js"></script>\n'
    + '</body></html>\n', 'utf8');
  return { pdir, deck };
}

function ctxFor(pdir) {
  const ports = { inputs: META.inputs, outputs: META.outputs };
  const outputs = {
    bundle: { path: join(pdir, 'deck-bundle-cycle1.md') },
    findings: { path: join(pdir, 'deck-bundle-cycle1.md') },
  };
  return {
    node: { id: 'n_bundle', kind: 'script', key: 'deckBundle' },
    ordinal: 1,
    ports,
    bindings: { built: { path: join(pdir, 'deck-manifest.md') } },
    outputs,
    verdict: { path: join(pdir, 'deck-bundle-cycle1.json') },
    pipelineDir: pdir,
    projectDir: pdir,
    script: { meta: META, runtime: META.runtime, file: META.scriptPath, params: {}, timeoutMs: 120000 },
    claudeOpts: {},
    onEvent: () => {},
  };
}

test('deckBundle inlines a deck into one file and reports it clean', async (t) => {
  const py = await probePython();
  if (!py.ok) return t.skip(`no python on this host: ${py.reason}`);

  const { pdir, deck } = await fixtureDeck();
  await writeFile(join(pdir, 'deck-manifest.md'), '# Deck manifest\nMode: live   Slides: 1\n', 'utf8');

  const res = await runScriptExecution(ctxFor(pdir));

  assert.deepEqual(res.verdict.issues, [], JSON.stringify(res.verdict));
  const out = await readFile(join(deck, 'deck.standalone.html'), 'utf8');
  assert.ok(out.includes('window.__kit = 1;'), 'deck-stage.js was not inlined');
  assert.ok(out.includes('window.__enhance = 1;'), 'deck-enhance.js was not inlined');
  assert.ok(out.includes('data:image/png;base64,'), 'the image was not embedded');
  assert.ok(!/<img[^>]+src=("|')logo\.png/.test(out), 'the img still points at a sibling');
});

// THE TRAP. The bundler leaves HTML comments untouched (a commented-out tag is
// not live and must not be substituted), so the audio comment's COMPLETE
// `<script src="…"></script>` pair survives verbatim in the output — exactly
// what happens in the real docs/why-worca standalone, which a naive whole-tag
// search matches exactly once, at that same commented-out audio tag. The check
// must strip HTML comments and inlined script bodies first, or the card blocks
// every successful run.
test('a correct bundle verifies clean even though its inlined source contains a full script tag', async (t) => {
  const py = await probePython();
  if (!py.ok) return t.skip(`no python on this host: ${py.reason}`);

  const { pdir, deck } = await fixtureDeck();
  await writeFile(join(pdir, 'deck-manifest.md'), '# Deck manifest\nMode: live   Slides: 1\n', 'utf8');
  const res = await runScriptExecution(ctxFor(pdir));

  const out = await readFile(join(deck, 'deck.standalone.html'), 'utf8');
  assert.ok(out.includes('<script src="narration-audio.js"></script>'),
    'the fixture no longer exercises the trap — the commented-out tag is gone');
  assert.deepEqual(res.verdict.issues, [], 'a correct bundle must not be reported as non-standalone');
});

test('a deck that still reaches for a sibling it cannot inline is a blocking finding', async (t) => {
  const py = await probePython();
  if (!py.ok) return t.skip(`no python on this host: ${py.reason}`);

  const { pdir, deck } = await fixtureDeck();
  await writeFile(join(pdir, 'deck-manifest.md'), '# Deck manifest\nMode: live   Slides: 1\n', 'utf8');
  // A CDN reference: remote, so it cannot be inlined, and it makes the result
  // non-standalone. This is the builder mistake the loop exists to send back.
  const html = await readFile(join(deck, 'deck.html'), 'utf8');
  await writeFile(join(deck, 'deck.html'),
    html.replace('</body>', '<script src="https://cdn.example.com/x.js"></script>\n</body>'), 'utf8');

  const res = await runScriptExecution(ctxFor(pdir));
  assert.ok(res.verdict.issues.length > 0, 'a remote script must block');
  assert.ok(res.verdict.issues.some((i) => /cdn\.example\.com/.test(i.detail || '')),
    JSON.stringify(res.verdict.issues));
});
