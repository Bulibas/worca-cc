import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('../ui/public/style.css', import.meta.url), 'utf8');

test('#555: status text never uses --ink-3; .hint.ok exists; feedback rules use tokens', () => {
  assert.match(css, /\.hint\{display:block;color:var\(--ink-2\);/);
  assert.match(css, /\.hint\.ok\{color:var\(--green-ink\);\}/);
  assert.match(css, /\.toasts\{position:fixed;[^}]*bottom:calc\(var\(--ask-dock-clearance\)[^}]*z-index:71;/);
  // Reduced motion must beat the spinner rule: same selector, later in the file.
  const spin = css.indexOf('.is-busy[data-fb-state="busy"] .btn-spin{');
  const rm = css.indexOf('@media (prefers-reduced-motion:reduce){.toast{animation:none;}.is-busy[data-fb-state="busy"] .btn-spin{animation:none;}}');
  assert.ok(spin > 0 && rm > spin, 'reduced-motion rule comes after the spinner rule');
  assert.match(css, /\.toast \.td\{[^}]*color:var\(--ink-2\)/);
  assert.match(css, /\.field-error\{[^}]*color:var\(--red-ink\)/);
  // (v4) Button states must not depend on .btn (withButton also wraps .btn-go / btn-ghost / .linkish).
  assert.match(css, /\.is-done\[data-fb-state="done"\]\.is-done,\.is-done\[data-fb-state="done"\]\.is-done:hover\{background:var\(--green-ink\);[^}]*color:var\(--on-ink\)/);
  // (v5) (0,4,0): .btn-split > .btn-go:disabled (6199) is (0,3,0) and later in the file.
  assert.match(css, /\.is-busy\.is-busy\[data-fb-state="busy"\]:disabled\{opacity:1;/);
  assert.doesNotMatch(css, /\.btn \.btn-spin\{|\.btn\.is-done/);
  for (const m of css.matchAll(/[^{}]+:disabled[^{]*\{[^}]*opacity/g)) {
    for (const sel of m[0].split('{')[0].split(',').map((x) => x.trim())) {
      if (sel.startsWith('.is-busy') || !/\.(?:btn|btn-go|btn-ghost|btn-primary|linkish)(?![\w-])/.test(sel)) continue;
      const spec = (sel.match(/\.[\w-]+|\[[^\]]+\]|:(?!not\b|is\b|where\b|has\b)[\w-]+/g) || []).length;
      assert.ok(spec < 4, `${sel} reaches (0,4,0): it would dim the busy state`);
    }
  }
  const block = css.slice(css.indexOf('/* ===================== Action feedback (#555'), css.indexOf('.dirty-dot{'));
  assert.doesNotMatch(block, /--ink-3/);
});

test('#555 D2a: scoped .hint rules no longer grey out errors', () => {
  const mv = css.indexOf('.mv-providers .hint.err,.mv-conn .hint.err,.mvi .hint.err,.mv-cp-signin-box .hint.err{color:var(--red-ink);}');
  assert.ok(mv > css.indexOf('.mv-providers .hint,'), 'provider error override comes after the grey scoped rule');
  const other = css.indexOf('.tm-empty .hint.err,.hd-diff-body.hint.err,');
  assert.ok(other > 0, 'the shared scoped override exists');
  for (const grey of ['.tm-empty .hint,', '.hd-diff-body.hint{', '.hd-diff-pane .hint,', '.away-body .hint,', '.mcp-usedby .hint{', '.act-card .hint,']) {
    const at = css.indexOf(grey);
    assert.ok(at > 0 && other > at, `the override comes after ${grey}`);
  }
});
