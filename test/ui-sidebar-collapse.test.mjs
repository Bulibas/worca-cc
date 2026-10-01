// test/ui-sidebar-collapse.test.mjs — the sidebar's two states: the 298px
// labelled column and the 76px icon rail. Markup + CSS contract, plus jsdom
// behaviour driven through the REAL app.js against the REAL index.html
// (harness lifted from test/ui-pipeline-tabs.test.mjs:15-36).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..', 'ui', 'public');
const htmlPath = join(root, 'index.html');
const appPath = join(root, 'app.js');
const html = readFileSync(htmlPath, 'utf8');
const css = readFileSync(join(root, 'style.css'), 'utf8');
const PROJECT = '/tmp/proj';
const KEY = 'worca-cc.sidebar.collapsed';
const DAY = 86400000;

// The suite's canonical helper (test/ui-pinned-sidebar.test.mjs:16-20): pull a
// FLAT rule body, anchored on a non-word char (or start) so a selector ending in
// the same WORD cannot match. Two consequences that bite:
//   (a) the capture is ([^}]*) — it stops at the FIRST closing brace, including
//       one inside a comment. Hence the plan's hard rule: no comments inside
//       rule bodies, and no closing brace in any comment in the new block.
//   (b) the anchor class includes whitespace, so a DESCENDANT selector ending in
//       the same compound ('.sidebar.collapsed .side-foot' vs '.side-foot') CAN
//       match — which is why every base rule must stay ahead of the appended
//       block, and why the guards below check what they matched.
function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp('(?:^|[\\s,}])' + escaped + '\\s*\\{([^}]*)\\}'));
  return m ? m[1] : null;
}

const budgetFixture = () => ({
  pipelineLimitUsd: null, totalLimitUsd: 50, resetPeriod: 'monthly',
  windowStartMs: Date.now() - 3 * DAY, windowEndMs: Date.now() + 4 * DAY,
  msUntilReset: 4 * DAY, windowSpendUsd: 20, allTimeSpendUsd: 20,
  remainingUsd: 30, blocked: false,
});

async function boot({ seed = null, breakStorage = false,
                      poisonToggle = false, noBudget = false,
                      spyReflow = false, budgetOver = null } = {}) {
  // index.html SHIPS aria-expanded="true" / title="Collapse menu" /
  // aria-label="Collapse menu" on #side-toggle, so asserting those after an
  // EXPANDED boot passes even when applySidebarCollapsed() never ran — proven by
  // deleting its whole `if (btn)` branch and watching the suite stay green.
  // poisonToggle strips them, so only a real write can satisfy the assertion.
  // Verified safe: index.html's only other two aria-expanded are ="false"
  // (:700, :812), and neither menu label occurs anywhere in ui/, test/ or src/.
  let markup = html;
  if (poisonToggle) {
    markup = markup.replace(
      / aria-expanded="true"| title="Collapse menu"| aria-label="Collapse menu"/g, '');
  }
  const dom = new JSDOM(markup, { url: 'http://localhost:4317/' });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  let lastWs = null;
  window.WebSocket = class {
    constructor() { this.readyState = 1; this._l = {}; lastWs = this; }
    send() {} close() {}
    addEventListener(t, fn) { (this._l[t] ||= []).push(fn); }
  };
  window.fetch = (url) => {
    const u = String(url);
    if (u.includes('/api/budget')) {
      // noBudget: a promise that never settles, so paintBudget runs with
      // budgetState.budget === null (app.js:448 early-returns before #side-spend).
      if (noBudget) return new Promise(() => {});
      // budgetOver: patch the fixture (e.g. clear the total limit) for one boot.
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ...budgetFixture(), ...budgetOver }) });
    }
    // The ring's click routes to #stats, which paints the stats view. Without a
    // body the paint throws AFTER the test ends ("Cannot read properties of
    // undefined (reading 'spentUsd')") and node:test fails the whole FILE on the
    // stray async activity, while the test itself reports as passing.
    if (u.includes('/api/stats')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({
        range: 'month', bucket: 'day',
        windowStartMs: Date.now() - 3 * DAY, windowEndMs: Date.now() + 4 * DAY,
        totals: { spentUsd: 20, workedMs: 0, runs: 0, finished: 0, stopped: 0,
          failed: 0, paused: 0, running: 0, prsOpened: 0, prsMerged: 0 },
        prev: null, budget: budgetFixture(), series: [] }) });
    }
    if (u.includes('/api/projects')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({
        projects: [{ name: 'proj', path: PROJECT, exists: true }] }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({
      config: { steps: {}, customModels: [] }, models: [], efforts: [],
      pipelines: 0, projects: 0, workspaces: 0 }) });
  };
  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch { /* keep */ }
  }
  globalThis.window = window; globalThis.document = window.document;
  window.localStorage.clear();
  if (seed) for (const [k, v] of Object.entries(seed)) window.localStorage.setItem(k, v);
  // jsdom's localStorage is a Proxy — a per-instance defineProperty is silently
  // ignored, so private mode has to be simulated on the prototype. Narrowed to
  // OUR key: app.js reads LAST_PROJECT_KEY (:5342), LAST_WORKSPACE_KEY (:5760)
  // and LAST_TARGET_KEY (:14028) outside any try/catch, and a blanket throw
  // would fail the boot for unrelated reasons. Patched AFTER the seeding above.
  // Each JSDOM owns its own Storage constructor, so this cannot leak.
  if (breakStorage) {
    const g = window.Storage.prototype.getItem;
    const s = window.Storage.prototype.setItem;
    window.Storage.prototype.getItem = function (k) {
      if (k === KEY) throw new Error('denied'); return g.call(this, k);
    };
    window.Storage.prototype.setItem = function (k, v) {
      if (k === KEY) throw new Error('denied'); return s.call(this, k, v);
    };
  }
  // The boot restore (app.js:411-417) is a four-statement ORDERING — suppress the
  // rail's transition, apply the class, force a layout flush by READING
  // offsetWidth, hand the transition back — and jsdom has no layout, so nothing
  // observes it: delete the whole block and every other test in this file stays
  // green while the real page slides the rail 298px -> 76px on every load. The
  // getter still FIRES though, so recording what the rail looks like at that
  // instant is the only handle this file has on the ordering. Same idiom as the
  // offsetParent spies in ui-composer-wires:18-19 and four sibling files; each
  // JSDOM owns its own HTMLElement, so this cannot leak between boots.
  const reflows = [];
  if (spyReflow) {
    Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() {
        if (this.classList.contains('sidebar')) {
          reflows.push({ transition: this.style.transition,
                         collapsed: this.classList.contains('collapsed') });
        }
        return 0;                            // what jsdom returns anyway
      },
    });
  }
  // startBudgetTick (app.js:495) reads this on line :497 — `typeof
  // window.__budgetTickMs === 'number' ? window.__budgetTickMs : 60000` — and
  // installs a setInterval that OUTLIVES the test (`.unref?.()` is a no-op in
  // jsdom, where setInterval returns a number). It runs once per module
  // evaluation, from the boot line at :14036, and this file boots the app 27
  // times. node --test runs FILES in parallel, so one file can outlive 60s under
  // load, and a leaked tick from an EXPANDED boot would call paintBudget()
  // against whatever globalThis.document is current and re-mount the labelled
  // indicator into a later COLLAPSED test's #side-spend. Park it a day out, and
  // do it BEFORE the import. Seam: test/ui-budget-indicator.test.mjs:89-91.
  window.__budgetTickMs = DAY;
  await import(pathToFileURL(appPath).href + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0));
  const recv = (obj) => lastWs._l.message.forEach((fn) => fn({ data: JSON.stringify(obj) }));
  lastWs._l.open?.forEach((fn) => fn());
  const click = (sel) => window.document.querySelector(sel)
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { window, recv, click, tick, reflows };
}

