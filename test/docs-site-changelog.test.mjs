// test/docs-site-changelog.test.mjs
// The docs.worca.dev changelog build (docs-site/changelog.mjs): the entries.json
// contract, what the release list reads from a page, the image rewrite, the document
// shell, and a full build of the repo's real entries into a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readEntries, pageSummary, localizeImages, docShell, renderIndex, buildChangelog, compareVersions,
} from '../docs-site/changelog.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FRAGMENT = `<title>Worca — What's new in 9.9.0</title>
<style>body{}</style>
<div class="wrap">
  <section class="sec hero" id="s0"><h1>What's new</h1><p class="sub">Since 9.8.0 — <b>faster</b> runs &amp; fewer clicks.</p>
    <img src="shots/9.9.0/s0.jpg" alt=""></section>
  <section class="sec" id="s1"><h2>Runs start<br>faster.</h2></section>
  <section class="sec" id="s2"><div><h2 class="x">Team &amp; policy.</h2></div></section>
  <section class="sec polish" id="s3"><h2>Shipped, tested, verified live.</h2></section>
</div>`;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'worca-docs-cl-'));
}

function changelogDir(entries, pages) {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'entries.json'), JSON.stringify(entries));
  for (const v of pages) fs.writeFileSync(path.join(dir, `worca-app-v${v}.src.html`), FRAGMENT);
  return dir;
}

test('pageSummary: title, hero sub and feature headlines, without the hero and the receipts', () => {
  assert.deepEqual(pageSummary(FRAGMENT), {
    title: "Worca — What's new in 9.9.0",
    sub: 'Since 9.8.0 — faster runs & fewer clicks.',
    sections: [{ id: 's1', title: 'Runs start faster.' }, { id: 's2', title: 'Team & policy.' }],
  });
});

test('readEntries: newest first, and every entry needs its page and every page its entry', async () => {
  const ok = changelogDir(
    [{ version: '1.2.0-rc.3', since: '1.1.1', date: '2026-09-03' }, { version: '1.10.0', since: '1.9.0', date: '2026-10-01' }, { version: '1.2.0', since: '1.1.1', date: '2026-09-10' }],
    ['1.2.0-rc.3', '1.10.0', '1.2.0'],
  );
  const got = await readEntries(ok, fs.readdirSync(ok));
  assert.deepEqual(got.map((e) => e.version), ['1.10.0', '1.2.0', '1.2.0-rc.3']);

  const noPage = changelogDir([{ version: '1.0.0', since: '0.9.0', date: '2026-01-01' }], []);
  await assert.rejects(readEntries(noPage, fs.readdirSync(noPage)), /worca-app-v1\.0\.0\.src\.html does not exist/);

  const noEntry = changelogDir([], ['1.0.0']);
  await assert.rejects(readEntries(noEntry, fs.readdirSync(noEntry)), /has no entry in entries\.json/);

  const badDate = changelogDir([{ version: '1.0.0', since: '0.9.0', date: '1 Jan' }], ['1.0.0']);
  await assert.rejects(readEntries(badDate, fs.readdirSync(badDate)), /bad date/);

  const dup = changelogDir([{ version: '1.0.0', since: '0.9.0', date: '2026-01-01' }, { version: '1.0.0', since: '0.9.0', date: '2026-01-01' }], ['1.0.0']);
  await assert.rejects(readEntries(dup, fs.readdirSync(dup)), /duplicate version/);
});

test('localizeImages: local images become files next to the page; remote and data: sources are kept', () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, 'docs/changelog/shots/9.9.0'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ui/public/assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/changelog/shots/9.9.0/s0.jpg'), 'x');
  fs.writeFileSync(path.join(root, 'ui/public/assets/worca-logo.png'), 'x');
  const pageDir = path.join(root, 'docs/changelog');
  const html = '<img src="docs/changelog/shots/9.9.0/s0.jpg"><img alt="" src="ui/public/assets/worca-logo.png">' +
    '<img src="https://x.test/a.png"><img src="data:image/png;base64,AA==">';
  const out = localizeImages(html, { pageDir, repoRoot: root });
  assert.equal(out.html, '<img src="s0.jpg"><img alt="" src="worca-logo.png"><img src="https://x.test/a.png"><img src="data:image/png;base64,AA==">');
  assert.deepEqual(out.assets.map((a) => a.name).sort(), ['s0.jpg', 'worca-logo.png']);

  assert.throws(() => localizeImages('<img src="shots/nope.jpg">', { pageDir, repoRoot: root }), /missing image\(s\): shots\/nope\.jpg/);

  fs.mkdirSync(path.join(root, 'other'), { recursive: true });
  fs.writeFileSync(path.join(root, 'other/s0.jpg'), 'y');
  assert.throws(
    () => localizeImages('<img src="docs/changelog/shots/9.9.0/s0.jpg"><img src="other/s0.jpg">', { pageDir, repoRoot: root }),
    /two different images are both named s0\.jpg/,
  );
});

test('docShell: a standards-mode document with charset, viewport, one title, and the releases bar', () => {
  const entry = { version: '9.9.0', since: '9.8.0', date: '2026-09-29' };
  const page = docShell(FRAGMENT, { entry, summary: pageSummary(FRAGMENT), prev: { version: '9.8.0' }, next: null });
  assert.match(page, /^<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">/);
  assert.match(page, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.equal(page.match(/<title>/g).length, 1, 'the fragment\'s <title> moves into <head>');
  assert.match(page, /<link rel="canonical" href="https:\/\/docs\.worca\.dev\/changelog\/9\.9\.0\/">/);
  assert.match(page, /<a rel="prev" href="\/changelog\/9\.8\.0\/">&larr; 9\.8\.0<\/a>/);
  assert.doesNotMatch(page, /rel="next"/, 'the newest release has no next link');
  assert.match(page, /<a href="\/changelog\/">All releases<\/a>/);
});

test('renderIndex: one row per release linking to its page and its sections; the "Since X —" lead is dropped', () => {
  const entry = { version: '9.9.0', since: '9.8.0', date: '2026-09-29' };
  const html = renderIndex('<main>{{RELEASES}}</main><footer>{{BUILD_DATE}}</footer>', [{ entry, summary: pageSummary(FRAGMENT) }], { BUILD_DATE: '2026-09-29' });
  assert.match(html, /<article class="rel latest">/);
  assert.match(html, /<p class="rel-sub">Faster runs &amp; fewer clicks\.<\/p>/);
  assert.match(html, /<a href="\/changelog\/9\.9\.0\/#s1">Runs start faster\.<\/a>/);
  assert.match(html, /<time datetime="2026-09-29">29 Sept 2026<\/time>|<time datetime="2026-09-29">29 Sep 2026<\/time>/);
  assert.doesNotMatch(html, /Shipped, tested/);
});

test('compareVersions orders stable above its release candidates', () => {
  const sorted = ['1.2.0-rc.2', '1.10.0', '1.2.0', '1.2.0-rc.10', '1.1.1'].sort((a, b) => compareVersions(b, a));
  assert.deepEqual(sorted, ['1.10.0', '1.2.0', '1.2.0-rc.10', '1.2.0-rc.2', '1.1.1']);
});

test('the repo\'s real changelog builds: every page, every image, every release in the list', async () => {
  const dist = tmpdir();
  const template = fs.readFileSync(path.join(REPO, 'docs-site/src/changelog.html'), 'utf8');
  const entries = await buildChangelog({ repoRoot: REPO, dist, template, vars: { REPO_URL: 'https://example.test', BUILD_DATE: '2026-09-29' } });
  assert.ok(entries.length >= 5, 'the backfilled entries are all there');

  const list = fs.readFileSync(path.join(dist, 'changelog/index.html'), 'utf8');
  assert.doesNotMatch(list, /\{\{/);
  for (const { version } of entries) {
    const dir = path.join(dist, 'changelog', version);
    const page = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.match(page, /^<!doctype html>/, `${version}: document shell`);
    const srcs = [...page.matchAll(/<img\b[^>]*?\bsrc="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(srcs.length > 0, `${version}: has images`);
    for (const src of srcs) {
      if (/^(data:|https?:)/.test(src)) continue;
      assert.ok(!src.includes('/'), `${version}: ${src} points next to the page`);
      assert.ok(fs.existsSync(path.join(dir, src)), `${version}: ${src} was copied`);
    }
    assert.ok(list.includes(`href="/changelog/${version}/"`), `${version}: in the release list`);
  }
});
