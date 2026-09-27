// test/ask-html-text.test.mjs
// Untrusted HTML → readable text for web_fetch (docs/guardrails.md "Web access").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText } from '../src/core/ask/html-text.mjs';

test('hostile nesting/flooding is bounded by the time budget', () => {
  for (const html of ['<li>x'.repeat(300000), '<div>'.repeat(200000) + '</div>'.repeat(200000)]) {
    const t0 = performance.now();
    const r = htmlToText(html, null, { budgetMs: 300 });
    assert.ok(performance.now() - t0 < 3000, 'must not stall');
    assert.equal(typeof r.text, 'string');
  }
});

test('svg <title> never leaks into the page title; truncated is reliable', () => {
  assert.equal(htmlToText('<title>T</title><body><svg><title>icon</title></svg><p>x</p></body>').title, 'T');
  assert.equal(htmlToText(`<pre>a${' '.repeat(200)}\n</pre>`, null, { maxChars: 100 }).truncated, true);
});

test('drops script/style/nav/footer, keeps headings, lists, links', () => {
  const html = `<html><head><title>T &amp; Co</title><style>x{}</style></head><body>
    <nav><a href="/home">Home</a></nav><h1>Hello</h1><p>One &lt;two&gt; <a href="/x">link</a></p>
    <ul><li>a</li><li>b<ol><li>c</li></ol></li></ul><script>alert(1)</script><footer>foot</footer></body></html>`;
  const r = htmlToText(html, 'https://docs.example.com/p');
  assert.equal(r.title, 'T & Co');
  assert.match(r.text, /^# Hello$/m);
  assert.match(r.text, /One <two> link \(https:\/\/docs\.example\.com\/x\)/);
  assert.match(r.text, /^- a$/m); assert.match(r.text, /^\s+1\. c$/m);
  for (const gone of ['alert', 'Home', 'foot', 'x{}']) assert.ok(!r.text.includes(gone), gone);
});

test('narrows to <main> when present, falls back when main is empty', () => {
  assert.equal(htmlToText('<div>chrome</div><main><p>body</p></main>').text, 'body');
  assert.equal(htmlToText('<div>chrome</div><main></main>').text, 'chrome');
});

test('javascript:/data: links carry no URL; unclosed tags in nav do not leak', () => {
  assert.equal(htmlToText('<p><a href="javascript:alert(1)">x</a></p>').text, 'x');
  assert.equal(htmlToText('<nav><a href="/a">n<span>m</nav><p>after</p>').text, 'after');
});

test('pre keeps whitespace; caps output', () => {
  assert.match(htmlToText('<pre>a\n  b</pre>').text, /```\na\n  b\n```/);
  const r = htmlToText(`<p>${'x'.repeat(500)}</p>`, null, { maxChars: 100 });
  assert.equal(r.text.length, 100); assert.equal(r.truncated, true);
});
