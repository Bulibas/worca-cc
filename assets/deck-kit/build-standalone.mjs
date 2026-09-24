#!/usr/bin/env node
/* build-standalone.mjs — headless "bundle a deck into one file", for agents.
 * ─────────────────────────────────────────────────────────────────────────
 * The deck-export.js bundler runs in the BROWSER and needs the deck served
 * over http(s). This is the same job done HEADLESSLY from disk — no browser,
 * no server — so an agent can run it wherever the deck's files sit together
 * on a filesystem (the Claude web app's code sandbox, a local checkout, CI).
 * It inlines every local <script>, the baked narration audio, same-origin
 * stylesheets + their url() assets, <img> sources, and the Google fonts into
 * ONE self-contained .html.
 *
 * TWO MODES (the only difference is whether authoring stays on):
 *   • publish (default) → final share-ready file: Studio removed, audio baked.
 *   • preview (--preview / --keep-studio) → keeps the Studio live, so it's the
 *     file to open while you're still tuning the deck — and the right
 *     deliverable in single-file environments (e.g. the Claude web app), where
 *     the multi-file deck can't load its companion scripts and shows blank.
 *
 * USAGE:
 *   node build-standalone.mjs [deck.html] [--preview] [--out FILE]
 *
 *   deck.html   the deck to bundle. Optional — if omitted, the only *.html in
 *               the current folder that mounts a <deck-stage> is used.
 *   --preview   keep the Studio (a "preview" build). Alias: --keep-studio.
 *   --out FILE  output path. Default: <deck>.standalone.html (publish) or
 *               <deck>.preview.html (preview).
 *
 * Requires Node 18+ (global fetch, for embedding the Google fonts; if the
 * network is unavailable the fonts stay as a CDN <link> and the build still
 * succeeds). Zero npm dependencies.
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, basename, extname, join } from "node:path";

const AUDIO_SRC = "narration-audio.js";

function log(s) { process.stderr.write("[build] " + s + "\n"); }
function isRemote(u) { return /^(https?:)?\/\//.test(u) || /^data:/i.test(u); }

function mimeFor(url) {
  const ext = (url.split("?")[0].split("#")[0].split(".").pop() || "").toLowerCase();
  return ({
    woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf",
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    webp: "image/webp", avif: "image/avif", svg: "image/svg+xml",
  })[ext] || "application/octet-stream";
}

// Resolve a local href against the deck's folder; return its absolute path.
function localPath(baseDir, href) { return resolve(baseDir, href.split("?")[0].split("#")[0]); }

async function readMaybe(p) { try { return await readFile(p); } catch { return null; } }
async function dataUrl(baseDir, href) {
  const buf = await readFile(localPath(baseDir, href));
  return "data:" + mimeFor(href) + ";base64," + buf.toString("base64");
}

// Mark the output as a published standalone, BEFORE deck-narration.js runs, so
// it hides the authoring Studio (and Narrate/Auto-play when no audio is baked).
function markExported(html) {
  const flag = "<script>window.__DECK_EXPORTED=true;<\/script>\n";
  const narrTag = '<script src="deck-narration.js"></script>';
  if (html.includes(narrTag)) return html.split(narrTag).join(flag + narrTag);
  return html.replace(/<\/head>/i, flag + "</head>");
}

// Activate the baked-audio include if narration-audio.js is present next to the deck.
async function bakeAudio(html, baseDir) {
  const audio = await readMaybe(join(baseDir, AUDIO_SRC));
  if (!audio || !audio.toString("utf8").includes("__NARRATION_AUDIO")) {
    log("• " + AUDIO_SRC + " not found → bundling without baked audio");
    return html;
  }
  log("• " + AUDIO_SRC + " found → baking voiceover in");
  return html
    .split('<!-- <script src="' + AUDIO_SRC + '"></script> -->')
    .join('<script src="' + AUDIO_SRC + '"></script>');
}

// Everything the original <script> declared except `src` — `type="module"` above
// all. The widened matcher tolerates attributes, and a hardcoded plain <script>
// silently turned a module into a classic script: `Cannot use import statement
// outside a module` on first open, and different scoping even without imports.
function keepAttrs(tag) {
  // Case-INSENSITIVE, like the matcher that feeds this: on `<SCRIPT SRC=…>` a
  // case-sensitive indexOf("<script") returned -1, and -1 + 7 sliced from the
  // middle of the tag name — emitting `<script T>`, a bogus attribute wrapping
  // the inlined code.
  //
  // A literal `>` inside an attribute value still truncates, here and in the
  // matcher upstream (`[^>]*`), which no regex-based tag scan can fix. HTML that
  // exotic is out of scope for a deck the builder writes to CONTRACT.md.
  const m = /^<script\b/i.exec(tag);
  if (!m) return "";
  const inner = tag.slice(m[0].length, tag.indexOf(">"));
  // (^|\s) for the same reason as the matcher: `\bsrc` matched inside `data-src`
  // and this replace is NOT global, so it stripped the decoy's tail and emitted
  // `data- src="real.js"` — leaving `src` on the inlined block, which makes the
  // browser ignore the inline code entirely.
  // …and DROP defer/async. They are ignored on an inline classic script, so
  // carrying them through changed WHEN the code runs — `<script src=x defer>` in
  // <head> became `<script defer>` executing at parse position instead of after
  // the document. deck-enhance.js calls initAll() (which reads slides()) at top
  // level, so the standalone opened with no active slide and no reveals while the
  // source deck worked, and the retained attribute made the output look deferred.
  // `type="module"` stays: a module script is deferred inline too.
  const kept = inner
    .replace(/(^|\s)src\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, "$1")
    .replace(/(^|\s)(?:defer|async)(\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/gi, "$1")
    .trim();
  return kept ? " " + kept.replace(/\s+/g, " ") : "";
}

// Inline every LOCAL <script src="…">; neutralize any </script in the code so
// the inline block isn't closed early.
//
// The matcher is deliberately tolerant of how the tag is SPELLED: `defer`,
// `type="module"`, single quotes and a newline before the closing tag are all
// legal HTML and all missed the old exact-spelling pattern — leaving a dead
// external <script> in a file that then opens to a blank page, with no log line
// either, because the skip path only covered fetch failures. Data blocks
// (application/json, ld+json, text/template) are not code and are left alone.
// Byte ranges of HTML comments, so a tag matcher can ignore what is inside one.
// The widened script matcher scans the whole document, so a commented-out
// `<!-- <script src="x.js"></script> -->` read as a live tag: with the file
// missing that was a misleading "skipped (not found)" line, and with the file
// PRESENT the bundler pasted the payload inside the comment, where it never runs.
// (bakeAudio un-comments the narration tag before this, so a baked deck is
// unaffected — and when its exact-string match misses, skipping beats pasting.)
function commentRanges(html) {
  const out = [];
  const re = /<!--[\s\S]*?-->/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push([m.index, m.index + m[0].length]);
  return out;
}
const insideComment = (ranges, i) => ranges.some((r) => i >= r[0] && i < r[1]);

async function inlineScripts(html, baseDir) {
  // `\ssrc`, never `\bsrc`: `-` is a NON-word character, so `\b` fires inside
  // `data-src` and the lazy `[^>]*?` happily stopped there — the matcher captured
  // the decoy and the bundler inlined the wrong file, leaving the real one a dead
  // external reference in the "standalone". An attribute is always preceded by
  // whitespace inside a tag, so requiring it is both correct and portable (no
  // lookbehind, which this also has to run in a browser).
  //
  // The quotes are OPTIONAL: `<script src=deck-stage.js>` is legal HTML, and the
  // comment above claims tolerance of how the tag is spelled. Unquoted, it used to
  // miss entirely and leave a dead script that opens to a blank page with no log.
  const re = /<script\b(?![^>]*\btype\s*=\s*["\x27]?(?:application\/json|application\/ld\+json|text\/template))[^>]*?\ssrc\s*=\s*(?:["\x27]([^"\x27]+)["\x27]|([^\s>]+))[^>]*>\s*<\/script\s*>/gi;
  const hits = [];
  const comments = commentRanges(html);
  let m;
  while ((m = re.exec(html)) !== null) {
    if (insideComment(comments, m.index)) continue;
    hits.push({ full: m[0], src: m[1] || m[2] });
  }
  for (const hit of hits) {
    if (isRemote(hit.src)) continue;
    const buf = await readMaybe(localPath(baseDir, hit.src));
    if (!buf) { log("  ! skipped " + hit.src + " (not found)"); continue; }
    const code = buf.toString("utf8").replace(/<\/script/gi, "<\\/script");
    html = html.split(hit.full).join("<script" + keepAttrs(hit.full) + ">\n" + code + "\n<\/script>");
    log("  + inlined " + hit.src);
  }
  return html;
}

// Embed same-origin url(...) assets inside a CSS string as data URLs.
async function embedCssUrls(css, baseDir) {
  const RE = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
  const refs = [];
  css.replace(RE, (_, u) => { refs.push(u); return _; });
  const embedded = new Map();
  for (const u of refs) {
    if (embedded.has(u) || isRemote(u) || u.charAt(0) === "#") continue;
    try { embedded.set(u, await dataUrl(baseDir, u)); } catch { /* leave as-is */ }
  }
  if (!embedded.size) return css;
  // ONE pass over the url() TOKENS. The old form replaced every SUBSTRING
  // occurrence (`css.split(u).join(dataUrl)`), and refs are collected in source
  // order — so on the standard two-format face
  //   src: url('Inter.woff') format('woff'), url('Inter.woff2') format('woff2')
  // the shorter ref was substituted INSIDE the longer one, emitting
  // `url('data:font/woff;base64,<bytes>2')`, and the woff2 pass then found
  // nothing left to replace. The deck shipped a corrupted font URL and fell back
  // to a system face — silently, which is the one thing a standalone must not do.
  // Rewriting the matched token cannot collide, whatever the filenames are.
  return css.replace(RE, (full, u) => (embedded.has(u) ? 'url("' + embedded.get(u) + '")' : full));
}