// ---- CSS contract: the shell ----

test('.sidebar animates its width; the collapsed rail is 76px', () => {
  const base = ruleBody('.sidebar');
  assert.ok(base, '.sidebar rule must exist');
  // ruleBody() is NOT @media-aware: with the base rule deleted it silently
  // returns the <1080px `.sidebar{display:none;}` body (style.css:922), so the
  // assert.ok above would pass on a file that lost the rule entirely.
  assert.doesNotMatch(base, /display:\s*none/,
    'ruleBody() matched the @media(max-width:1080px) body, not the base rule');
  assert.match(base, /width:\s*298px/, 'the expanded column is unchanged');
  assert.match(base, /overflow-y:\s*auto/, 'ui-pinned-sidebar:45-49 depends on this');
  // If this one fails on CSS that LOOKS right, you put a comment inside the rule
  // body and it contains a closing brace: ruleBody's capture is ([^}]*).
  assert.match(base, /transition:\s*flex-basis/, 'the width change must be animated');
  const rail = ruleBody('.sidebar.collapsed');
  assert.ok(rail, '.sidebar.collapsed rule must exist');
  assert.match(rail, /width:\s*76px/);
  assert.match(rail, /flex:\s*0 0 76px/);
});

test('the favicon replaces the wordmark on the rail', () => {
  assert.match(ruleBody('.brand .logo-mark'), /display:\s*none/, 'hidden while expanded');
  assert.match(ruleBody('.sidebar.collapsed .logo'), /display:\s*none/);
  assert.match(ruleBody('.sidebar.collapsed .logo-mark'), /display:\s*block/);
  // Attribute ORDER must not matter: `<img src=… class="logo-mark">` is the same
  // element. Match the tag, then assert inside it.
  const mark = html.match(/<span[^>]*class="logo-mark"[^>]*>/);
  assert.ok(mark, 'the rail mark <span class="logo-mark"> must exist (mask-painted, spec 2026-09-04 §4.4)');
  assert.match(mark[0], /role="img"/);
});

test('the expanded wordmark keeps its own sizing rule', () => {
  // `.brand` and `.brand .logo` are ADJACENT lines. Editing the wrong one
  // silently unsizes the expanded wordmark, and nothing else in the suite
  // covers `.brand .logo`.
  const logo = ruleBody('.brand .logo');
  assert.ok(logo, '.brand .logo must survive the .brand edit');
  assert.match(logo, /height:\s*34px/);
});

