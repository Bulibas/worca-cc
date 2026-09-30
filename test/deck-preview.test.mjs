// test/deck-preview.test.mjs — the visual-system preview renderer (assets/deck-preview/).
// The HTML builder is pure; the Chrome wrapper is exercised with a stubbed spawn and a fake
// Chrome script, so no test here needs a real browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSpec, contrast, esc, formData, LIMITS, previewPages } from '../assets/deck-preview/preview-html.mjs';
import { chromeCandidates, findChrome, screenshot, screenshotArgs } from '../assets/deck-preview/chrome.mjs';
import { checkAskData } from '../src/shared/forms/answer.mjs';
import { prepareFormAsk } from '../src/core/ask-forms.mjs';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../assets/deck-preview/render-preview.mjs', import.meta.url));
const META = JSON.parse(await readFile(new URL('../agents/deckSystem.meta.json', import.meta.url), 'utf8'));
const FORM = META.ask.forms['approve-system'];

const SPEC = Object.freeze({
  deckTitle: 'Why the onboarding pilot worked',
  coverTitle: 'Nine days to first commit is costing us a sprint per hire',
  grounds: [
    { id: 'paper', name: 'Paper', hex: '#EEEDE8', ink: '#16181D', job: 'Evidence: charts, tables and quotes' },
    { id: 'ink', name: 'Ink', hex: '#16181D', ink: '#F4F3EE', job: 'Resets between sections' },
  ],
  typeSteps: [
    { id: 'hero', name: 'Hero number', px: 220, weight: 700, family: 'Inter', role: 'hero', sample: '78%' },
    { id: 'title', name: 'Slide title', px: 64, weight: 600, family: 'Inter', role: 'title' },
    { id: 'body', name: 'Body', px: 36, weight: 400, family: 'Inter', role: 'body' },
  ],
  compositions: [
    { id: 'statement', name: 'Statement', kind: 'statement', job: 'One sentence, nothing else', ground: 'ink', titles: ['Nobody owns the first week'], slides: 4 },
    { id: 'ledger', name: 'Ledger', kind: 'ledger', job: 'Where the days go', ground: 'paper', titles: ['Three of the nine days are waiting for access', 'Access requests wait on one person'], slides: 7 },
  ],
  accent: { name: 'Signal', hex: '#FF5A1F', job: 'Marks the one cost nobody owns', className: '.is-unowned' },
  icons: { family: 'Lucide', stroke: 2 },
});
const spec = (mutate) => { const s = JSON.parse(JSON.stringify(SPEC)); mutate?.(s); return s; };
const allHtml = (s) => previewPages(s).map((p) => p.html).join('\n');

test('the fixture spec is valid', () => {
  assert.deepEqual(checkSpec(SPEC), { ok: true, errors: [] });
});

test('the pages show every ground hex, composition name and real slide title', () => {
  const html = allHtml(SPEC);
  for (const g of SPEC.grounds) assert.ok(html.includes(g.hex), g.hex);
  for (const c of SPEC.compositions) {
    assert.ok(html.includes(esc(c.name)), c.name);
    for (const t of c.titles.slice(0, 1)) assert.ok(html.includes(esc(t)), t);
  }
  assert.ok(html.includes(esc(SPEC.coverTitle)));
  assert.ok(html.includes('.is-unowned'));
});

test('the pages are self-contained: no network URL, no script, a CSP that forbids both', () => {
  for (const p of previewPages(SPEC)) {
    assert.doesNotMatch(p.html, /https?:\/\//);
    assert.doesNotMatch(p.html, /<script/i);
    assert.match(p.html, /Content-Security-Policy" content="default-src 'none'/);
    assert.equal(p.width, 1600);
    assert.ok(Number.isInteger(p.height) && p.height > 600, `${p.name} height ${p.height}`);
  }
  assert.deepEqual(previewPages(SPEC).map((p) => p.name), ['system-sheet', 'compositions', 'samples']);
});

// Chrome screenshots exactly `height` and the pages are overflow:hidden, so an under-estimate cuts
// the bottom of the PNG without an error (review cycle 1: a 7-step scale with a long family
// lost the accent card). Each text block therefore has a bounded height, and the estimate
// budgets that bound.
const steps = (n, family) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, name: `Step ${i}`, px: 30 - i * 2, weight: 400, family }));
const comps = (n, job) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, name: `Comp ${i}`, kind: 'list', job, ground: 'paper', titles: ['A title'], slides: 2 }));