// Inline same-origin stylesheet <link>s as <style> (embedding their url() assets).
async function inlineStylesheets(html, baseDir) {
  const tags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (!/rel=["']?stylesheet/i.test(tag)) continue;
    const hm = tag.match(/href="([^"]+)"/i);
    if (!hm || isRemote(hm[1])) continue;
    const buf = await readMaybe(localPath(baseDir, hm[1]));
    if (!buf) { log("• stylesheet skipped " + hm[1] + " (not found)"); continue; }
    // The stylesheet's OWN folder: its url() refs are relative to it, not to the
    // deck. Resolving `css/deck.css`'s `fonts/I.woff2` against the deck folder
    // missed the file, and dataUrl's throw is swallowed — so the bundler logged
    // "inlined stylesheet" and shipped an unembedded font. The browser twin
    // (deck-export.js) already resolves against the stylesheet's own URL.
    const css = await embedCssUrls(buf.toString("utf8"), dirname(localPath(baseDir, hm[1])));
    html = html.split(tag).join("<style>\n" + css + "\n</style>");
    log("• inlined stylesheet " + hm[1]);
  }
  return html;
}

// Embed url() assets in the deck's OWN inline <style> blocks. embedCssUrls used
// to run only over stylesheets pulled in from a <link>, but CONTRACT.md mandates
// the opposite shape — "Styles in one <style> block", "@font-face files copied
// into deck/" — so on the canonical deck every font and background image
// survived the bundle as a relative path. The file then rendered correctly while
// it sat next to deck/ and lost its typography the moment it was sent, which is
// the one thing a standalone exists not to do.
async function inlineStyleBlocks(html, baseDir) {
  const blocks = html.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) || [];
  for (const block of blocks) {
    const open = block.slice(0, block.indexOf('>') + 1);
    // toLowerCase: the block matcher is case-INSENSITIVE, so an uppercase
    // <STYLE> block reaches here and a case-sensitive search returns -1 —
    // slice(open.length, -1) then keeps "</STYLE" as CSS and the rewrite emits a
    // duplicated, malformed close tag.
    const close = block.toLowerCase().lastIndexOf('</style>');
    const css = block.slice(open.length, close);
    if (!/url\(/i.test(css)) continue;
    const embedded = await embedCssUrls(css, baseDir);
    if (embedded === css) continue;
    html = html.split(block).join(open + embedded + block.slice(close));
  }
  return html;
}