test('the toggle ends the wordmark row: the rail mark plus one bare chevron', () => {
  // The toggle lives in .brand after the mock pill (the pill's margin-right:auto parks it
  // at the row's end) — not in .side-foot, which keeps only the spend mount.
  const brand = html.match(/<div class="brand">[\s\S]*?id="side-close"/);
  assert.ok(brand, '.brand holds the toggle before the phone close button');
  const toggle = brand[0].match(/<button[^>]*id="side-toggle"[\s\S]*?<\/button>/);
  assert.ok(toggle, 'the toggle sits in .brand');
  assert.ok(brand[0].indexOf('side-mock-pill') < brand[0].indexOf('id="side-toggle"'), 'after the mock pill');
  assert.doesNotMatch(html.match(/<div class="side-foot">[\s\S]*?<\/aside>/)[0], /side-toggle/, 'nothing left in the foot');
  // The round mark rides inside the button (shown on the rail only), hidden from AT: the
  // button's aria-label names it.
  assert.match(toggle[0], /<span class="logo-mark side-toggle-mark" aria-hidden="true"><\/span>/);
  assert.equal((toggle[0].match(/<svg/g) || []).length, 1);
  // ONE path: both states are the same arrow with a rewritten `d`.
  assert.equal((toggle[0].match(/<path/g) || []).length, 1,
    'a lone chevron — anything else and it stops reading as an arrow');
  assert.doesNotMatch(toggle[0], /<rect/, 'the boxed panel glyph is gone');
  assert.match(toggle[0], /stroke-width="2"/);
  assert.match(toggle[0], /<path class="chev" d="M15 6l-6 6 6 6">/,
    'markup ships the expanded "<" — app.js only ever rewrites this one hook');
  // scaleX(-1) shifts a chevron's visual mass off centre; app.js swaps `d`.
  assert.doesNotMatch(ruleBody('.sidebar.collapsed .side-toggle svg'), /transform:/);
  // Expanded the mark is hidden; on the rail it shows and the bare mark beside it goes.
  assert.match(ruleBody('.brand .side-toggle-mark'), /display:\s*none/);
  assert.match(ruleBody('.sidebar.collapsed .side-toggle .side-toggle-mark'), /display:\s*block/);
  assert.match(ruleBody('.sidebar.collapsed .brand > .logo-mark'), /display:\s*none/);
});

test('the toggle stays OUT of <nav>, which keeps exactly 14 buttons (12 routes + the mode item + the Nodes disclosure)', () => {
  // ui-nav-sections.test.mjs:39 asserts this count, :40 forbids <a>, and :26-35
  // pins the token stream. A toggle inside <nav class="nav"> reds all three.
  const nav = html.match(/<nav class="nav"[\s\S]*?<\/nav>/)[0];
  assert.equal((nav.match(/<button type="button"/g) || []).length, 14);   // + interface mode, + Schedules, + Team policy, + Scripts, + the Nodes disclosure (Running + History merged into Runs)
  assert.equal(nav.includes('side-toggle'), false);
  assert.match(html, /<aside class="sidebar" id="side-rail">/,
    'aria-controls targets the whole aside — brand, nav AND the spend foot reshape');
});

// ---- CSS contract: the icon-rail nav ----

test('collapsed nav buttons become 40px squares and drop their labels', () => {
  const btn = ruleBody('.sidebar.collapsed .nav button');
  assert.ok(btn, 'the generic collapsed button rule');
  assert.match(btn, /width:\s*40px/);
  assert.match(btn, /height:\s*40px/);
  assert.match(btn, /justify-content:\s*center/);
  assert.match(btn, /position:\s*relative/, 'the corner badges are absolutely positioned');
  assert.match(btn, /flex:\s*0 0 auto/,
    '.nav is a column flex container; without this the 40px squares squash when '
    + 'the rail is taller than the viewport');
  assert.match(btn, /border-radius:\s*12px/, 'the base .nav button is 13px; the rail is 12px');
});

test('label spans are visually hidden but KEEP their accessible name', () => {
  const rule = '.sidebar.collapsed .nav button > span:not(.nav-count):not(.nav-rollup)';
  const body = ruleBody(rule);
  assert.ok(body, 'the label rule, which leaves the count badges alone');
  // display:none removes the node from the accessibility tree, and this span is
  // the ONLY source of an accessible name for every nav button (index.html
  // carries no aria-label on any of the 13 and the SVGs carry no <title> — the
  // file's only <title> is the document title at :6). Measured in Chrome:
  // eleven buttons announced with no name at all, and Running announced as "4"
  // (the count span survives, so name-from-contents wins and the title is
  // demoted to a description).
  assert.doesNotMatch(body, /display:\s*none/,
    'display:none strips the only accessible name these buttons have');
  assert.match(body, /position:\s*absolute/);
  assert.match(body, /clip(-path)?:/);
});

test('section headers collapse to hairlines but keep their text nodes', () => {
  const sect = ruleBody('.sidebar.collapsed .nav-sect');
  assert.ok(sect);
  assert.match(sect, /width:\s*26px/);
  assert.match(sect, /height:\s*1px/);
  assert.match(sect, /font-size:\s*0/);
  // The labels stay in the DOM because ui-nav-sections.test.mjs:26-35 asserts
  // their source order. They are NOT exposed as named a11y nodes in either
  // state — measured — so do not claim that as the reason.
  assert.match(html, /class="nav-sect">Activity</);
  assert.match(html, /class="nav-sect" data-min-level="advanced">Build</);
  assert.match(html, /class="nav-sect">Manage</);
});

