// build-standalone.mjs is the headless bundler the deckExport agent actually
// runs, and its output is the leave-behind a human is emailed.
//
// `embedCssUrls` existed but was only ever called on `<link rel=stylesheet>`
// content — never on the deck's own inline `<style>` block, which CONTRACT.md
// MANDATES ("Styles in one `<style>` block … `@font-face` files copied into
// `deck/`"). Verified against a real run's deck: all five @font-face URLs
// survived the bundle as relative paths, so the "standalone" rendered correctly
// only while it sat next to deck/ and lost every face the moment it was sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRows } from './helpers/rows.mjs';

const run = promisify(execFile);
const KIT = fileURLToPath(new URL('../assets/deck-kit/', import.meta.url));

/** A deck in the shape the contract prescribes: one inline <style>, a local
 *  @font-face, a local background image, and the kit scripts beside it. */
async function deckDir() {
  const dir = await mkdtemp(join(tmpdir(), 'worca-standalone-'));
  for (const f of ['deck-stage.js', 'deck-enhance.js', 'deck-export.js', 'build-standalone.mjs']) {
    await cp(join(KIT, f), join(dir, f));
  }
  await writeFile(join(dir, 'brand.woff2'), Buffer.from('woff2-bytes-here'));
  await writeFile(join(dir, 'grain.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  await writeFile(join(dir, 'deck.html'), `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="generator" content="OpenDeck 1.1.0"><title>D</title>
<style>
  @font-face { font-family:Brand; src:url('brand.woff2') format('woff2'); }
  section { font-family:Brand, system-ui; background-image:url("grain.png"); }
</style></head><body>
<deck-stage width="1920" height="1080">
  <section data-label="01"><h1>One</h1></section>
</deck-stage>
<script src="deck-stage.js"></script>
<script src="deck-enhance.js"></script>
<script src="deck-export.js"></script>
</body></html>
`, 'utf8');
  return dir;
}

test('build-standalone: CSS url() embedding (inline/uppercase/two-format/linked/quoted) never touches inlined JS', async () => {
  await checkRows([
    { name: 'the bundler embeds url() assets from the deck\'s own inline <style>', run: async () => {
      const dir = await deckDir();
      try {
        await run('node', [join(dir, 'build-standalone.mjs'), join(dir, 'deck.html'), '--out', join(dir, 'out.html')]);
        const out = await readFile(join(dir, 'out.html'), 'utf8');

        assert.doesNotMatch(out, /url\(\s*['"]?brand\.woff2/, 'the webfont is still a relative path');
        assert.doesNotMatch(out, /url\(\s*['"]?grain\.png/, 'the background image is still a relative path');
        assert.match(out, /data:font\/woff2;base64,/, 'the font is embedded');
        assert.match(out, /data:image\/png;base64,/, 'the image is embedded');
        // The same shape the golden run asserts. NOT a bare `deck-stage.js` search:
        // the inlined kit's own JSDoc contains that literal in a usage example.
        assert.doesNotMatch(out, /<script src="[^"]+\.js"><\/script>/, 'and the kit is still inlined');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } },
    // The block matcher is case-insensitive but the split used a case-SENSITIVE
    // lastIndexOf('</style>'), so an uppercase block yielded -1 and the rewrite
    // emitted a duplicated, malformed close tag.
    { name: 'an uppercase STYLE block survives url() embedding intact', run: async () => {
      const dir = await deckDir();
      try {
        let html = await readFile(join(dir, 'deck.html'), 'utf8');
        html = html.replace('</head>', '<STYLE>body { background-image:url("grain.png"); }</STYLE>\n</head>');
        await writeFile(join(dir, 'deck.html'), html, 'utf8');

        await run('node', [join(dir, 'build-standalone.mjs'), join(dir, 'deck.html'), '--out', join(dir, 'out.html')]);
        const out = await readFile(join(dir, 'out.html'), 'utf8');

        assert.doesNotMatch(out, /<\/STYLE\s*<\/style>/i, 'no duplicated close tag');
        assert.doesNotMatch(out, /url\(\s*["']?grain\.png/, 'and the url was still embedded');
        // NOT a count of <style> vs </style> across the whole file: the inlined kit
        // carries a CSS template and prose containing both literals in its own source.
        assert.match(out, /<STYLE>[\s\S]*?<\/STYLE>/, 'the block still opens and closes as it was written');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } },
    // embedCssUrls substitutes by SUBSTRING (`css.split(u).join(dataUrl)`), and the
    // two-format @font-face is the standard spelling:
    //   src: url('Inter.woff') format('woff'), url('Inter.woff2') format('woff2');
    // Refs are collected in source order, so `Inter.woff` is replaced INSIDE
    // `Inter.woff2` first — emitting `url('data:font/woff;base64,<bytes>2')` — and
    // the woff2 pass then finds nothing left to replace. The standalone ships a
    // corrupted font URL and silently falls back to a system face: the exact failure
    // inlining the <style> block was added to prevent. Unreachable before that
    // change, because embedCssUrls only ever saw <link>ed stylesheets.
    { name: 'a two-format @font-face embeds both faces, without one URL eating the other', run: async () => {
      const dir = await deckDir();
      try {
        await writeFile(join(dir, 'Inter.woff'), Buffer.from('woff-1-bytes'));
        await writeFile(join(dir, 'Inter.woff2'), Buffer.from('woff2-2-bytes'));
        let html = await readFile(join(dir, 'deck.html'), 'utf8');
        html = html.replace(
          "@font-face { font-family:Brand; src:url('brand.woff2') format('woff2'); }",
          "@font-face { font-family:Inter; src:url('Inter.woff') format('woff'), url('Inter.woff2') format('woff2'); }",
        );
        await writeFile(join(dir, 'deck.html'), html, 'utf8');

        await run('node', [join(dir, 'build-standalone.mjs'), join(dir, 'deck.html'), '--out', join(dir, 'out.html')]);
        const out = await readFile(join(dir, 'out.html'), 'utf8');

        // Scoped to the deck's own <style> — the FIRST one, before the inlined kit.
        // Searching the whole bundle matches the kit's own source comments, which
        // quote this very @font-face shape to explain the bug; that is a false
        // positive on the file the assertion is not about.
        const style = (out.match(/<style>[\s\S]*?<\/style>/i) || [''])[0];
        assert.doesNotMatch(style, /url\(\s*['"]?Inter\.woff/, 'a relative font path survived');
        // The giveaway of the collision: the stray "2" of `.woff2` glued on after the
        // woff payload, inside the quotes.
        assert.doesNotMatch(style, /base64,[A-Za-z0-9+/=]*2['"]/, 'one URL was substituted inside the other');
        assert.match(style, /data:font\/woff;base64,d29mZi0xLWJ5dGVz["']\)/, 'the woff face embeds its own bytes, and nothing more');
        assert.match(style, /data:font\/woff2;base64,d29mZjItMi1ieXRlcw/, 'the woff2 face embeds its own bytes');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } },
    // A linked stylesheet's url() refs are relative to the STYLESHEET, not to the
    // deck. embedCssUrls was handed the deck's folder, so `css/deck.css` asking for
    // `fonts/I.woff2` was resolved as `deck/fonts/I.woff2`, missed, and the throw was
    // swallowed — the bundler logged "inlined stylesheet" and shipped a standalone
    // with an unembedded font. The browser twin (deck-export.js) already resolves
    // against the stylesheet's own URL.
    { name: 'a linked stylesheet resolves its url() refs against its own folder', run: async () => {
      const dir = await deckDir();
      try {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(join(dir, 'css', 'fonts'), { recursive: true });
        await writeFile(join(dir, 'css', 'fonts', 'I.woff2'), Buffer.from('nested-font'));
        await writeFile(join(dir, 'css', 'deck.css'),
          "@font-face { font-family:N; src:url('fonts/I.woff2') format('woff2'); }\n", 'utf8');
        let html = await readFile(join(dir, 'deck.html'), 'utf8');
        html = html.replace('<style>', '<link rel="stylesheet" href="css/deck.css">\n<style>');
        await writeFile(join(dir, 'deck.html'), html, 'utf8');

        await run('node', [join(dir, 'build-standalone.mjs'), join(dir, 'deck.html'), '--out', join(dir, 'out.html')]);
        const out = await readFile(join(dir, 'out.html'), 'utf8');
        const styles = (out.match(/<style>[\s\S]*?<\/style>/gi) || []).join('\n');
        assert.doesNotMatch(styles, /url\(\s*['"]?fonts\/I\.woff2/, 'the nested font is still a relative path');
        assert.match(styles, /data:font\/woff2;base64,bmVzdGVkLWZvbnQ/, 'it embeds the nested font bytes');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } },
    // The rel test already tolerated `rel='stylesheet'` while the href match demanded
    // double quotes, so a single-quoted link fell out at the `!hm` guard BEFORE the
    // "skipped" log: not inlined, and not reported either.
    { name: 'a stylesheet link is inlined however its href is quoted', run: async () => {
      const dir = await deckDir();
      try {
        await writeFile(join(dir, 'extra.css'), '.from-linked-sheet { color: rebeccapurple; }', 'utf8');
        let html = await readFile(join(dir, 'deck.html'), 'utf8');
        html = html.replace('<title>D</title>', "<title>D</title><link rel='stylesheet' href='extra.css'>");
        await writeFile(join(dir, 'deck.html'), html, 'utf8');

        await run('node', [join(dir, 'build-standalone.mjs'), join(dir, 'deck.html'), '--out', join(dir, 'out.html')]);
        const out = await readFile(join(dir, 'out.html'), 'utf8');

        assert.match(out, /\.from-linked-sheet/, 'the single-quoted stylesheet was not inlined');
        assert.doesNotMatch(out, /<link\b[^>]*rel=["']?stylesheet[^>]*extra\.css/i,
          'the dead <link> survived into the standalone');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } },
    // inlineStyleBlocks ran AFTER inlineScripts, so its <style>…</style> matcher also
    // scanned the inlined JavaScript — and deck-stage.js carries an unbalanced
    // `<style id="deck-stage-print-page">` inside a doc comment. Verified on the real
    // bundle: 3 of 6 "style blocks" found were JavaScript, one 160 KB long. Nothing
    // broke only because no url() extracted from JS happened to resolve on disk; the
    // first script containing `url(<relative-path>)` that DOES exist beside the deck
    // turns `css.split(u).join(dataUrl)` loose across 160 KB of code.
    { name: 'style embedding never reaches into inlined JavaScript', run: async () => {
      const dir = await deckDir();
      try {
        // The real shape: a script whose SOURCE contains an UNBALANCED `<style …>`
        // (deck-stage.js has one in a doc comment) and a url() that resolves on
        // disk, followed later in the document by a real style block whose
        // `</style>` the matcher can span to.
        await writeFile(join(dir, 'tricky.js'),
          'const doc = `<style id="deck-stage-print-page">`;\n'
          + 'const bg = "url(grain.png)";\nwindow.__t = doc + bg;\n', 'utf8');
        let html = await readFile(join(dir, 'deck.html'), 'utf8');
        html = html.replace('</body>',
          '<script src="tricky.js"></script>\n<style>footer{background-image:url("grain.png")}</style>\n</body>');
        await writeFile(join(dir, 'deck.html'), html, 'utf8');

        await run('node', [join(dir, 'build-standalone.mjs'), join(dir, 'deck.html'), '--out', join(dir, 'out.html')]);
        const out = await readFile(join(dir, 'out.html'), 'utf8');

        assert.match(out, /const bg = "url\(grain\.png\)"/, "the script's own source is left byte-for-byte alone");
        assert.match(out, /footer\{background-image:url\("data:image\/png;base64,/, 'while the real block is embedded');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } },
    // inlineStyleBlocks was moved ahead of inlineScripts because a document-wide
    // scanner also sees the JavaScript pasted in by inlining — but inlineStylesheets,
    // embedFonts and inlineImages still ran AFTER it with the same hazard. inlineImages
    // rewrites via `html.split('src="X"').join(dataUrl)` across the whole document, so
    // an `src="<existing file>"` inside an inlined JS string literal is rewritten in the
    // CODE too: a base64 blob spliced into a source line.
    { name: 'a document-wide rewrite never reaches code that inlining pasted in', run: async () => {
      const dir = await deckDir();
      try {
        // A kit file whose SOURCE mentions the deck's own image, the way a doc comment
        // or a usage example does.
        await writeFile(join(dir, 'mentions.js'),
          'window.__EXAMPLE = \'<img src="grain.png">\';\n', 'utf8');
        let html = await readFile(join(dir, 'deck.html'), 'utf8');
        html = html
          .replace('<script src="deck-enhance.js"></script>', '<script src="mentions.js"></script>')
          .replace('</deck-stage>', '</deck-stage>\n<img src="grain.png" alt="">');
        await writeFile(join(dir, 'deck.html'), html, 'utf8');

        await run('node', [join(dir, 'build-standalone.mjs'), join(dir, 'deck.html'), '--out', join(dir, 'out.html')]);
        const out = await readFile(join(dir, 'out.html'), 'utf8');

        assert.match(out, /window\.__EXAMPLE = '<img src="grain\.png">'/,
          'the inlined source is left exactly as written');
        assert.match(out, /<img src="data:image\/png;base64,[^"]+" alt=""/,
          'while the real <img> is embedded');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } },
  ]);
});

test('build-standalone: local scripts inline however spelled, keep type, drop defer/async', async () => {
  await checkRows([
    // The script matcher was `/<script src="([^"]+)"><\/script>/g` — the exact
    // double-quoted, attribute-free spelling and nothing else. `defer`,
    // `type="module"`, single quotes, or a newline before the closing tag all miss,
    // and a miss produced NO log line (the skip path only covers fetch failures). The
    // result keeps a dead `<script src="deck-stage.js">` and opens to a blank page
    // with no diagnostic at all.
    { name: 'the bundler inlines local scripts however the tag is spelled', run: async () => {
      const dir = await deckDir();
      try {
        let html = await readFile(join(dir, 'deck.html'), 'utf8');
        html = html
          .replace('<script src="deck-stage.js"></script>', '<script src="deck-stage.js" defer></script>')
          .replace('<script src="deck-enhance.js"></script>', "<script src='deck-enhance.js'></script>")
          .replace('<script src="deck-export.js"></script>', '<script\n  src="deck-export.js"\n></script>');
        await writeFile(join(dir, 'deck.html'), html, 'utf8');

        const { stdout } = await run('node', [join(dir, 'build-standalone.mjs'), join(dir, 'deck.html'), '--out', join(dir, 'out.html')]);
        const out = await readFile(join(dir, 'out.html'), 'utf8');

        // A LIVE tag only. NOT a bare `src="deck-stage.js"` search: the inlined kit's
        // own JSDoc carries that literal in a usage example (with an escaped
        // `<\\/script>`, which is why requiring the real closing tag excludes it).
        assert.doesNotMatch(out, /<script\b[^>]*\bsrc\s*=\s*["'][^"']+\.js["'][^>]*>\s*<\/script\s*>/i,
          `a live external script survived the bundle\n${stdout}`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } },
    // Widening the matcher to tolerate attributes made it swallow
    // `<script type="module" src=…>` — but the replacement was hardcoded to a plain
    // `<script>`, dropping every attribute. A module inlined as a classic script
    // throws `Cannot use import statement outside a module` on first open, and even
    // without imports its scoping changes (top-level const leaks to global, `this`
    // differs, execution is no longer deferred) — while the log says "+ inlined".
    { name: 'the bundler preserves a script tag\'s type when it inlines it', run: async () => {
      const dir = await deckDir();
      try {
        await writeFile(join(dir, 'mod.js'), 'const scoped = 1; window.__mod = scoped;\n', 'utf8');
        let html = await readFile(join(dir, 'deck.html'), 'utf8');
        html = html.replace('</body>', '<script type="module" src="mod.js"></script>\n</body>');
        await writeFile(join(dir, 'deck.html'), html, 'utf8');

        await run('node', [join(dir, 'build-standalone.mjs'), join(dir, 'deck.html'), '--out', join(dir, 'out.html')]);
        const out = await readFile(join(dir, 'out.html'), 'utf8');

        assert.match(out, /<script type="module">/, 'the module stays a module');
        assert.match(out, /window\.__mod = scoped/, 'and its code was inlined');
        assert.doesNotMatch(out, /<script[^>]*\bsrc\s*=\s*["']mod\.js["']/, 'no live reference left');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } },
    // keepAttrs used a case-SENSITIVE indexOf("<script") while its matcher is /gi, so
    // `<SCRIPT SRC=…>` sliced from the middle of the tag name and emitted
    // `<script T>` — a bogus attribute wrapping the inlined code. And stopping at the
    // first ">" truncated a tag whose attribute value contained one.
    { name: 'an uppercase script tag inlines cleanly, attributes intact', run: async () => {
      const dir = await deckDir();
      try {
        await writeFile(join(dir, 'up.js'), 'window.__up = 1;\n', 'utf8');
        let html = await readFile(join(dir, 'deck.html'), 'utf8');
        html = html.replace('</body>', '<SCRIPT TYPE="module" SRC="up.js"></SCRIPT>\n</body>');
        await writeFile(join(dir, 'deck.html'), html, 'utf8');

        await run('node', [join(dir, 'build-standalone.mjs'), join(dir, 'deck.html'), '--out', join(dir, 'out.html')]);
        const out = await readFile(join(dir, 'out.html'), 'utf8');

        assert.match(out, /window\.__up = 1/, 'the uppercase tag was inlined');
        // The old slice started at index 6 of `<SCRIPT …`, so it kept a stray `T`
        // from the tag NAME as the first "attribute": `<script T TYPE="module">`.
        assert.doesNotMatch(out, /<script T TYPE/, 'no tag-name fragment became an attribute');
        assert.match(out, /<script TYPE="module">/, 'and its real attribute survived');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } },
    // `\bsrc` fires INSIDE `data-src`, because `-` is a non-word character, and the
    // preceding `[^>]*?` is lazy — so the matcher captured the decoy and the bundler
    // inlined the wrong file, leaving the real one a dead external reference in the
    // "standalone" deliverable. keepAttrs has the same root cause and strips the FIRST
    // match, emitting `<script data- src="real.js">…inlined…</script>` — a <script>
    // carrying `src` ignores its inline content, so the payload never runs either.
    { name: 'a decoy data-src attribute does not capture the script tag', run: async () => {
      const dir = await deckDir();
      try {
        await writeFile(join(dir, 'real.js'), 'window.__REAL = 1;', 'utf8');
        let html = await readFile(join(dir, 'deck.html'), 'utf8');
        html = html.replace('<script src="deck-enhance.js"></script>',
          '<script data-src="ignore.js" src="real.js"></script>');
        await writeFile(join(dir, 'deck.html'), html, 'utf8');

        const { stdout } = await run('node', [join(dir, 'build-standalone.mjs'), join(dir, 'deck.html'), '--out', join(dir, 'out.html')]);
        const out = await readFile(join(dir, 'out.html'), 'utf8');
        assert.match(out, /window\.__REAL/, `the real script was inlined:\n${stdout}`);
        assert.doesNotMatch(out, /<script[^>]*\ssrc\s*=\s*["']real\.js["']/i, 'and its tag no longer carries src');
        assert.doesNotMatch(out, /data-\s+src/i, 'the surviving attributes are not mangled');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } },
    // The matcher's comment claims tolerance of "how the tag is SPELLED", but it
    // required quotes — so a legal unquoted src stayed a dead external script and the
    // deck opened blank, with no log line to say why (and keepAttrs' own `\S+`
    // alternation was unreachable as a result).
    { name: 'an unquoted src is inlined too, not left dead', run: async () => {
      const dir = await deckDir();
      try {
        await writeFile(join(dir, 'bare.js'), 'window.__BARE = 1;', 'utf8');
        let html = await readFile(join(dir, 'deck.html'), 'utf8');
        html = html.replace('<script src="deck-enhance.js"></script>', '<script src=bare.js></script>');
        await writeFile(join(dir, 'deck.html'), html, 'utf8');

        const { stdout } = await run('node', [join(dir, 'build-standalone.mjs'), join(dir, 'deck.html'), '--out', join(dir, 'out.html')]);
        const out = await readFile(join(dir, 'out.html'), 'utf8');
        assert.match(out, /window\.__BARE/, `inlined:\n${stdout}`);
        assert.doesNotMatch(out, /<script[^>]*\ssrc\s*=\s*bare\.js/i, 'no dead external reference survives');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } },
    // keepAttrs preserves every attribute but `src`, and the matcher advertises
    // tolerance of `defer`. But defer/async are IGNORED on an inline classic script:
    // `<script src="x.js" defer>` in <head> becomes `<script defer>…</script>` that
    // runs at parse position instead of after the document. deck-enhance.js calls
    // initAll() — which does slides() — at top level, so the standalone opens with no
    // active slide and no reveals while the source deck works, and the retained
    // `defer` makes the output LOOK deferred.
    { name: 'defer/async are dropped when a script is inlined, not carried through', run: async () => {
      const dir = await deckDir();
      try {
        let html = await readFile(join(dir, 'deck.html'), 'utf8');
        html = html
          .replace('<script src="deck-stage.js"></script>', '')
          .replace('<head>', '<head>\n<script src="deck-stage.js" defer></script>')
          .replace('<script src="deck-enhance.js"></script>', '<script src="deck-enhance.js" async></script>');
        await writeFile(join(dir, 'deck.html'), html, 'utf8');

        await run('node', [join(dir, 'build-standalone.mjs'), join(dir, 'deck.html'), '--out', join(dir, 'out.html')]);
        const out = await readFile(join(dir, 'out.html'), 'utf8');
        const opens = out.match(/<script\b[^>]*>/gi) || [];
        const inlineOpens = opens.filter((t) => !/\ssrc\s*=/i.test(t));
        assert.ok(inlineOpens.length >= 2, `inline blocks were produced: ${inlineOpens.length}`);
        assert.deepEqual(inlineOpens.filter((t) => /\b(defer|async)\b/i.test(t)), [],
          'no inline block claims to be deferred');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } },
  ]);
});

test('build-standalone: an unresolvable script is reported and an escaping reference is never embedded', async () => {
  await checkRows([
    { name: 'a local script the bundler cannot resolve is reported, never dropped silently', run: async () => {
      const dir = await deckDir();
      try {
        let html = await readFile(join(dir, 'deck.html'), 'utf8');
        html = html.replace('</body>', '<script src="missing-kit.js"></script>\n</body>');
        await writeFile(join(dir, 'deck.html'), html, 'utf8');

        const { stdout, stderr } = await run('node', [join(dir, 'build-standalone.mjs'), join(dir, 'deck.html'), '--out', join(dir, 'out.html')]);
        const log = stdout + stderr;
        assert.match(log, /missing-kit\.js/, 'the unresolved script must appear in the log');
        assert.match(log, /skip/i, log);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } },
    // CONFINEMENT. `localPath` was a bare `resolve(baseDir, href)`, so `../` walked
    // out of deck/ and an absolute href discarded baseDir altogether. This bundler
    // runs unsandboxed over markup an LLM wrote from user-supplied material and its
    // product is a file meant to be SENT to people, so "it embedded whatever it could
    // read" is a disclosure bug, not a tidiness one. scripts/deck-bundle.py carried
    // the guard — and a comment naming this exact hole — for a release before it was
    // closed here.
    { name: 'a reference that escapes the deck folder is never embedded', run: async () => {
      const dir = await deckDir();
      try {
        await writeFile(join(dir, '..', 'worca-standalone-secret.txt'), 'TOP-SECRET-BYTES', 'utf8');
        let html = await readFile(join(dir, 'deck.html'), 'utf8');
        html = html
          .replace('<h1>One</h1>', '<h1>One</h1><img src="/etc/passwd">')
          .replace('</body>', '<script src="../worca-standalone-secret.txt"></script></body>');
        await writeFile(join(dir, 'deck.html'), html, 'utf8');

        const { stderr } = await run('node', [join(dir, 'build-standalone.mjs'), join(dir, 'deck.html'), '--out', join(dir, 'out.html')]);
        const out = await readFile(join(dir, 'out.html'), 'utf8');

        assert.ok(!out.includes('TOP-SECRET-BYTES'), 'the escaping file was inlined verbatim');
        for (const b64 of out.match(/base64,([A-Za-z0-9+/=]+)/g) || []) {
          const decoded = Buffer.from(b64.slice(7), 'base64').toString('latin1');
          assert.ok(!decoded.includes('TOP-SECRET-BYTES'), 'the escaping file was inlined as a data URI');
          assert.ok(!decoded.includes('root:'), '/etc/passwd was inlined as a data URI');
        }
        // Silently skipping is its own failure: the deliverable then carries a dead
        // reference no one was told about.
        assert.match(stderr, /resolves outside the deck folder/, 'the escape was not reported');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } },
  ]);
});

test('build-standalone: commented-out tags are left alone', async () => {
  await checkRows([
    // The widened script matcher scans the whole document, HTML comments included, so
    // a commented-out <script src> is treated as a live tag. Today that only emits a
    // misleading "skipped … (not found)"; if the file exists the bundler pastes the
    // payload INSIDE the comment, where it never runs.
    { name: 'a commented-out script tag is not treated as a live one', run: async () => {
      const dir = await deckDir();
      try {
        await writeFile(join(dir, 'ghost.js'), 'window.__GHOST = 1;', 'utf8');
        let html = await readFile(join(dir, 'deck.html'), 'utf8');
        html = html.replace('</body>', '<!-- <script src="ghost.js"></script> -->\n</body>');
        await writeFile(join(dir, 'deck.html'), html, 'utf8');

        const { stdout } = await run('node', [join(dir, 'build-standalone.mjs'), join(dir, 'deck.html'), '--out', join(dir, 'out.html')]);
        const out = await readFile(join(dir, 'out.html'), 'utf8');
        assert.doesNotMatch(stdout, /inlined ghost\.js/, `a commented tag was inlined:\n${stdout}`);
        assert.doesNotMatch(out, /window\.__GHOST/, 'and its payload is not pasted into the comment');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } },
    // ROUND 2, N4. The collection loop carefully skips tags inside HTML comments,
    // and then `html.split(tag).join(payload)` — a document-wide SUBSTRING replace —
    // rewrote them anyway. The kit's own sources quote live tags in their headers and
    // the bundler comments out the audio tag, so the collision is routine; when the
    // payload contains `-->` (deck-export.js has three) the comment ENDS EARLY and
    // raw JavaScript spills into the document as visible text, with the log still
    // reading "inlined".
    { name: 'a commented-out tag is left alone, payload `-->` and all', run: async () => {
      const dir = await deckDir();
      try {
        await writeFile(join(dir, 'lib.js'), '/* a --> b */\nwindow.__lib = 1;\n', 'utf8');
        await writeFile(join(dir, 'sheet.css'), '.live-sheet{color:red} /* --> */\n', 'utf8');
        let html = await readFile(join(dir, 'deck.html'), 'utf8');
        html = html
          .replace('<title>D</title>', '<title>D</title><link rel="stylesheet" href="sheet.css">')
          .replace('</body>',
            '<!-- it used to load: <script src="lib.js"></script> -->\n'
            + '<!-- and style: <link rel="stylesheet" href="sheet.css"> -->\n'
            + '<script src="lib.js"></script>\n</body>');
        await writeFile(join(dir, 'deck.html'), html, 'utf8');

        await run('node', [join(dir, 'build-standalone.mjs'), join(dir, 'deck.html'), '--out', join(dir, 'out.html')]);
        const out = await readFile(join(dir, 'out.html'), 'utf8');

        // Both comments survive intact — unsubstituted, and still terminated.
        assert.match(out, /<!-- it used to load: <script src="lib\.js"><\/script> -->/,
          'the commented-out script tag was substituted');
        assert.match(out, /<!-- and style: <link rel="stylesheet" href="sheet\.css"> -->/,
          'the commented-out link tag was substituted');
        // ...and the LIVE ones were still inlined.
        assert.match(out, /window\.__lib = 1;/, 'the live script was not inlined');
        assert.match(out, /\.live-sheet\{color:red\}/, 'the live stylesheet was not inlined');
        // Nothing escaped a comment into the rendered page.
        const { JSDOM } = await import('jsdom');
        const doc = new JSDOM(out).window.document;
        const walker = doc.createTreeWalker(doc.body, 4);
        const loose = [];
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const tag = n.parentElement && n.parentElement.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE') continue;
          const t = n.textContent.replace(/\s+/g, ' ').trim();
          if (t) loose.push(t);
        }
        assert.deepEqual(loose, ['One'], `code or CSS spilled into the page: ${JSON.stringify(loose)}`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } },
  ]);
});

test('build-standalone: img/audio/video sources are embedded however quoted', async () => {
  await checkRows([
    // The <img> matcher accepted only a double-quoted src, while the script matcher
    // two functions up was widened to single-quoted and unquoted. Both are legal HTML
    // and slipped through with NO log line — "image skipped" only fires on a failed
    // fetch of a MATCHED src — so the "standalone" shipped a dead relative reference.
    { name: 'an image src is embedded however it is quoted', run: async () => {
      const dir = await deckDir();
      try {
        let html = await readFile(join(dir, 'deck.html'), 'utf8');
        html = html.replace('</deck-stage>',
          `</deck-stage>\n<img src='grain.png' alt="a"><img src=grain.png alt="b"><img src="grain.png" alt="c">`);
        await writeFile(join(dir, 'deck.html'), html, 'utf8');

        const { stdout } = await run('node', [join(dir, 'build-standalone.mjs'), join(dir, 'deck.html'), '--out', join(dir, 'out.html')]);
        const out = await readFile(join(dir, 'out.html'), 'utf8');
        const body = out.slice(out.indexOf('<deck-stage'));
        assert.doesNotMatch(body, /<img[^>]*\ssrc\s*=\s*['"]?grain\.png/i,
          `every spelling is embedded, none left relative:\n${stdout}`);
        assert.equal((body.match(/<img[^>]*src="data:image\/png;base64,/g) || []).length, 3, 'all three rewritten');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } },
    // Only <img src> was inlined, so a narrated deck's <audio src="narration.mp3">
    // survived as a dead relative reference with no log line — bakeAudio only ever
    // handled the narration-audio.js SCRIPT form. mimeFor had no audio/video entries
    // either, so even a matched file would have been embedded as octet-stream and
    // played back nowhere. scripts/deck-bundle.py matches img|audio|video|source
    // under one pattern; this side had diverged.
    { name: 'audio and video sources are embedded too, not just <img>', run: async () => {
      const dir = await deckDir();
      try {
        await writeFile(join(dir, 'narration.mp3'), Buffer.from('ID3-audio-bytes'));
        await writeFile(join(dir, 'clip.webm'), Buffer.from('webm-bytes'));
        let html = await readFile(join(dir, 'deck.html'), 'utf8');
        html = html.replace('<h1>One</h1>',
          '<h1>One</h1><audio src="narration.mp3"></audio><video><source src="clip.webm"></video>');
        await writeFile(join(dir, 'deck.html'), html, 'utf8');

        await run('node', [join(dir, 'build-standalone.mjs'), join(dir, 'deck.html'), '--out', join(dir, 'out.html')]);
        const out = await readFile(join(dir, 'out.html'), 'utf8');

        assert.match(out, /data:audio\/mpeg;base64,/, 'the voiceover is not embedded, or not as audio');
        assert.match(out, /data:video\/webm;base64,/, 'the <source> clip is not embedded, or not as video');
        assert.doesNotMatch(out, /src=["']?narration\.mp3/, 'a dead audio reference survived');
        assert.doesNotMatch(out, /src=["']?clip\.webm/, 'a dead video reference survived');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    } },
  ]);
});
