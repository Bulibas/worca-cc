// test/deck-bundle-script.test.mjs — the deckBundle card's program, for real.
//
// Skipped when the host has no interpreter: the card is wired into the shipped
// Presentation workflow but build-standalone.mjs remains the fallback, so a
// python-less machine is a supported configuration, not a broken one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScriptExecution } from '../src/core/graph/script-runner.mjs';
import { loadScriptRegistry } from '../src/core/script-registry.mjs';
import { probePython } from '../src/core/graph/python-probe.mjs';
import { checkRows } from './helpers/rows.mjs';

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
    // An author-written INLINE script whose own payload (not an inlined FILE's
    // payload) contains a literal, unescaped script tag pair. Real: the actual
    // standalone's notes data block sits right before its audio comment. Without
    // stripping inlined script BODIES (not just files this program itself
    // inlines), this alone is a false live-ref.
    + '<script>window.NOTES = [\'usage: <script src=\\\'x.js\\\'></script>\'];</script>\n'
    + '<!-- <script src="narration-audio.js"></script> -->\n'
    + '<deck-stage width="1920" height="1080"><section data-label="01"><h1>One</h1>'
    // Attributes AFTER src, plus a sibling element right after the tag: this is
    // exactly what a prefix-only rewrite (return only up through the src value)
    // corrupts — everything from `alt` onward, including the tag's own `>`, is
    // discarded, and the following <p> gets swallowed as bogus <img> attributes.
    + '<img src="logo.png" alt="logo" class="mark"><p>after</p></section></deck-stage>\n'
    + '<script src="deck-stage.js"></script>\n<script src="deck-enhance.js"></script>\n'
    + '</body></html>\n', 'utf8');
  return { pdir, deck };
}

function ctxFor(pdir, { bindings } = {}) {
  const ports = { inputs: META.inputs, outputs: META.outputs };
  const outputs = {
    bundle: { path: join(pdir, 'deck-bundle-cycle1.md') },
    findings: { path: join(pdir, 'deck-bundle-cycle1.md') },
  };
  return {
    node: { id: 'n_bundle', kind: 'script', key: 'deckBundle' },
    ordinal: 1,
    ports,
    bindings: bindings === undefined ? { built: { path: join(pdir, 'deck-manifest.md') } } : bindings,
    outputs,
    verdict: { path: join(pdir, 'deck-bundle-cycle1.json') },
    pipelineDir: pdir,
    projectDir: pdir,
    script: { meta: META, runtime: META.runtime, file: META.scriptPath, params: {}, timeoutMs: 120000 },
    claudeOpts: {},
    onEvent: () => {},
  };
}