test('each type-ladder row is budgeted for its two-line label, not only for the sample text', () => {
  const family = 'IBM Plex Sans Condensed SemiBold Italic';   // 40 characters
  const sheet = (n) => previewPages(spec((s) => { s.typeSteps = steps(n, family); }))[0];
  // a label is the step name over the `px · family weight` line: 44px, plus 21px of padding and rule
  assert.ok(sheet(12).height - sheet(2).height >= 10 * 65, `${sheet(12).height} - ${sheet(2).height}`);
  assert.equal((sheet(12).html.match(/class="step" style="height:65px"/g) || []).length, 12);
});

test('each composition card is budgeted for a two-line job, its name and its count line', () => {
  const page = (n) => previewPages(spec((s) => { s.compositions = comps(n, 'x '.repeat(100).trim()); }))[1];
  // 3 columns either way: one more row is a card and a gap. The card is its border and padding
  // (36), the 16:9 frame of a (1472 - 2 × 28) / 3 - 34 wide column, a 14px gap and a 96px caption.
  const frame = ((1472 - 56) / 3 - 34) * 9 / 16;
  assert.ok(page(9).height - page(6).height >= 36 + frame + 14 + 96 + 28, `${page(9).height} - ${page(6).height}`);
});

test('every text block in the page flow is bounded, so string lengths never change a page height', () => {
  const long = (n) => 'word '.repeat(n).slice(0, n);
  const shortSpec = spec((s) => { s.typeSteps = steps(7, 'Inter'); s.compositions = comps(6, 'Short'); });
  const longSpec = spec((s) => {
    s.deckTitle = long(LIMITS.title); s.coverTitle = long(LIMITS.title);
    for (const g of s.grounds) { g.name = long(LIMITS.name); g.job = long(LIMITS.job); }
    s.typeSteps = steps(7, long(LIMITS.family).trim()).map((t) => ({ ...t, name: long(LIMITS.name).trim() }));
    s.compositions = comps(6, long(LIMITS.job)).map((c) => ({ ...c, name: long(LIMITS.name) }));
    s.accent = { ...s.accent, name: long(LIMITS.name), job: long(LIMITS.job) };
    s.icons = { family: long(LIMITS.name), stroke: 2 };
  });
  assert.equal(checkSpec(longSpec).ok, true, checkSpec(longSpec).errors.join('\n'));
  assert.deepEqual(previewPages(longSpec).map((p) => p.height), previewPages(shortSpec).map((p) => p.height));
  const html = previewPages(longSpec)[0].html;
  const rule = (sel) => new RegExp(`${sel.replace(/[.]/g, '\\.')}\\{[^}]*`).exec(html)?.[0] || '';
  for (const [sel, lines] of [['.sw .jb', 3], ['.acc p', 3], ['.cap .jb', 2]]) {
    assert.match(rule(sel), new RegExp(`-webkit-line-clamp:${lines}`), sel);
  }
  for (const sel of ['.kick', 'h2', '.sw .nm', '.sw .hx', '.step .lb b', '.step .lb span', '.acc .ln', '.acc .cls', '.cap .nm', '.cap .ct']) {
    assert.match(rule(sel), /white-space:nowrap;overflow:hidden;text-overflow:ellipsis/, sel);
  }
  for (const [sel, h] of [['.sw .meta', 156], ['.bottom', 282], ['.cap', 24], ['.cap.jobs', 96]]) {
    assert.match(rule(sel), new RegExp(`height:${h}px`), sel);
  }
});

test('hostile spec strings are escaped wherever they land', () => {
  const html = allHtml(spec((s) => {
    s.deckTitle = '</title><script>alert(1)</script>';
    s.grounds[0].name = '<img src=x onerror=alert(1)>';
    s.grounds[0].job = '" onmouseover="x';
    s.compositions[0].titles = ['</div><script>1</script>'];
    s.accent.job = "It's <b>bold</b> & loud";
  }));
  assert.doesNotMatch(html, /<script>|<img src=x|<b>bold/);
  assert.ok(html.includes('&lt;/title&gt;&lt;script&gt;'));
  assert.ok(html.includes('&quot; onmouseover=&quot;x'));
  assert.ok(html.includes('It&#39;s &lt;b&gt;bold&lt;/b&gt; &amp; loud'));
});