test('counts become corner badges; inert grey ones drop out, and the Needs-you count hides the live one', () => {
  const badge = ruleBody('.sidebar.collapsed .nav-count');
  assert.ok(badge);
  assert.match(badge, /position:\s*absolute/);
  // Two SEPARATE rules, not one grouped selector. Grouped, the only thing a test
  // can reach is the selector TEXT — and a grouped-selector assertion was proven
  // vacuous: regrouping `.n-grey` with a no-op declaration and hiding the badge
  // elsewhere kept the test green while grey badges stopped hiding.
  const grey = ruleBody('.sidebar.collapsed .nav-count.n-grey');
  assert.ok(grey, 'zero/inert grey badges drop out on the rail');
  assert.match(grey, /display:\s*none/);
  // One badge on Runs (D11): the amber Needs-you count and the live count would
  // collide in the same corner, so while Needs-you shows, the live count hides.
  const hidden = ruleBody('#nav-needs-count:not([hidden]) + #nav-running-count');
  assert.ok(hidden, 'the Needs-you badge would collide with the live count in the same corner');
  assert.match(hidden, /display:\s*none/);
});

test('the nav does not jump vertically when the rail collapses', () => {
  // Measured in Chrome at 1440x900: .nav (and its first tile) sits at y=84 in
  // BOTH states. Expanded that is 26 (.sidebar padding-top) + 34 (.brand .logo)
  // + 24 (.brand margin-bottom). The rail has to reproduce the same sum with a
  // 32px round mark, so it keeps padding-top:26px and absorbs the 2px
  // difference in the gap: 26 + 32 + 26 = 84. Change any of the three and the
  // icons slide under the user's cursor on every toggle.
  assert.match(ruleBody('.brand'), /margin-bottom:\s*24px/);
  assert.match(ruleBody('.brand .logo'), /height:\s*34px/);
  assert.match(ruleBody('.brand .logo-mark'), /height:\s*32px/);
  assert.match(ruleBody('.sidebar'), /padding:\s*26px/);
  // Only the TOP number is part of this invariant — the bottom one belongs to
  // the toggle's spacing (ui-nav-sections) and moves independently.
  assert.match(ruleBody('.sidebar.collapsed'), /padding:\s*26px 18px \d+px/,
    'the rail must keep the expanded top padding');
  assert.match(ruleBody('.sidebar.collapsed .brand'), /margin-bottom:\s*26px/,
    '32px mark vs a 34px wordmark — the gap makes up the 2px so the sum lands on 84');
});

test('the rail stops reserving a scrollbar gutter it cannot afford', () => {
  const rail = ruleBody('.sidebar.collapsed');
  // ::-webkit-scrollbar{width:10px} (style.css:898) forces CLASSIC, space-
  // consuming scrollbars. The rail's own scroll height was measured at ~967px
  // with four runs, so on a 900px window the gutter is claimed: 76 - 1 border
  // - 36 padding - 10 gutter = a 29px content box, and the 40px squares sit 5px
  // left of centre. This is NOT horizontal overflow, so a scrollWidth probe
  // cannot see it.
  assert.match(rail, /scrollbar-width:\s*none/);
  assert.ok(ruleBody('.sidebar.collapsed::-webkit-scrollbar'),
    'Chrome ignores scrollbar-width while ::-webkit-scrollbar is styled');
  // If this fails on CSS that LOOKS right, you wrote a comment inside the rule
  // body that mentions overflow — ruleBody returns comment text verbatim.
  assert.doesNotMatch(rail, /overflow/,
    'the base overflow-y:auto must survive — the rail still scrolls, it just '
    + 'stops reserving the gutter');
  const foot = ruleBody('.sidebar.collapsed .side-foot');
  assert.ok(foot, 'the collapsed foot needs its own centring rule');
  assert.match(foot, /align-items:\s*center/);
  // On the rail .brand is a column: the toggle (the mark) goes first, above the mock pill
  // that precedes it in the markup.
  assert.match(ruleBody('.sidebar.collapsed .side-toggle'), /order:\s*-1/);
});