test('live references the bundle cannot inline are blocking findings (sibling, remote img, src+body, spaced src=, CSS url(), unbalanced <!--)', async (t) => {
  const py = await probePython();
  if (!py.ok) return t.skip(`no python on this host: ${py.reason}`);

  await checkRows([
    { name: 'a deck that still reaches for a sibling it cannot inline is a blocking finding', run: async () => {
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
    } },
    // ── I1 ────────────────────────────────────────────────────────────────────────
    // A remote <img src> was inlined by nobody and reported by nobody: the image
    // branch returned early on is_remote WITHOUT recording it, and the live-reference
    // sweep only ever looked at scripts and stylesheets. The deliverable kept the live
    // CDN URL and the verdict was []. A remote image is the most likely CDN reach a
    // deck makes, and CONTRACT bans CDNs because they fail SILENTLY under the artifact
    // CSP — a silently-broken image in a file certified self-contained.
    { name: 'a remote <img src> is a blocking finding, not a silent CDN reach', run: async () => {
      const { pdir, deck } = await fixtureDeck();
      await writeFile(join(pdir, 'deck-manifest.md'), '# Deck manifest\nMode: live   Slides: 1\n', 'utf8');
      const html = await readFile(join(deck, 'deck.html'), 'utf8');
      await writeFile(join(deck, 'deck.html'),
        html.replace('<p>after</p>', '<img src="https://cdn.example.com/a.png" alt="remote"><p>after</p>'), 'utf8');

      const res = await runScriptExecution(ctxFor(pdir));
      assert.ok(res.verdict.issues.some((i) => /cdn\.example\.com\/a\.png/.test(i.detail || '')),
        `a remote image must be reported: ${JSON.stringify(res.verdict.issues)}`);
      const out = await readFile(join(deck, 'deck.standalone.html'), 'utf8');
      assert.ok(out.includes('https://cdn.example.com/a.png'),
        'the remote URL is left as written — it is reported, not rewritten');
    } },
    // ── I2 ────────────────────────────────────────────────────────────────────────
    // `<script src="a.js">body</script>` matched NEITHER pattern: SCRIPT_TAG (so it
    // was never inlined) nor the old LIVE_SCRIPT, whose `>\s*</script` body required
    // the tag to be empty. The file it points at exists here on purpose, so the
    // `missing` branch cannot be what reports it — only the live-reference sweep can,
    // and before the fix it did not: 0 findings, with a live sibling reference.
    { name: 'a <script src> that also carries a body is still reported as live', run: async () => {
      const { pdir, deck } = await fixtureDeck();
      await writeFile(join(pdir, 'deck-manifest.md'), '# Deck manifest\nMode: live   Slides: 1\n', 'utf8');
      await writeFile(join(deck, 'present.js'), 'window.__present = 1;\n', 'utf8');
      const html = await readFile(join(deck, 'deck.html'), 'utf8');
      await writeFile(join(deck, 'deck.html'), html.replace('</body>',
        '<script src="present.js">console.log("ignored by every browser");</script>\n</body>'), 'utf8');

      const res = await runScriptExecution(ctxFor(pdir));
      assert.ok(res.verdict.issues.some((i) => /still reaches for a sibling/i.test(i.title || '')),
        `a src-plus-body script is a live reference: ${JSON.stringify(res.verdict.issues)}`);
    } },
    // ROUND 3, F3. INLINED_SCRIPT's lookahead was `\ssrc=` with no `\s*`, alone among
    // this file's matchers. `<script src = "a.js">…</script>` failed it, so BARE_TOKEN
    // mistook a LIVE external script for an inlined one and erased it to
    // `<script></script>` before live_refs ever looked — and SCRIPT_TAG misses it too
    // (non-empty body), so there was no `missing` finding either. A bundle still
    // fetching a sibling file was certified self-contained: the one verdict the
    // self-check exists to prevent.
    { name: 'a live script with spaces around src= is caught, not erased', run: async () => {
      const { pdir, deck } = await fixtureDeck();
      let html = await readFile(join(deck, 'deck.html'), 'utf8');
      html = html.replace('</body>', '<script src = "gone.js">console.log(1)</script>\n</body>');
      await writeFile(join(deck, 'deck.html'), html, 'utf8');

      const res = await runScriptExecution(ctxFor(pdir));
      const blocking = res.verdict.issues.filter((i) => ['critical', 'major'].includes(i.severity));
      assert.ok(blocking.length > 0, 'a live external script was certified self-contained');
    } },
    // A url() IN CSS IS A LIVE REFERENCE LIKE ANY OTHER. inline_css_urls reported
    // only `escaped`: a remote url() returned early with nothing recorded, and a
    // local one whose file is absent was swallowed by `except OSError`. Nothing else
    // caught either — the live-reference sweep only ever inspects <script src> and
    // <link rel=stylesheet> — so a deck that still fetched its webfont from a CDN and
    // its artwork from a file that is not there was certified SELF-CONTAINED. The
    // docstring defended the silence as unable to "hide a real missing script or
    // image"; `background: url(hero.png)` is exactly a real missing image.
    { name: 'a CSS url() that is remote, or missing, blocks the bundle', run: async () => {
      const { pdir, deck } = await fixtureDeck();
      let html = await readFile(join(deck, 'deck.html'), 'utf8');
      html = html.replace('<style>', '<style>@font-face{font-family:Y;src:url("https://fonts.gstatic.com/p.woff2")}'
        + ' .hero{background:url("missing-hero.png")}');
      await writeFile(join(deck, 'deck.html'), html, 'utf8');

      const res = await runScriptExecution(ctxFor(pdir));
      const details = res.verdict.issues.map((i) => i.detail).join('\n');
      assert.match(details, /fonts\.gstatic\.com/, 'a CDN webfont was certified self-contained');
      assert.match(details, /missing-hero\.png/, 'a missing background image was certified self-contained');
    } },
    // ── M6 ───────────────────────────────────────────────────────────────────────
    // The self-check strips HTML comments AND inlined script bodies; doing it as two
    // sequential substitutions is wrong in either order. Comments first: an inlined
    // payload's unbalanced `<!--` (deck-export.js carries `<!--` tokens today) eats
    // forward to the next real `-->` and swallows whatever sits between — here a
    // genuinely live reference, which then goes unreported.
    { name: 'an inlined payload containing an unbalanced <!-- cannot hide a live reference', run: async () => {
      const { pdir, deck } = await fixtureDeck();
      await writeFile(join(pdir, 'deck-manifest.md'), '# Deck manifest\nMode: live   Slides: 1\n', 'utf8');
      await writeFile(join(deck, 'odd.js'), 'var opener = "<!--";\n', 'utf8');
      await writeFile(join(deck, 'present.js'), 'window.__present = 1;\n', 'utf8');
      const html = await readFile(join(deck, 'deck.html'), 'utf8');
      await writeFile(join(deck, 'deck.html'), html.replace('</body>',
        '<script src="odd.js"></script>\n'
        + '<script src="present.js">console.log("live");</script>\n'
        + '<!-- a later, perfectly ordinary comment -->\n</body>'), 'utf8');

      const res = await runScriptExecution(ctxFor(pdir));
      const out = await readFile(join(deck, 'deck.standalone.html'), 'utf8');
      assert.ok(out.includes('var opener = "<!--"'), 'the fixture no longer carries the unbalanced token');
      assert.ok(res.verdict.issues.some((i) => /still reaches for a sibling/i.test(i.title || '')),
        `the live reference between the two tokens was swallowed: ${JSON.stringify(res.verdict.issues)}`);
    } },
  ]);
});