test('checkSpec refuses anything that would reach CSS unchecked', () => {
  const errs = (m) => checkSpec(spec(m)).errors.join('\n');
  assert.match(errs((s) => { s.grounds[0].hex = 'red;background:url(//x)'; }), /grounds\[0\]\.hex/);
  assert.match(errs((s) => { s.accent.hex = '#FFF'; }), /accent\.hex/);
  assert.match(errs((s) => { s.typeSteps[0].family = 'Inter"; } body { x'; }), /typeSteps\[0\]\.family/);
  assert.match(errs((s) => { s.typeSteps[0].px = 12.5; }), /typeSteps\[0\]\.px/);
  assert.match(errs((s) => { s.accent.className = '.accent'; }), /accent\.className/);
  assert.match(errs((s) => { s.compositions[0].kind = 'carousel'; }), /compositions\[0\]\.kind/);
  assert.match(errs((s) => { s.compositions[0].ground = 'nope'; }), /compositions\[0\]\.ground/);
  assert.match(errs((s) => { s.compositions[1].id = 'statement'; }), /used twice/);
  assert.match(errs((s) => { s.compositions[0].titles = []; }), /titles/);
  assert.equal(checkSpec(null).ok, false);
});

test('checkSpec: ids are text (the form refuses a number), px runs to the 1080 canvas height', () => {
  const errs = (m) => checkSpec(spec(m)).errors.join('\n');
  assert.match(errs((s) => { s.grounds[0].id = 1; }), /grounds\[0\]\.id/);
  assert.match(errs((s) => { s.typeSteps[1].id = 7; }), /typeSteps\[1\]\.id/);
  assert.equal(errs((s) => { s.typeSteps[0].px = 1080; }), '');
  assert.match(errs((s) => { s.typeSteps[0].px = 1081; }), /typeSteps\[0\]\.px is a whole number 8-1080/);
  assert.equal(FORM.data.properties.typeSteps.items.properties.px.maximum, 1080);
  const big = spec((s) => { s.typeSteps[0].px = 1080; });
  assert.deepEqual(checkAskData(FORM, formData(big)), { ok: true, errors: [] });
});

test('a type step without a family is drawn and labelled in the system sans (the kit prescribes no font)', () => {
  const s = spec((x) => { for (const t of x.typeSteps) delete t.family; });
  assert.deepEqual(checkSpec(s), { ok: true, errors: [] });
  const html = allHtml(s);
  assert.ok(html.includes('64px · system sans 600'));
  assert.doesNotMatch(html, /&quot;undefined&quot;|"undefined"/);
  const data = formData(s);
  assert.deepEqual(data.typeSteps.map((t) => t.family), ['system sans', 'system sans', 'system sans']);
  assert.deepEqual(checkAskData(FORM, data), { ok: true, errors: [] });
});

test('a hero-number wireframe shows the number in its title, else the hero step sample', () => {
  const s = spec((x) => { x.compositions[0] = { ...x.compositions[0], kind: 'hero-number', titles: ['Access requests dominate the wait'] }; });
  assert.ok(previewPages(s)[1].html.includes('>78%</div>'));
  const t = spec((x) => { x.compositions[0] = { ...x.compositions[0], kind: 'hero-number', titles: ['Two teams, 9 days saved'] }; });
  assert.ok(previewPages(t)[1].html.includes('>9</div>'));
});

test('contrast is the WCAG ratio', () => {
  assert.equal(contrast('#000000', '#FFFFFF'), 21);
  assert.equal(contrast('#FFFFFF', '#FFFFFF'), 1);
});

test('formData feeds the approve-system form: with images, without, and at every limit', () => {
  const images = { sheet: 'preview/system-sheet.png', compositionsSheet: 'preview/compositions.png', samples: 'preview/samples.png' };
  const withImages = formData(SPEC, { images });
  assert.deepEqual(checkAskData(FORM, withImages), { ok: true, errors: [] });
  assert.equal(withImages.sheet, images.sheet);
  const without = formData(SPEC);
  assert.deepEqual(checkAskData(FORM, without), { ok: true, errors: [] });
  assert.equal('sheet' in without, false);
  assert.match(without.headline, /no Chrome found/);
  assert.deepEqual(without.typeSteps.map((s) => s.px), [220, 64, 36]);   // largest first
  const long = (n) => 'x'.repeat(n);
  const big = spec((s) => {
    s.deckTitle = long(LIMITS.title); s.coverTitle = long(LIMITS.title);
    s.grounds = Array.from({ length: LIMITS.grounds[1] }, (_, i) => ({ id: `g${i}`, name: long(LIMITS.name), hex: '#EEEDE8', ink: '#16181D', job: long(LIMITS.job) }));
    s.typeSteps = Array.from({ length: LIMITS.typeSteps[1] }, (_, i) => ({ id: `t${i}`, name: long(LIMITS.name), px: 1080 - i, weight: 900, family: long(LIMITS.family) }));
    s.compositions = Array.from({ length: LIMITS.compositions[1] }, (_, i) => ({ id: `c${i}`, name: long(LIMITS.name), kind: 'list', job: long(LIMITS.job), ground: 'g0', titles: [long(LIMITS.title)], slides: 200 }));
    s.accent = { name: long(LIMITS.name), hex: '#FF5A1F', job: long(LIMITS.job), className: `.is-${long(40)}` };
  });
  assert.equal(checkSpec(big).ok, true, checkSpec(big).errors.join('\n'));
  assert.deepEqual(checkAskData(FORM, formData(big)).errors, []);
  for (const opts of [{ chrome: true }, { images: { sheet: images.sheet } }]) {
    assert.deepEqual(checkAskData(FORM, formData(big, opts)).errors, [], JSON.stringify(opts));
  }
});