test('the width change is a transition, so reduced motion actually kills it', () => {
  // The blanket at style.css:914-916 is `*{transition:none !important;}` PLUS
  // `.pdot,.cur,.child-dot,.child-q{animation:none;}` — it neutralises every
  // TRANSITION but only four selectors' ANIMATIONS. So the pre-existing block is
  // sufficient only while the collapse stays a transition; a keyframed width
  // would sail straight past it for users who opted out. Both halves are
  // asserted, because pinning the blanket alone pins a block this plan never
  // touches and passes at red.
  assert.ok(/@media \(prefers-reduced-motion: reduce\)\{[\s\S]*?\*\{transition:none !important;\}/
    .test(css), 'the blanket transition kill must survive');
  assert.doesNotMatch(ruleBody('.sidebar'), /animation:/,
    'animate the rail with transition, not animation — the blanket does not '
    + 'cover animations outside .pdot/.cur/.child-dot/.child-q');
  assert.doesNotMatch(ruleBody('.sidebar.collapsed'), /animation:/);
});

// ---- Behaviour: state, toggle, persistence ----

test('boots expanded when nothing is stored', async () => {
  const { window } = await boot({ poisonToggle: true });
  assert.equal(window.document.querySelector('.sidebar').classList.contains('collapsed'), false);
  const btn = window.document.querySelector('#side-toggle');
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  assert.equal(btn.getAttribute('aria-label'), 'Collapse menu');
  assert.equal(btn.title, 'Collapse menu');
});

test('clicking the toggle collapses, relabels and persists', async () => {
  const { window, click } = await boot();
  click('#side-toggle');
  const btn = window.document.querySelector('#side-toggle');
  assert.equal(window.document.querySelector('.sidebar').classList.contains('collapsed'), true);
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  assert.equal(btn.getAttribute('aria-label'), 'Expand menu');
  assert.equal(btn.title, 'Expand menu');
  assert.equal(window.localStorage.getItem(KEY), '1');
});

test('clicking again expands and persists the expanded state', async () => {
  const { window, click } = await boot({ poisonToggle: true });
  click('#side-toggle');
  click('#side-toggle');
  assert.equal(window.document.querySelector('.sidebar').classList.contains('collapsed'), false);
  assert.equal(window.document.querySelector('#side-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(window.localStorage.getItem(KEY), '0');
});

test('the chevron points into the panel collapsed, out of it expanded', async () => {
  // Markup ships the expanded chevron, so a state that never re-set it would
  // still read correctly at boot — collapse first, then expand, to catch that.
  const { window, click } = await boot();
  const chev = () => window.document.querySelector('#side-toggle .chev').getAttribute('d');
  assert.equal(chev(), 'M15 6l-6 6 6 6', 'expanded points "<" — click pulls the rail in');
  click('#side-toggle');
  assert.equal(chev(), 'M9 6l6 6-6 6', 'collapsed points ">" — click pushes it back out');
  click('#side-toggle');
  assert.equal(chev(), 'M15 6l-6 6 6 6');
});

test('a stored "1" restores the rail at boot', async () => {
  const { window } = await boot({ seed: { [KEY]: '1' } });
  assert.equal(window.document.querySelector('.sidebar').classList.contains('collapsed'), true);
  assert.equal(window.document.querySelector('#side-toggle').getAttribute('aria-expanded'), 'false');
});

test('the restored rail does not animate at boot', async () => {
  // app.js is type="module" (index.html:1379), i.e. deferred, so the class lands
  // AFTER the first style pass and `.sidebar`'s .2s width/flex-basis transition
  // (style.css:84-85) fires: measured in headless Chrome, the rail slid
  // 298px -> 76px on every single page load, 3/3. The fix is the ordering at
  // app.js:411-417, and `void rail.offsetWidth` reads exactly like dead code to
  // the next reader — deleting it, or hoisting applySidebarCollapsed() above the
  // `transition='none'` write, keeps the rest of this file green.
  const { window, reflows } = await boot({ seed: { [KEY]: '1' }, spyReflow: true });
  assert.deepEqual(reflows, [{ transition: 'none', collapsed: true }],
    'the boot restore must flush layout exactly once, with the collapsed class '
    + 'already ON and the transition suppressed');
  assert.equal(window.document.querySelector('.sidebar').style.transition, '',
    'and hand the transition back afterwards, so the CLICK still animates');
});

test('an expanded boot has nothing to suppress and flushes nothing', async () => {
  // `railAtBoot` is null unless the preference was restored: a blanket flush
  // would cost a synchronous layout on every load of the common case.
  const { window, reflows } = await boot({ spyReflow: true });
  assert.deepEqual(reflows, []);
  assert.equal(window.document.querySelector('.sidebar').style.transition, '');
});

test('a garbage stored value falls back to expanded', async () => {
  const { window } = await boot({ seed: { [KEY]: 'yes' } });
  assert.equal(window.document.querySelector('.sidebar').classList.contains('collapsed'), false);
});

test('storage that throws (private mode) boots expanded and still toggles', async () => {
  const { window, click } = await boot({ breakStorage: true });
  assert.equal(window.document.querySelector('.sidebar').classList.contains('collapsed'), false);
  click('#side-toggle');
  assert.equal(window.document.querySelector('.sidebar').classList.contains('collapsed'), true,
    'a write that throws must not stop the in-memory state from flipping');
});

// ---- Behaviour: tooltips, counts, routing ----

test('every collapsed nav button gains a tooltip, and loses it on expand', async () => {
  const { window, click } = await boot();
  const doc = window.document;
  const rows = () => [...doc.querySelectorAll('.nav button[data-nav]')]
    .map((b) => [b.dataset.nav, b.title]);
  assert.deepEqual(rows().filter(([n, t]) => n !== 'runs' && t), [],
    'expanded rows must not grow redundant tooltips — the label is right there');
  click('#side-toggle');
  for (const [nav, title] of rows()) assert.ok(title, `collapsed ${nav} must carry a tooltip`);
  assert.equal(doc.querySelector('.nav button[data-nav="composer"]').title, 'Workflow Composer',
    'the tooltip is the label span verbatim — index.html:55');
  assert.equal(doc.querySelector('.nav button[data-nav="new"]').title, 'New pipeline');
  assert.equal(doc.querySelector('.nav button[data-nav="stats"]').title, 'Statistics',
    'the tooltip is the SIDEBAR label, Statistics (index.html)');
  assert.match(doc.querySelector('.nav button[data-nav="runs"]').title, /^Runs/,
    'Runs keeps the count tooltip updateNavCounts owns (set at boot by '
    + 'refreshAllCounts, app.js:14034)');
  click('#side-toggle');
  assert.equal(doc.querySelector('.nav button[data-nav="composer"]').hasAttribute('title'), false);
});

test('the live count still updates on the rail (n-grey hides only the inert ones)', async () => {
  const { window, recv } = await boot({ seed: { [KEY]: '1' } });
  recv({ type: 'hello', runs: [
    { runId: 'a', title: 'a', projectDir: PROJECT, status: 'running', kind: 'run',
      startedAt: '10:00:00', pendingQuestion: null }] });
  const c = window.document.querySelector('#nav-running-count');
  assert.equal(c.textContent, '1');
  // updateNavCounts (app.js:13788-13789) toggles n-run on live>0 and n-grey on
  // live===0. Only .n-grey is hidden on the rail.
  assert.ok(c.classList.contains('n-run'), 'the live badge survives; only .n-grey drops out');
  assert.equal(c.classList.contains('n-grey'), false);
});

test('the Runs tooltip carries the Needs-you and live counts', async () => {
  const { window, recv } = await boot();
  recv({ type: 'hello', runs: [
    { runId: 'a', title: 'a', projectDir: PROJECT, status: 'running', kind: 'run',
      startedAt: '10:00:00', pendingQuestion: null },
    { runId: 'b', title: 'b', projectDir: PROJECT, status: 'paused', kind: 'run',
      startedAt: '10:00:00', pendingQuestion: null },
  ] });
  const btn = window.document.querySelector('.nav button[data-nav="runs"]');
  // A paused run needs you (D5). The rail shows one badge, so both counts have to survive here.
  assert.equal(btn.title, 'Runs — 1 needs you, 1 live',
    'the live badge hides behind the Needs-you one, so its count has to survive here');
  assert.equal(btn.getAttribute('aria-label'), 'Runs — 1 needs you, 1 live',
    'a title is a DESCRIPTION; name-from-contents would otherwise announce "1"');
});

test('with nothing needing you the tooltip names only the live count', async () => {
  const { window, recv } = await boot();
  recv({ type: 'hello', runs: [
    { runId: 'a', title: 'a', projectDir: PROJECT, status: 'running', kind: 'run',
      startedAt: '10:00:00', pendingQuestion: null },
  ] });
  assert.equal(window.document.querySelector('.nav button[data-nav="runs"]').title,
    'Runs — 1 live');
});

test('with nothing running at all the tooltip degrades to the bare label', async () => {
  const { window, recv } = await boot();
  recv({ type: 'hello', runs: [] });
  // "Runs — 0 live" on a resting sidebar is noise, and zero is the state most
  // users are in most of the time. Expanded, the label is on screen, so a tooltip saying
  // only "Runs" would repeat it: none then; the collapsed rail (no label) keeps it.
  const b = window.document.querySelector('.nav button[data-nav="runs"]');
  assert.equal(b.getAttribute('aria-label'), 'Runs');
  assert.equal(b.title, b.closest('.sidebar.collapsed') ? 'Runs' : '');
});

test('paused-only names the Needs-you count without a phantom live one', async () => {
  const { window, recv } = await boot();
  recv({ type: 'hello', runs: [
    { runId: 'p', title: 'p', projectDir: PROJECT, status: 'paused', kind: 'run',
      startedAt: '10:00:00', pendingQuestion: null }] });
  // liveRuns() excludes status 'paused', so live really is 0 — and a zero part is dropped.
  assert.equal(window.document.querySelector('.nav button[data-nav="runs"]').title,
    'Runs — 1 needs you');
});

test('a collapsed nav button still routes', async () => {
  const { window, click, tick } = await boot({ seed: { [KEY]: '1' } });
  click('.nav button[data-nav="runs"]');
  await tick();
  assert.equal(window.location.hash, '#runs');
  assert.ok(window.document.querySelector('.nav button[data-nav="runs"]')
    .classList.contains('active'));
});

test('the toggle still works after a view switch and a repaint', async () => {
  const { window, click, tick } = await boot();
  click('.nav button[data-nav="runs"]');
  await tick();
  click('#side-toggle');
  assert.equal(window.document.querySelector('.sidebar').classList.contains('collapsed'), true,
    'the boot-time listener must survive a view switch');
});

test('toggling before the first hello or budget response does not throw', async () => {
  const { window, click } = await boot({ noBudget: true });
  // jsdom does NOT propagate a listener exception out of dispatchEvent, and
  // applySidebarCollapsed() runs before the three risky calls — so a bare click
  // plus a `.collapsed` assertion passes even with a throw appended to the end
  // of setSidebarCollapsed (verified). It DOES report the exception as a window
  // `error` event, which is the only seam that can see one.
  const errs = [];
  window.addEventListener('error', (e) => errs.push(e.error?.message || e.message));
  click('#side-toggle');   // updateNavCounts + renderPipelineTabs + paintBudget
  assert.deepEqual(errs, [],
    'all three repaints have to survive a null budget and an empty run list');
  assert.equal(window.document.querySelector('.sidebar').classList.contains('collapsed'), true);
  // paintBudget early-returns at app.js:369 before touching the mount, and
  // index.html:94 ships <div id="side-spend"></div> empty.
  assert.equal(window.document.querySelector('#side-spend').children.length, 0);
});

// ---- Task 3: circular budget indicator ----

test('the ring is 38px, composes its arc from --ring-pct, and recolours by band', () => {
  const ring = ruleBody('.spend-ring');
  assert.ok(ring, '.spend-ring rule must exist');
  assert.match(ring, /width:\s*38px/);
  assert.match(ring, /border-radius:\s*50%/);
  assert.match(ring, /conic-gradient/, 'the arc is drawn in CSS, not as an inline background');
  assert.match(ring, /var\(--ring-pct\)/, 'one definition of the gradient, swappable by class');
  assert.match(ruleBody('.spend-ring.warn'), /--ring-fill:\s*var\(--amber-ink\)/);
  assert.match(ruleBody('.spend-ring.over'), /--ring-fill:\s*var\(--red-ink\)/);
  assert.equal(css.includes('.spend-ring.no-limit'), false,
    'no total limit renders the Spent/Saved stack now; a no-limit ring rule would be dead CSS');
});

// ---- the Spent/Saved stack (collapsed rail, no total limit) ----

test('the stack is a 40px column that overrides the block card and never wraps an amount', () => {
  const stack = ruleBody('.spend-stack');
  assert.ok(stack, '.spend-stack rule must exist');
  assert.match(stack, /display:\s*flex/, '.spend-ind is display:block — the stack must restate it');
  assert.match(stack, /flex-direction:\s*column/);
  assert.match(stack, /width:\s*40px/, 'the width of every rail square: wider would overhang the 39px box');
  assert.match(stack, /padding:\s*7px 0/, '.spend-ind pads 12px a side — 24px of a 40px column');
  // Equal specificity (0,1,0): the stack can only beat .spend-ind's display/width/padding on order.
  assert.ok(css.indexOf('.spend-ind{') < css.indexOf('.spend-stack{'),
    'equal specificity — it can only win on source order');
  assert.match(ruleBody('.spend-stack-val'), /white-space:\s*nowrap/);
  assert.match(ruleBody('.spend-stack-val'), /font-size:\s*10px/, 'six glyphs of 10px mono = 36px < 38px');
  assert.match(ruleBody('.spend-stack-val'), /font-family:\s*var\(--mono\)/);
  assert.match(ruleBody('.spend-stack-lbl'), /text-transform:\s*uppercase/);
  assert.match(ruleBody('.spend-stack-lbl'), /color:\s*var\(--ink-2\)/,
    'not --ink-3: 2.6:1 on --field is unreadable at 9px');
  // Base amounts are --ink (Spent, and a loss). A gain is --green-ink-strong, never
  // --green-ink: that measures 4.48:1 on the --line hover fill, and verify:theme fails
  // anything under 4.5:1 (measured, v1 dry run). No red variant: --red-ink is 4.07:1.
  assert.match(ruleBody('.spend-stack-val'), /color:\s*var\(--ink\)/);
  assert.match(ruleBody('.spend-ind-amt'), /color:\s*var\(--ink\)/);
  assert.match(ruleBody('.spend-ind-saved.pos .spend-ind-label,.spend-ind-saved.pos .spend-ind-amt'),
    /color:\s*var\(--green-ink-strong\)/);
  assert.match(ruleBody('.spend-stack-pair.pos .spend-stack-lbl,.spend-stack-pair.pos .spend-stack-val'),
    /color:\s*var\(--green-ink-strong\)/);
  assert.match(css, /--green-ink-strong:\s*light-dark\(#2C7535,/, '4.79:1 on --line (light)');
  assert.doesNotMatch(css, /\.spend-(?:stack|ind)[\w-]*\.(?:is-)?neg\b/,
    'no red variant for the sidebar amounts');
  assert.match(ruleBody('.spend-ind-saved'), /margin-top:\s*6px/);
});

test('no total limit: the rail mounts the Spent/Saved stack, and expanding restores the two-row block', async () => {
  const { window, click } = await boot({ seed: { [KEY]: '1' },
    budgetOver: { totalLimitUsd: null, remainingUsd: null, windowSpendUsd: 10604.7,
      windowHumanHours: 1512, windowSavedUsd: 42315.3 } });
  const doc = window.document;
  const stack = doc.querySelector('#side-spend .spend-stack');
  assert.ok(stack, 'collapsed + no limit mounts the stack');
  assert.equal(doc.querySelector('#side-spend .spend-ring'), null, 'and no ring');
  assert.deepEqual([...stack.querySelectorAll('.spend-stack-val')].map((v) => v.textContent),
    ['$11k', '$42k']);

  click('#side-toggle');
  assert.equal(doc.querySelector('#side-spend .spend-stack'), null);
  const rows = [...doc.querySelectorAll('#side-spend .spend-ind-row')];
  assert.deepEqual(rows.map((r) => r.querySelector('.spend-ind-label').textContent),
    ['Spent this month', 'Saved this month']);
  assert.equal(rows[1].querySelector('.spend-ind-amt').textContent, '$42,315.30');
  assert.doesNotMatch(doc.querySelector('#side-spend').textContent, /no total limit/i);
});

test('clicking inside the stack really routes to #stats', async () => {
  const { window } = await boot({ seed: { [KEY]: '1' },
    budgetOver: { totalLimitUsd: null, remainingUsd: null, windowSavedUsd: 5 } });
  window.location.hash = 'running';
  window.document.querySelector('#side-spend .spend-stack-val')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(window.location.hash, '#stats');
});

test('hovering the ring keeps its arc', () => {
  // `.spend-ind:hover` (style.css:1609) is (0,2,0) and a bare `.spend-ring` is
  // (0,1,0), so its flat `background:var(--line)` WINS on specificity — source
  // order never gets consulted. Measured in Chrome without this rule:
  // background-image goes to `none` and the disc turns a flat neutral fill.
  const hov = ruleBody('.spend-ring:hover');
  assert.ok(hov, '.spend-ring:hover must exist or the arc dies on every hover');
  assert.match(hov, /conic-gradient/);
  assert.match(hov, /var\(--ring-pct\)/);
  assert.ok(css.indexOf('.spend-ind:hover') < css.indexOf('.spend-ring:hover'),
    'equal specificity — it can only win on source order');
});

test('the foot swaps the spend block for the ring and back', async () => {
  const { window, click } = await boot({ seed: { [KEY]: '1' } });
  const doc = window.document;
  assert.ok(doc.querySelector('#side-spend .spend-ring'), 'collapsed boot mounts the ring');
  assert.equal(doc.querySelector('#side-spend .spend-ind-row'), null,
    'the labelled block must not also be mounted');
  assert.equal(doc.querySelector('#side-spend .spend-ring-val').textContent, '40%');

  click('#side-toggle');
  assert.equal(doc.querySelector('#side-spend .spend-ring'), null);
  assert.ok(doc.querySelector('#side-spend .spend-ind-row'), 'expanding restores the block');
});

test('clicking the ring really routes to #stats, not just carrying the class', async () => {
  const { window } = await boot({ seed: { [KEY]: '1' } });
  window.location.hash = 'running';
  // Click the INNER span: app.js:517 resolves it via closest('.spend-ind'),
  // so a ring that merely looks right but drops the class fails here. Asserting
  // the classList alone asserts the PREMISE of the routing, never the routing.
  window.document.querySelector('#side-spend .spend-ring-val')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(window.location.hash, '#stats');
});

// ---- The rest of the block: no rule here is reachable by NAME alone ----

test('every remaining new rule carries the declarations it exists for', () => {
  // Each rule below was emptied one at a time and the rest of this file stayed
  // green, which is the same vacuity the grouped-selector note at style.css:2604
  // warns about: a test that only proves a selector EXISTS proves nothing.
  const mark = (sel, ...pats) => {
    const body = ruleBody(sel);
    assert.ok(body, `${sel} must exist`);
    for (const p of pats) assert.match(body, p, `${sel} lost ${p}`);
  };
  // The favicon the rail shows instead of the wordmark; display is pinned above.
  mark('.brand .logo-mark', /width:\s*32px/, /height:\s*32px/, /border-radius:\s*50%/);
  // The toggle is a bare glyph at the end of the wordmark row; on the rail it is the mark
  // plus a small ">" whose negative margins keep the mark where the bare mark sat.
  mark('.side-toggle', /width:\s*30px/, /height:\s*30px/, /border:\s*0/,
    /background:\s*transparent/);
  mark('.sidebar.collapsed .side-toggle', /width:\s*auto/, /padding:\s*3px/,
    /margin:\s*-3px -18px -3px -3px/, /border-radius:\s*12px/);
  mark('.side-toggle svg', /width:\s*20px/, /height:\s*20px/);
  mark('.sidebar.collapsed .side-toggle svg', /width:\s*14px/, /height:\s*14px/);
  // Both flex columns centre their fixed-width children; without this the 40px
  // squares sit left-aligned in a 39px content box.
  mark('.sidebar.collapsed .nav', /align-items:\s*center/);
  mark('.sidebar.collapsed .nav-children', /align-items:\s*center/);
  // New pipeline is the rail's one filled control (mock); outlined-at-rest only
  // reads as a button next to a label.
  mark('.sidebar.collapsed .nav button.nav-cta', /background:\s*var\(--ink\)/,
    /(?:^|[;{\s])color:\s*var\(--on-ink\)/);
  // The ring's inner disc: without the --panel fill the conic-gradient covers
  // the whole 38px circle and there is no annulus.
  mark('.spend-ring-val', /width:\s*29px/, /border-radius:\s*50%/,
    /background:\s*var\(--panel\)/);
});