// ── I3 ────────────────────────────────────────────────────────────────────────
// SECURITY. The card runs unsandboxed with worca's privileges over markup an LLM
// wrote from user-supplied material, and its product is meant to be SENT to
// people. Stripping a leading `/` normalises nothing, so `../` walked out of the
// deck folder and base64-embedded any readable file into the deliverable — with
// zero findings. Every path the program resolves is confined: script, stylesheet,
// media and CSS url() alike.
test('a reference that walks out of the deck folder is reported and never embedded', async (t) => {
  const py = await probePython();
  if (!py.ok) return t.skip(`no python on this host: ${py.reason}`);

  const { pdir, deck } = await fixtureDeck();
  await writeFile(join(pdir, 'deck-manifest.md'), '# Deck manifest\nMode: live   Slides: 1\n', 'utf8');
  await writeFile(join(pdir, 'outside-secret.js'), 'window.__SECRET = "EXFILTRATED-JS";\n', 'utf8');
  await writeFile(join(pdir, 'outside-secret.css'), '.x { content: "EXFILTRATED-CSS" }\n', 'utf8');
  await writeFile(join(pdir, 'outside-secret.woff2'), 'EXFILTRATED-FONT', 'utf8');
  const html = await readFile(join(deck, 'deck.html'), 'utf8');
  await writeFile(join(deck, 'deck.html'), html
    .replace('</head>', '<link rel="stylesheet" href="../outside-secret.css">'
      + '<style>@font-face { font-family: Y; src: url("../outside-secret.woff2"); }</style></head>')
    .replace('</body>', '<script src="../outside-secret.js"></script>\n</body>'), 'utf8');

  const res = await runScriptExecution(ctxFor(pdir));
  const details = res.verdict.issues.map((i) => `${i.severity}|${i.title}|${i.detail}`).join('\n');
  for (const ref of ['../outside-secret.js', '../outside-secret.css', '../outside-secret.woff2']) {
    assert.ok(res.verdict.issues.some((i) => i.severity === 'major' && (i.detail || '').includes(ref)),
      `${ref} escapes deck/ and must be a major finding: ${details}`);
  }
  const out = await readFile(join(deck, 'deck.standalone.html'), 'utf8');
  for (const secret of ['EXFILTRATED-JS', 'EXFILTRATED-CSS',
    Buffer.from('EXFILTRATED-FONT', 'utf8').toString('base64')]) {
    assert.ok(!out.includes(secret), `the bundle embedded a file from outside deck/: ${secret}`);
  }
});