// Embed the Google Fonts CSS + its woff2 files as base64 (best-effort, needs net).
async function embedFonts(html) {
  const linkRe = /<link[^>]+href="(https:\/\/fonts\.googleapis\.com\/css2[^"]+)"[^>]*>/;
  const m = html.match(linkRe);
  if (!m) return html;
  try {
    // A browser UA makes Google serve woff2 (vs ttf).
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
    // response.ok, on BOTH fetches. Neither checked, so a 404, a captive-portal
    // interstitial or a redirect page was inlined verbatim as a <style> block and
    // its bytes base64'd under `data:font/woff2`. Nothing threw, the catch never
    // fired, and it logged "fonts embedded (N files)" — the standalone shipped
    // silently in a fallback face, which is the single failure this whole
    // function exists to prevent.
    const cssRes = await fetch(m[1], { headers: { "User-Agent": ua } });
    if (!cssRes.ok) throw new Error("font CSS " + cssRes.status);
    let css = await cssRes.text();
    const urls = css.match(/https:\/\/[^)"']+\.woff2/g) || [];
    for (const u of urls) {
      const fontRes = await fetch(u);
      if (!fontRes.ok) throw new Error("font file " + fontRes.status);
      const buf = Buffer.from(await fontRes.arrayBuffer());
      css = css.split(u).join("data:font/woff2;base64," + buf.toString("base64"));
    }
    html = html.replace(/<link rel="preconnect"[^>]*>\s*/g, "");
    html = html.replace(linkRe, "<style>\n" + css + "\n</style>");
    log("• fonts embedded (" + urls.length + " files)");
  } catch (e) {
    log("• font embed skipped (" + e.message + ") — keeps the CDN link + system fallback");
  }
  return html;
}