test('formData says why a preview image is missing: no Chrome, Chrome failed, or which pages failed', () => {
  assert.match(formData(SPEC).headline, /Preview images unavailable \(no Chrome found\)/);
  const failed = formData(SPEC, { chrome: true }).headline;
  assert.match(failed, /Preview images unavailable \(Chrome could not render them\)/);
  assert.doesNotMatch(failed, /no Chrome found/);
  const partial = formData(SPEC, { chrome: true, images: { sheet: 'preview/system-sheet.png' } });
  assert.match(partial.headline, /Not rendered: compositions, samples/);
  assert.equal(partial.sheet, 'preview/system-sheet.png');
  assert.equal('samples' in partial, false);
});

test('chromeCandidates: WORCA_CHROME first, then PATH names, then the platform install paths', () => {
  const mac = chromeCandidates({ env: { WORCA_CHROME: '/x/chrome', PATH: '/usr/bin' }, platform: 'darwin' });
  assert.equal(mac[0], '/x/chrome');
  assert.ok(mac.includes(join('/usr/bin', 'google-chrome')));
  assert.ok(mac.includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  const linux = chromeCandidates({ env: { PATH: '/usr/bin' }, platform: 'linux' });
  assert.ok(!linux.some((p) => p.startsWith('/Applications')));
  assert.equal(findChrome({ env: { PATH: '/nowhere' }, platform: 'linux', exists: () => false }), null);
  assert.equal(findChrome({ env: { PATH: '/usr/bin' }, platform: 'linux', exists: (p) => p.endsWith('chromium') }), join('/usr/bin', 'chromium'));
});

test('screenshotArgs is the audit recipe, without a fresh --user-data-dir (it hangs macOS Chrome)', () => {
  const a = screenshotArgs({ htmlPath: '/p/a b.html', pngPath: '/p/a.png', width: 1600, height: 900 });
  assert.ok(a.includes('--headless=new') && a.includes('--window-size=1600,900') && a.includes('--screenshot=/p/a.png'));
  assert.ok(!a.some((x) => x.startsWith('--user-data-dir')));
  assert.equal(a.at(-1), 'file:///p/a%20b.html');
  assert.ok(screenshotArgs({ htmlPath: '/p/a.html', pngPath: '/p/a.png', width: 1, height: 1, noSandbox: true }).includes('--no-sandbox'));
});

test('screenshot judges success by the fresh PNG, not by the exit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deck-preview-shot-'));
  try {
    const pngPath = join(dir, 'a.png');
    const opts = { htmlPath: join(dir, 'a.html'), pngPath, width: 10, height: 10 };
    const writes = (extra = {}) => (cmd, args) => { writeFileSync(args.find((x) => x.startsWith('--screenshot=')).slice(13), 'PNG'); return { status: 0, ...extra }; };
    assert.deepEqual(screenshot('chrome', opts, { run: writes() }), { ok: true });
    // the macOS case: the PNG is written, then the process has to be killed at the timeout
    assert.deepEqual(screenshot('chrome', opts, { run: writes({ status: null, error: new Error('spawnSync chrome ETIMEDOUT') }) }), { ok: true });
    // a stale PNG from an earlier run never counts
    await writeFile(pngPath, 'OLD');
    const r = screenshot('chrome', opts, { run: () => ({ status: 1 }) });
    assert.equal(r.ok, false);
    assert.equal(existsSync(pngPath), false);
    assert.equal(screenshot('chrome', opts, { run: () => { throw new Error('ENOENT'); } }).ok, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function pipelineWithSpec(s = SPEC) {
  const pdir = await mkdtemp(join(tmpdir(), 'deck-preview-run-'));
  await mkdir(join(pdir, 'preview'));
  await writeFile(join(pdir, 'preview', 'system.json'), JSON.stringify(s));
  return pdir;
}

test('CLI --no-chrome: html pages, the form data and the whole ask payload; exit 0', async () => {
  const pdir = await pipelineWithSpec();
  try {
    const ask = join(pdir, 'questions.json');
    const { stdout } = await run(process.execPath, [CLI, '--spec', join(pdir, 'preview', 'system.json'), '--ask', ask, '--no-chrome']);
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    assert.deepEqual(out.images, []);
    for (const n of ['system-sheet', 'compositions', 'samples']) assert.ok(existsSync(join(pdir, 'preview', `${n}.html`)), n);
    const payload = JSON.parse(await readFile(ask, 'utf8'));
    assert.equal(payload.form, 'approve-system');
    assert.deepEqual(checkAskData(FORM, payload.data), { ok: true, errors: [] });
    assert.deepEqual(JSON.parse(await readFile(join(pdir, 'preview', 'approve-system.data.json'), 'utf8')), payload.data);
  } finally { await rm(pdir, { recursive: true, force: true }); }
});

test('CLI with a bad spec: exit 2, one problem per stderr line, no ask written', async () => {
  const pdir = await pipelineWithSpec(spec((s) => { s.grounds[0].hex = 'teal'; s.accent.className = '.accent'; }));
  try {
    const ask = join(pdir, 'questions.json');
    await assert.rejects(run(process.execPath, [CLI, '--spec', join(pdir, 'preview', 'system.json'), '--ask', ask, '--no-chrome']),
      (e) => e.code === 2 && /grounds\[0\]\.hex/.test(e.stderr) && /accent\.className/.test(e.stderr));
    assert.equal(existsSync(ask), false);
  } finally { await rm(pdir, { recursive: true, force: true }); }
});

test('CLI with a Chrome that renders nothing: exit 0, the tables only, and the headline says Chrome failed', { skip: process.platform === 'win32' }, async () => {
  const pdir = await pipelineWithSpec();
  try {
    const fake = join(pdir, 'failing-chrome.sh');
    await writeFile(fake, '#!/bin/sh\nexit 1\n');
    await chmod(fake, 0o755);
    const ask = join(pdir, 'questions.json');
    const { stdout } = await run(process.execPath, [CLI, '--spec', join(pdir, 'preview', 'system.json'), '--ask', ask], { env: { ...process.env, WORCA_CHROME: fake } });
    const out = JSON.parse(stdout);
    assert.deepEqual(out.images, []);
    assert.equal(out.problems.length, 3);
    const { data } = JSON.parse(await readFile(ask, 'utf8'));
    assert.match(data.headline, /Chrome could not render them/);
    assert.deepEqual(checkAskData(FORM, data), { ok: true, errors: [] });
  } finally { await rm(pdir, { recursive: true, force: true }); }
});

test('CLI with a (fake) Chrome: run-relative PNG paths that pass gate 2 as image/png', { skip: process.platform === 'win32' }, async () => {
  const pdir = await pipelineWithSpec();
  const cwd = await mkdtemp(join(tmpdir(), 'deck-preview-cwd-'));
  try {
    const fake = join(pdir, 'fake-chrome.sh');
    // writes a PNG signature to the --screenshot= target, like Chrome would
    await writeFile(fake, '#!/bin/sh\nfor a in "$@"; do case "$a" in --screenshot=*) printf \'\\211PNG\\r\\n\\032\\n\' > "${a#--screenshot=}";; esac; done\n');
    await chmod(fake, 0o755);
    const ask = join(pdir, 'questions.json');
    const { stdout } = await run(process.execPath, [CLI, '--spec', join(pdir, 'preview', 'system.json'), '--ask', ask], { env: { ...process.env, WORCA_CHROME: fake } });
    assert.deepEqual(JSON.parse(stdout).images, ['preview/system-sheet.png', 'preview/compositions.png', 'preview/samples.png']);
    const payload = JSON.parse(await readFile(ask, 'utf8'));
    const r = await prepareFormAsk({ agentMeta: META, payload, cwd, pipelineDir: pdir, askId: 'questions-x-n_system-c1-r1' });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.ask.files.map((f) => f.mime), ['image/png', 'image/png', 'image/png']);
    assert.deepEqual(r.autoValues, { decision: 'approve' });
  } finally { await rm(pdir, { recursive: true, force: true }); await rm(cwd, { recursive: true, force: true }); }
});