test('deckBundle: clean bundles (inlining, spellings, MIME, data: refs, manifest summary) verify clean', async (t) => {
  const py = await probePython();
  if (!py.ok) return t.skip(`no python on this host: ${py.reason}`);

  await checkRows([
    { name: 'deckBundle inlines a deck into one file and verifies clean despite a full script tag in inlined source', run: async () => {
      // One fixture, one bundle run: both rows read the same verdict and output.
      const { pdir, deck } = await fixtureDeck();
      await writeFile(join(pdir, 'deck-manifest.md'), '# Deck manifest\nMode: live   Slides: 1\n', 'utf8');
      const res = await runScriptExecution(ctxFor(pdir));
      const out = await readFile(join(deck, 'deck.standalone.html'), 'utf8');

      await checkRows([
        { name: 'deckBundle inlines a deck into one file and reports it clean', run: () => {
          assert.deepEqual(res.verdict.issues, [], JSON.stringify(res.verdict));
          assert.ok(out.includes('window.__kit = 1;'), 'deck-stage.js was not inlined');
          assert.ok(out.includes('window.__enhance = 1;'), 'deck-enhance.js was not inlined');
          assert.ok(out.includes('data:image/png;base64,'), 'the image was not embedded');
          assert.ok(!/<img[^>]+src=("|')logo\.png/.test(out), 'the img still points at a sibling');
          // The embedded <img> must still be a well-formed, TERMINATED tag: everything
          // after `src` — here `alt` and `class`, and the tag's own closing `>` — has
          // to survive, or the next sibling element gets swallowed as bogus attributes.
          assert.match(out, /<img src="data:image\/png;base64,[^"]*" alt="logo" class="mark">/,
            'the img tag was truncated — attributes after src (or the closing ">") were dropped');
          assert.ok(out.includes('<p>after</p>'), 'the sibling element after <img> was swallowed');
        } },
        // THE TRAP. The bundler leaves HTML comments untouched (a commented-out tag is
        // not live and must not be substituted), so the audio comment's COMPLETE
        // `<script src="…"></script>` pair survives verbatim in the output — exactly
        // what happens in the real docs/why-worca standalone, which a naive whole-tag
        // search matches exactly once, at that same commented-out audio tag. The check
        // must strip HTML comments and inlined script bodies first, or the card blocks
        // every successful run.
        { name: 'a correct bundle verifies clean even though its inlined source contains a full script tag', run: () => {
          assert.ok(out.includes('<script src="narration-audio.js"></script>'),
            'the fixture no longer exercises the trap — the commented-out tag is gone');
          assert.deepEqual(res.verdict.issues, [], 'a correct bundle must not be reported as non-standalone');
        } },
      ]);
    } },
    { name: 'self-contained data: refs and quoted links inside CSS never block', run: async () => {
      await checkRows([
        // M6: a data: src/href is already self-contained. swap_script and swap_sheet
        // already exempt it from `remote`; the live-ref self-check must agree, or a
        // deck that legitimately carries a tiny inline script/stylesheet as a data:
        // URI blocks on a "live reference" to nothing.
        { name: 'a data: script src and stylesheet href are already self-contained and never block', run: async () => {
          const { pdir, deck } = await fixtureDeck();
          await writeFile(join(pdir, 'deck-manifest.md'), '# Deck manifest\nMode: live   Slides: 1\n', 'utf8');
          const html = await readFile(join(deck, 'deck.html'), 'utf8');
          await writeFile(join(deck, 'deck.html'), html.replace('</body>',
            '<script src="data:text/javascript,window.__data=1;"></script>\n'
            + '<link rel="stylesheet" href="data:text/css,body{color:red}">\n</body>'), 'utf8');

          const res = await runScriptExecution(ctxFor(pdir));
          assert.deepEqual(res.verdict.issues, [], JSON.stringify(res.verdict));
        } },
        // ROUND 3, F6. handle_link turns every local sheet into `<style>…css…</style>`,
        // and live_sheets then ran LINK_TAG over that CSS as if it were markup. A
        // stylesheet carrying a usage header that quotes its own <link> — the idiom that
        // is exactly why script bodies are opaque to this sweep — surfaced as a blocking
        // "the bundle still reaches for a sibling file" on a perfectly self-contained
        // deck. is_live() cannot rescue it: the href WAS inlined, so it is in none of
        // remote/missing/escaped.
        { name: 'a link quoted inside a stylesheet is not a live reference', run: async () => {
          const { pdir, deck } = await fixtureDeck();
          await writeFile(join(deck, 'theme.css'),
            '/* usage: <link rel="stylesheet" href="theme.css"> */\n.ok{color:red}\n', 'utf8');
          let html = await readFile(join(deck, 'deck.html'), 'utf8');
          html = html.replace('<style>', '<link rel="stylesheet" href="theme.css"><style>');
          await writeFile(join(deck, 'deck.html'), html, 'utf8');

          const res = await runScriptExecution(ctxFor(pdir));
          const out = await readFile(join(deck, 'deck.standalone.html'), 'utf8');
          assert.match(out, /\.ok\{color:red\}/, 'the sheet was not inlined');
          assert.deepEqual(res.verdict.issues, [], JSON.stringify(res.verdict));
        } },
      ]);
    } },
    { name: 'local references inline however spelled, with stylesheet-relative url() and real MIME types', run: async () => {
      await checkRows([
        // A relative path that stays inside the folder is NOT an escape — the check has to
        // resolve `..`, not ban it, or a deck that reaches into its own subfolder breaks.
        { name: 'a relative reference that stays inside the deck folder still inlines', run: async () => {
          const { pdir, deck } = await fixtureDeck();
          await writeFile(join(pdir, 'deck-manifest.md'), '# Deck manifest\nMode: live   Slides: 1\n', 'utf8');
          await mkdir(join(deck, 'vendor'), { recursive: true });
          await writeFile(join(deck, 'vendor', 'in.js'), 'window.__inside = 1;\n', 'utf8');
          const html = await readFile(join(deck, 'deck.html'), 'utf8');
          await writeFile(join(deck, 'deck.html'), html.replace('</body>',
            '<script src="vendor/../vendor/in.js"></script>\n</body>'), 'utf8');

          const res = await runScriptExecution(ctxFor(pdir));
          assert.deepEqual(res.verdict.issues, [], JSON.stringify(res.verdict.issues));
          const out = await readFile(join(deck, 'deck.standalone.html'), 'utf8');
          assert.ok(out.includes('window.__inside = 1;'), 'an in-folder `..` hop was refused');
        } },
        // ── I4 ────────────────────────────────────────────────────────────────────────
        // build-standalone.mjs:274-278 records the unquoted form as a shipped bug that
        // "slipped through with NO log line", and :68-78 special-cases the narration audio
        // by hand. This program's header claims to mirror those gotchas; `<img src=x.png>`
        // and a local <audio>/<video>/<source> were neither inlined nor reported, so a
        // narrated deck's audio was dropped from a file called self-contained.
        { name: 'an unquoted <img src> and local audio/video sources are inlined', run: async () => {
          const { pdir, deck } = await fixtureDeck();
          await writeFile(join(pdir, 'deck-manifest.md'), '# Deck manifest\nMode: live   Slides: 1\n', 'utf8');
          await writeFile(join(deck, 'tone.mp3'), 'ID3-TONE-BYTES', 'utf8');
          await writeFile(join(deck, 'clip.mp4'), 'FTYP-CLIP-BYTES', 'utf8');
          const html = await readFile(join(deck, 'deck.html'), 'utf8');
          await writeFile(join(deck, 'deck.html'), html
            // Unquoted, with an attribute after it: the value ends at whitespace, and
            // everything after `src` (including the tag's own `>`) has to survive.
            .replace('<img src="logo.png" alt="logo" class="mark">', '<img src=logo.png alt="logo" class="mark">')
            .replace('</body>', '<audio src="tone.mp3" controls></audio>\n'
              + '<video controls><source src=\'clip.mp4\' type="video/mp4"></video>\n</body>'), 'utf8');

          const res = await runScriptExecution(ctxFor(pdir));
          assert.deepEqual(res.verdict.issues, [], JSON.stringify(res.verdict.issues));
          const out = await readFile(join(deck, 'deck.standalone.html'), 'utf8');
          assert.match(out, /<img src="data:image\/png;base64,[^"]*" alt="logo" class="mark">/,
            'an unquoted <img src> was not inlined (or the tag was truncated)');
          assert.ok(out.includes(`data:audio/mpeg;base64,${Buffer.from('ID3-TONE-BYTES').toString('base64')}`),
            'a local <audio src> was not inlined');
          assert.ok(out.includes(`data:video/mp4;base64,${Buffer.from('FTYP-CLIP-BYTES').toString('base64')}`),
            'a <source src> inside <video> was not inlined');
          assert.ok(out.includes('controls></audio>'), 'the <audio> tag lost its later attributes');
        } },
        // ROUND 2, N3. SHEET_TAG demanded `href="…"` exactly, while SCRIPT_TAG,
        // MEDIA_SRC, HREF_ATTR and REL_ATTR all accept unquoted values and whitespace
        // around `=`. That was not a stricter policy, just a gap: the link was left
        // verbatim and then surfaced as the generic blocking "the bundle still reaches
        // for a sibling file", with no actionable detail, on a correct deck.
        { name: 'a stylesheet link is inlined however its href is spelled', run: async () => {
          const { pdir, deck } = await fixtureDeck();
          await writeFile(join(deck, 'theme.css'), '.from-sheet{color:rebeccapurple}', 'utf8');
          let html = await readFile(join(deck, 'deck.html'), 'utf8');
          html = html.replace('<style>', '<link rel=stylesheet href=theme.css><style>');
          await writeFile(join(deck, 'deck.html'), html, 'utf8');

          const res = await runScriptExecution(ctxFor(pdir));
          const out = await readFile(join(deck, 'deck.standalone.html'), 'utf8');
          assert.match(out, /\.from-sheet/, 'the unquoted-href stylesheet was not inlined');
          assert.doesNotMatch(out, /<link[^>]*theme\.css/i, 'a dead <link> survived');
          assert.deepEqual(res.verdict.issues, [], JSON.stringify(res.verdict));
        } },
        // A url() IN A LINKED SHEET IS RELATIVE TO THE SHEET, NOT TO THE DOCUMENT.
        // `inline_css_urls(css, base_dir, …)` was handed deck_dir for external sheets, so
        // `<link href="css/theme.css">` carrying `url("fonts/I.woff2")` resolved to
        // deck/fonts/ and missed the file — which, before the fix above, was swallowed in
        // silence and shipped an unembedded font. The same conflation turned
        // `url("../img/a.png")` — a correct reference to deck/img/a.png — into a BLOCKING
        // "outside its own folder" finding, sending a good deck back into the fix loop.
        // The deck folder stays the confinement root, which is what keeps both true.
        // build-standalone.mjs has resolved against the sheet's own folder all along.
        { name: 'a linked stylesheet resolves its url() refs against its own folder', run: async () => {
          const { pdir, deck } = await fixtureDeck();
          await mkdir(join(deck, 'css', 'fonts'), { recursive: true });
          await mkdir(join(deck, 'img'), { recursive: true });
          await writeFile(join(deck, 'css', 'fonts', 'I.woff2'), 'woff2-bytes');
          await writeFile(join(deck, 'img', 'a.png'), 'png-bytes');
          await writeFile(join(deck, 'css', 'theme.css'),
            '@font-face{font-family:I;src:url("fonts/I.woff2")}\nbody{background:url("../img/a.png")}\n', 'utf8');
          let html = await readFile(join(deck, 'deck.html'), 'utf8');
          html = html.replace('<style>', '<link rel="stylesheet" href="css/theme.css"><style>');
          await writeFile(join(deck, 'deck.html'), html, 'utf8');

          const res = await runScriptExecution(ctxFor(pdir));
          const out = await readFile(join(deck, 'deck.standalone.html'), 'utf8');

          assert.ok(out.includes(Buffer.from('woff2-bytes').toString('base64')),
            'the sheet\'s own-folder webfont was not embedded');
          assert.ok(out.includes(Buffer.from('png-bytes').toString('base64')),
            'a ../ reference that stays inside deck/ was not embedded');
          assert.deepEqual(res.verdict.issues, [], JSON.stringify(res.verdict));
        } },
        // ROUND 2, N2. MEDIA_SRC matches img|audio|video|source, but the MIME table
        // listed only mp3/mp4 — so an .m4a, .wav, .ogg, .webm or .avif was embedded as
        // application/octet-stream, which no browser plays or paints, while the card
        // certified the bundle self-contained: an unknown extension is not a `missing`,
        // `remote` or `escaped` finding anywhere. build-standalone.mjs and deck-export.js
        // carry the same table and must agree with it.
        { name: 'every media type the matcher reaches gets a real MIME type', run: async () => {
          const { pdir, deck } = await fixtureDeck();
          const media = { 'a.m4a': 'audio/mp4', 'a.wav': 'audio/wav', 'a.ogg': 'audio/ogg',
            'v.webm': 'video/webm', 'i.avif': 'image/avif' };
          for (const name of Object.keys(media)) await writeFile(join(deck, name), `bytes-of-${name}`);
          let html = await readFile(join(deck, 'deck.html'), 'utf8');
          html = html.replace('<h1>One</h1>', '<h1>One</h1>'
            + '<audio src="a.m4a"></audio><audio src="a.wav"></audio><audio src="a.ogg"></audio>'
            + '<video><source src="v.webm"></video><img src="i.avif">');
          await writeFile(join(deck, 'deck.html'), html, 'utf8');

          const res = await runScriptExecution(ctxFor(pdir));
          const out = await readFile(join(deck, 'deck.standalone.html'), 'utf8');
          for (const [name, mime] of Object.entries(media)) {
            assert.ok(out.includes(`data:${mime};base64,`), `${name} was not embedded as ${mime}`);
          }
          assert.ok(!out.includes('application/octet-stream'), 'a media file fell back to octet-stream');
          assert.deepEqual(res.verdict.issues, [], JSON.stringify(res.verdict));
        } },
      ]);
    } },
    { name: 'the manifest slide count reaches the summary; a useless manifest never fails the card', run: async () => {
      await checkRows([
        // ── M3 ───────────────────────────────────────────────────────────────────────
        // The card declared and the graph wired a `built` input the program never read.
        // The manifest's one useful fact here is the slide count: it belongs in the
        // summary a human reads beside the byte count, never in a gate.
        { name: 'the slide count from the bound manifest reaches the summary', run: async () => {
          const { pdir } = await fixtureDeck();
          await writeFile(join(pdir, 'deck-manifest.md'),
            '# Deck manifest\nMode: both   Slides: 14   Kit: 1.2.0\n', 'utf8');

          const res = await runScriptExecution(ctxFor(pdir));
          assert.deepEqual(res.verdict.issues, [], JSON.stringify(res.verdict.issues));
          assert.match(res.summary, /14 slide\(s\)/, `the manifest slide count is missing: ${res.summary}`);
        } },
        // …and every way that input can be useless is a missing slide count, not a failed
        // card: an unbound port, a file that is not there, prose that says nothing.
        { name: 'an unbound, absent or unparseable manifest never fails the card', run: async () => {
          for (const variant of ['unbound', 'absent', 'unparseable']) {
            const { pdir } = await fixtureDeck();
            if (variant === 'unparseable') {
              await writeFile(join(pdir, 'deck-manifest.md'), 'nothing about slides here\n', 'utf8');
            }
            const res = await runScriptExecution(ctxFor(pdir, variant === 'unbound' ? { bindings: {} } : {}));
            assert.deepEqual(res.verdict.issues, [], `${variant}: ${JSON.stringify(res.verdict.issues)}`);
            assert.match(res.summary, /self-contained/, `${variant}: ${res.summary}`);
            assert.doesNotMatch(res.summary, /slide\(s\)/, `${variant}: invented a slide count`);
          }
        } },
      ]);
    } },
  ]);
});