// Inline same-origin <img src="…"> as base64 data URLs.
async function inlineImages(html, baseDir) {
  // Single-quoted and unquoted too, like the script matcher: `<img src='logo.png'>`
  // and `<img src=logo.png>` are legal HTML and slipped through with NO log line
  // ("image skipped" only fires on a failed fetch of a MATCHED src), so the
  // "standalone" went out with a dead relative reference.
  const re = /<img\b[^>]*?\ssrc\s*=\s*(?:["\x27]([^"\x27]+)["\x27]|([^\s>]+))[^>]*>/gi;
  const srcs = [];
  let m;
  while ((m = re.exec(html)) !== null) srcs.push(m[1] || m[2]);
  const embedded = new Map();
  for (const src of srcs) {
    if (embedded.has(src) || isRemote(src)) continue;
    try { embedded.set(src, await dataUrl(baseDir, src)); }
    catch { log("• image skipped " + src + " (not found)"); }
  }
  if (!embedded.size) return html;
  // Rewrite the matched TOKEN, not `src="X"` as a literal: the token may be
  // single-quoted or unquoted, and a literal split would silently leave those
  // exactly as they were — found, fetched, embedded, and then not substituted.
  re.lastIndex = 0;
  html = html.replace(re, (full, q, bare) => {
    const url = embedded.get(q || bare);
    return url ? full.replace(/(\ssrc\s*=\s*)(?:["\x27][^"\x27]*["\x27]|[^\s>]+)/i, `$1"${url}"`) : full;
  });
  log("• embedded " + embedded.size + " image" + (embedded.size === 1 ? "" : "s"));
  return html;
}

// Find the deck .html in a folder: the only one mounting a <deck-stage>.
async function autodetectDeck(dir) {
  const files = (await readdir(dir)).filter((f) => /\.html?$/i.test(f));
  const matches = [];
  for (const f of files) {
    const txt = (await readFile(join(dir, f), "utf8"));
    if (/<deck-stage\b/.test(txt) || /component-from-global-scope="deck-stage"/.test(txt)) matches.push(f);
  }
  if (matches.length === 1) return join(dir, matches[0]);
  if (matches.length === 0) throw new Error("no deck (.html with <deck-stage>) found in " + dir);
  throw new Error("multiple decks found (" + matches.join(", ") + ") — pass one explicitly");
}

async function main() {
  const argv = process.argv.slice(2);
  const preview = argv.includes("--preview") || argv.includes("--keep-studio");
  const outIdx = argv.indexOf("--out");
  const outArg = outIdx !== -1 ? argv[outIdx + 1] : null;
  const deckArg = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--out");

  const deckPath = deckArg ? resolve(deckArg) : await autodetectDeck(process.cwd());
  const baseDir = dirname(deckPath);
  log((preview ? "preview" : "publish") + " build of " + basename(deckPath));

  let html = await readFile(deckPath, "utf8");
  html = await bakeAudio(html, baseDir);
  if (preview) log("• preview build — Studio kept (not marked as published)");
  else html = markExported(html);
  // inlineStyleBlocks FIRST: run after inlineScripts, its <style>…</style>
  // matcher also scans the inlined JavaScript, and deck-stage.js carries an
  // unbalanced `<style id="deck-stage-print-page">` in a doc comment — the match
  // then spans from there to the next real </style> and embedCssUrls rewrites
  // url() inside 160 KB of code. Measured on the real bundle: 3 of 6 "blocks"
  // were JavaScript. inlineStylesheets embeds its own url()s as it goes, so it
  // needs no second pass.
  //
  // The SAME hazard applies to every other document-wide pass, so inlineScripts
  // runs LAST of all of them. inlineImages rewrites with
  // `html.split('src="X"').join(dataUrl)` across the whole file — after code is
  // pasted in, that splices a base64 blob into any source line mentioning one of
  // the deck's own images (a doc comment, a usage example), and the kit's sources
  // do exactly that. The rule: nothing that scans the document may run once the
  // document contains code.
  html = await inlineStyleBlocks(html, baseDir);
  html = await inlineStylesheets(html, baseDir);
  html = await embedFonts(html);
  html = await inlineImages(html, baseDir);
  html = await inlineScripts(html, baseDir);

  const stem = basename(deckPath).replace(/\.html?$/i, "");
  const out = outArg ? resolve(outArg) : join(baseDir, stem + (preview ? ".preview" : ".standalone") + ".html");
  await writeFile(out, html);
  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  log("✓ wrote " + out + " (" + kb + " KB)" + (preview ? " — Studio kept" : " — ready to share"));
  process.stdout.write(out + "\n");
}

main().catch((e) => { log("✗ " + e.message); process.exit(1); });