// ── M7 ───────────────────────────────────────────────────────────────────────
// The export agent runs this same verification in prose, over the same file, and
// its gate was the weaker of the two: `rel=("|')?stylesheet` is blind to
// `rel="preload stylesheet"`, and its script pattern required both quotes and an
// EMPTY tag. A deliverable escapes through whichever gate is weaker, so run the
// agent's OWN snippet here and hold it to the card's answer.
test("the export agent's prose gate agrees with the card on the same file", async (t) => {
  const py = await probePython();
  if (!py.ok) return t.skip(`no python on this host: ${py.reason}`);

  const agent = await readFile(new URL('../agents/worca-cc-deck-export.md', import.meta.url), 'utf8');
  const m = /python3 - "\$PWD\/deck\/deck\.standalone\.html" <<'PY'\n([\s\S]*?)\nPY\n/.exec(agent);
  assert.ok(m, 'the export agent no longer carries a python verification heredoc to check');
  // `-c CODE file` puts the file at sys.argv[1], exactly as `python3 - file` does.
  const gate = (file) => spawnSync(py.command[0], [...py.command.slice(1), '-c', m[1], file], { encoding: 'utf8' });

  const clean = await fixtureDeck();
  await writeFile(join(clean.pdir, 'deck-manifest.md'), '# Deck manifest\nMode: live   Slides: 1\n', 'utf8');
  const cleanRes = await runScriptExecution(ctxFor(clean.pdir));
  const cleanGate = gate(join(clean.deck, 'deck.standalone.html'));
  assert.deepEqual(cleanRes.verdict.issues, [], JSON.stringify(cleanRes.verdict.issues));
  assert.equal(cleanGate.status, 0, `the agent's gate fails a bundle the card passes: ${cleanGate.stdout}${cleanGate.stderr}`);
  assert.match(cleanGate.stdout, /live scripts: 0 live stylesheets: 0/);

  const dirty = await fixtureDeck();
  await writeFile(join(dirty.pdir, 'deck-manifest.md'), '# Deck manifest\nMode: live   Slides: 1\n', 'utf8');
  await writeFile(join(dirty.deck, 'present.js'), 'window.__present = 1;\n', 'utf8');
  const html = await readFile(join(dirty.deck, 'deck.html'), 'utf8');
  await writeFile(join(dirty.deck, 'deck.html'), html
    // Both shapes the old prose gate waved through: a multi-value rel, and a src
    // tag that carries a body (which every browser ignores in favour of the src).
    .replace('</head>', '<link rel="preload stylesheet" href="https://cdn.example.com/f.css"></head>')
    .replace('</body>', '<script src=present.js>console.log("live");</script>\n</body>'), 'utf8');

  const dirtyRes = await runScriptExecution(ctxFor(dirty.pdir));
  const dirtyGate = gate(join(dirty.deck, 'deck.standalone.html'));
  assert.ok(dirtyRes.verdict.issues.length > 0, 'the card must block this deck');
  assert.equal(dirtyGate.status, 1, `the agent's gate passed a deck the card blocks: ${dirtyGate.stdout}${dirtyGate.stderr}`);
  assert.match(dirtyGate.stdout, /live scripts: 1 live stylesheets: 1/,
    `the agent's gate must see both: ${dirtyGate.stdout}`);
});
