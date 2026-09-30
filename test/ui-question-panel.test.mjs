// test/ui-question-panel.test.mjs — the redesigned clarify/gate/recovery panel
// (design §4.3 + §5.4): amber wash on the card, numbered ink circles (19px card /
// 22px detail), lettered key squares that turn ink with a check when picked, a
// free-text field that turns white-on-ink once it holds a non-option value, a
// right-aligned footer, and the card-only "Open run" button. On the run page the
// ask cards follow the "Worca Ask Cards Redesign" canvas (see the section below).
//
// ruleBody() is a verbatim copy of test/ui-run-flow-css.test.mjs:17-21.
// boot()/dispatch()/showRunning() are a verbatim copy of test/ui-question.test.mjs:19-82.
// The suites do not import each other — this duplication is the house convention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '../ui/public/style.css'), 'utf8');

// ANCHORED, as in test/ui-running-routing.test.mjs:28-32. A bare first-match
// regex reads `.qblock > .qfree{` as a match for `.qfree` and hands back the
// wrong body — which is why the stylesheet used to carry a prose rule forbidding
// anyone from reordering those two declarations. The leading class makes the
// helper, not the author, responsible for that.
function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp('(?:^|[\\s,}])' + escaped + '\\s*\\{([^}]*)\\}'));
  return m ? m[1] : null;
}

const htmlPath = fileURLToPath(new URL('../ui/public/index.html', import.meta.url));
const appPath = fileURLToPath(new URL('../ui/public/app.js', import.meta.url));

async function boot({ fetchHandler } = {}) {
  const dom = new JSDOM(readFileSync(htmlPath, 'utf8'), { url: 'http://localhost:4317/' });
  const { window } = dom;

  const wsBox = { ws: null };
  window.WebSocket = class {
    constructor() {
      this.readyState = 1; // OPEN — app.js gates backfill subscribes on wsReady
      this._listeners = {};
      wsBox.ws = this;
    }
    send() {}
    close() {}
    addEventListener(type, fn) {
      (this._listeners[type] ||= []).push(fn);
    }
    dispatch(type, evt) {
      (this._listeners[type] || []).forEach((fn) => fn(evt));
    }
  };

  const calls = [];
  window.fetch = (url, opts) => {
    calls.push({ url: String(url), opts: opts || {} });
    if (fetchHandler) {
      const r = fetchHandler(String(url), opts || {});
      if (r) return r;
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ projects: [], config: { steps: {}, customModels: [] }, models: [], efforts: [] }),
    });
  };

  for (const k of ['window', 'document', 'location', 'localStorage', 'WebSocket', 'fetch', 'navigator']) {
    try {
      Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true });
    } catch {
      /* read-only global already present — leave it */
    }
  }
  globalThis.window = window;
  globalThis.document = window.document;

  await import(pathToFileURL(appPath).href + `?b=${Date.now()}_${Math.random()}`);
  await new Promise((r) => setTimeout(r, 0));

  function dispatch(msg) {
    wsBox.ws.dispatch('message', { data: JSON.stringify(msg) });
  }
  function showRunning() {
    window.location.hash = 'running';
    window.dispatchEvent(new window.Event('hashchange'));
  }

  return { window, dispatch, showRunning, calls, wsBox };
}

const RUN_ID = 'run-qp-1';

function seedClarify(ctx) {
  ctx.wsBox.ws.dispatch('open', {});
  ctx.dispatch({
    type: 'hello',
    runs: [{ runId: RUN_ID, title: 'Demo run', projectDir: '/tmp/p', status: 'running',
      startedAt: '2026-01-01T00:00:00Z', kind: 'run' }],
  });
  ctx.showRunning();
  ctx.dispatch({
    type: 'question', runId: RUN_ID, id: 'clarify-1', kind: 'clarify',
    questions: [
      { id: 'q1', question: 'Where to store sessions?', options: ['Redis', 'Postgres', ''], allowFreeText: true },
    ],
  });
}

// ---------------------------------------------------------------------------
// CSS locks (jsdom computes no layout — assert on the stylesheet text)
// ---------------------------------------------------------------------------

test('the four question-panel tokens exist', () => {
  const root = ruleBody(':root');
  assert.ok(root, ':root block missing');
  assert.match(root, /--amber-wash:\s*light-dark\(#FEF7EC,/i);
  assert.match(root, /--amber-wash-2:\s*light-dark\(#FEFAF3,/i);
  assert.match(root, /--amber-line:\s*light-dark\(#F5D9A8,/i);
  assert.match(root, /--radio-ring:\s*light-dark\(#D6D6D2,/i);
});

test('.qpanel is the amber card variant and no longer shares its rules with the dead .q-* twins', () => {
  const body = ruleBody('.qpanel');
  assert.ok(body, '.qpanel rule missing');
  assert.match(body, /background:\s*var\(--amber-wash\)/, 'card panel uses the amber wash');
  assert.match(body, /border:\s*1px solid var\(--amber-bg\)/);
  assert.match(body, /border-radius:\s*var\(--r-ctrl\)/, 'nested in the run card, so the inner radius');
  assert.ok(!/#FFFDF8/i.test(css), 'the old hardcoded wash is gone');
  // Comment-blind: strip comments first so prose can never fail the sweep.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // `.q-free` covers the three 649-655 arms (`.q-free input`, `.q-free-label`,
  // `.q-free`) that v2's list missed; `.qfree` (the LIVE class) does not contain
  // the substring, so it is not caught by mistake.
  for (const dead of ['.question-card', '.q-option', '.q-options', '.q-question',
    '.q-block', '.q-free', '.q-submit-row'])
    assert.ok(!bare.includes(dead), `dead selector ${dead} still present`);
});

test('card number circles are 19px, detail circles are 22px', () => {
  const card = ruleBody('.qtext .qn');
  assert.ok(card, '.qtext .qn rule missing');
  assert.match(card, /width:\s*19px/);
  assert.match(card, /height:\s*19px/);
  assert.match(card, /background:\s*var\(--ink\)/);
  const detail = ruleBody('.rd-questions .qtext .qn');
  assert.ok(detail, '.rd-questions .qtext .qn rule missing');
  assert.match(detail, /width:\s*22px/);
  assert.match(detail, /height:\s*22px/);
});

test('an option leads with its letter key; a picked one turns ink with a knocked-out check', () => {
  const key = ruleBody('.qopt::before');
  assert.ok(key, '.qopt::before key missing');
  assert.match(key, /content:\s*attr\(data-key\)/, 'the key square prints the option letter');
  assert.doesNotMatch(key, /border-radius:\s*50%/, 'a rounded square, not the old radio');
  assert.match(key, /background:\s*var\(--field\)/);

  const sel = ruleBody('.qopt.sel');
  assert.ok(sel, '.qopt.sel rule missing');
  assert.match(sel, /border-color:\s*var\(--ink\)/, 'the design picks ink, not green');
  assert.doesNotMatch(sel, /--green/);

  const on = ruleBody('.qopt.sel::before');
  assert.ok(on, '.qopt.sel::before missing');
  assert.match(on, /content:\s*''/, 'the letter gives way to the check');
  assert.match(on, /background:\s*var\(--ink\)/);
  // The check is a HOLE in the ink square, so it shows the tile's own panel colour in
  // both themes — a painted white check would vanish on the dark theme's light ink.
  assert.match(on, /-webkit-mask:url\("data:image\/svg\+xml/);
  assert.match(on, /(?:^|;)\s*mask:url\("data:image\/svg\+xml/);
});

test('the free-text field turns white with an ink border once it holds a value', () => {
  const base = ruleBody('.qfree');
  assert.ok(base, '.qfree rule missing');
  assert.match(base, /background:\s*var\(--field\)/);
  const has = ruleBody('.qfree.has');
  assert.ok(has, '.qfree.has rule missing');
  assert.match(has, /background:\s*var\(--panel\)/);
  assert.match(has, /border-color:\s*var\(--ink\)/);
  assert.match(ruleBody('.qfree:focus'), /border-color:\s*var\(--ink\)/);
});

test('the footer is right-aligned on both surfaces; the detail panel is a white card that rises', () => {
  const foot = ruleBody('.qpanel-foot');
  assert.ok(foot, '.qpanel-foot rule missing');
  assert.match(foot, /justify-content:\s*flex-end/);
  const detail = ruleBody('.rd-questions .qpanel');
  assert.ok(detail, '.rd-questions .qpanel rule missing');
  assert.match(detail, /background:\s*var\(--panel\)/, 'the ask card is white, not the amber wash');
  assert.match(detail, /border:\s*1px solid var\(--line\)/);
  assert.match(detail, /box-shadow:\s*var\(--shadow\)/);
  // The rise lives on the WRAPPER (Task 6's `.rd-questions`), not on the panel:
  // animating both nests the transform and doubles the travel and the fade.
  assert.match(ruleBody('.rd-questions'), /animation:wr-rise/);
  assert.doesNotMatch(detail, /animation:/, 'the panel must not re-animate its own wrapper\'s entrance');
});

// ---------------------------------------------------------------------------
// The run page's ask cards (the "Worca Ask Cards Redesign" canvas): one white
// card per question, the question beside its answers, a pill footer below.
// ---------------------------------------------------------------------------

const CARDS = '.rd-questions .qpanel:is([data-kind="clarify"],[data-kind="form"])';
const SINGLE = '.rd-questions .qpanel:is([data-kind="gate"],[data-kind="recovery"])';

test('clarify and form panels shed their own card on the run page; each question is the card', () => {
  const shell = ruleBody(CARDS);
  assert.ok(shell, `${CARDS} rule missing`);
  assert.match(shell, /background:\s*none/);
  assert.match(shell, /border:\s*0/);
  assert.match(shell, /padding:\s*0/);
  assert.match(shell, /box-shadow:\s*none/);
  assert.match(shell, /gap:\s*14px/, 'the cards stand apart');

  const card = ruleBody('.rd-questions .qblock');
  assert.ok(card, '.rd-questions .qblock rule missing');
  assert.match(card, /background:\s*var\(--panel\)/);
  assert.match(card, /border:\s*1px solid var\(--line\)/);
  assert.match(card, /box-shadow:\s*var\(--shadow\)/);
  assert.match(card, /grid-template-columns:\s*380px minmax\(0,\s*1fr\)/, 'the question beside its answers');
  const q = ruleBody('.rd-questions .qtext');
  assert.match(q, /grid-column:\s*1/);
  assert.match(q, /font-weight:\s*500/, 'a question reads medium, not semibold: some run a whole paragraph');
  assert.match(q, /font-size:\s*16px/);
  // A long question spans both answer rows; the flexible second row soaks up its extra
  // height, so the options and the write-your-own row stay packed at the top.
  assert.match(card, /grid-template-rows:\s*auto 1fr/);
  assert.match(ruleBody('.rd-questions .qopts'), /grid-column:\s*2/);
  assert.match(ruleBody('.rd-questions .qblock > .qfree'), /grid-column:\s*2/);

  const form = ruleBody('.rd-questions .qpanel[data-kind="form"] .af-form');
  assert.ok(form, 'the form card rule is missing');
  assert.match(form, /background:\s*var\(--panel\)/);
  assert.match(form, /box-shadow:\s*var\(--shadow\)/);
});

test('the first question card keeps its top padding', () => {
  // The old "no gap above the first block" rule outranked the card's padding (0,5,0 vs 0,2,0).
  assert.ok(!/\.qblock:first-of-type/.test(css), 'no first-block padding reset left');
  // Same trap for the form: its card is the body's first child, and the flush-top reset
  // (0,5,0) would zero the card's own padding (0,4,0) — only the margin may go.
  const reset = ruleBody('.rd-glance > .rd-questions .qpanel .qbody > :first-child');
  assert.ok(reset, 'the flush-top reset is still there');
  assert.doesNotMatch(reset, /padding/, 'the form card keeps its top padding');
});

test('below the cards the footer is a white pill bar', () => {
  const pill = ruleBody(`${CARDS} .qpanel-foot`);
  assert.ok(pill, 'the pill footer rule is missing');
  assert.match(pill, /border-radius:\s*999px/);
  assert.match(pill, /background:\s*var\(--panel\)/);
  assert.match(pill, /box-shadow:\s*var\(--shadow\)/);
  assert.match(pill, /(?:^|;)\s*border:\s*1px solid var\(--line\)/, 'the in-card divider gives way to the pill outline');
});

test('an answered question says so beside its number, from the picked state alone', () => {
  const pill = ruleBody('.rd-questions .qblock:has(.qopt.sel,.qfree.has) .qtext::after');
  assert.ok(pill, 'the Answered pill rule is missing');
  assert.match(pill, /content:\s*'Answered'/);
  assert.match(pill, /var\(--green-bg\)/);
});

test('the other-answer row reads as a dashed tile until it holds a value', () => {
  const other = ruleBody('.rd-questions .qblock > .qfree');
  assert.match(other, /border-style:\s*dashed/);
  assert.match(other, /min-height:\s*52px/);
  assert.match(ruleBody('.rd-questions .qblock > .qfree:is(:focus,.has)'), /border-style:\s*solid/);
});

test('gate and recovery put their decision beside the evidence, one column when there is none', () => {
  const grid = ruleBody(SINGLE);
  assert.ok(grid, `${SINGLE} rule missing`);
  assert.match(grid, /display:\s*grid/);
  assert.match(grid, /grid-template-columns:\s*380px minmax\(0,\s*1fr\)/);
  assert.match(ruleBody(`${SINGLE} > :is(.issues,.issue-detail)`), /grid-column:\s*2/);
  assert.match(ruleBody(`${SINGLE} > .qpanel-foot`), /grid-column:\s*1\s*\/\s*-1/);
  assert.match(ruleBody(`${SINGLE}:not(:has(> .issues,> .issue-detail))`), /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test('an issue row is a severity column beside its text, with no coloured stripe', () => {
  const row = ruleBody('.rd-questions .issue');
  assert.ok(row, '.rd-questions .issue rule missing');
  assert.match(row, /grid-template-columns:\s*92px minmax\(0,\s*1fr\)/);
  assert.match(row, /border-color:\s*var\(--line\)/, 'the per-severity left stripe is gone');
  assert.match(row, /border-left-width:\s*1px/);
  assert.match(ruleBody('.rd-questions .issue-head'), /display:\s*contents/);
  // After the .sev-* stripe rules, so equal specificity resolves to the neutral border.
  assert.ok(css.indexOf('.rd-questions .issue{') > css.indexOf('.issue.sev-suggestion{'));
});

test('the ask heading is the page\'s section title, led by an amber icon', () => {
  assert.match(ruleBody('.rd-ask-head'), /font:\s*600 18px/, 'a section title, not louder than the run name');
  const disc = ruleBody('.rd-ask-head::before');
  assert.ok(disc, '.rd-ask-head::before missing');
  assert.match(disc, /background:\s*var\(--amber-bg\)/);
  assert.match(disc, /border-radius:\s*50%/);
  const glyph = ruleBody('.rd-ask-head::after');
  assert.ok(glyph, '.rd-ask-head::after missing');
  assert.match(glyph, /background:\s*var\(--amber-ink\)/);
  assert.match(glyph, /mask:url\("data:image\/svg\+xml/);
});

test('narrow screens stack the question over its answers', () => {
  const m = css.match(/@media \(max-width:1080px\)\{\s*\.rd-questions \.qblock[^{]*\{([^}]*)\}/);
  assert.ok(m, 'no narrow-screen stack for the question cards');
  assert.match(m[1], /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test('the panel is stamped with the kind it draws, on the card and the detail', async () => {
  const ctx = await boot();
  seedClarify(ctx);
  const card = ctx.window.document.querySelector(`.run-card[data-run-id="${RUN_ID}"] .qpanel`);
  assert.equal(card.dataset.kind, 'clarify');
  ctx.window.location.hash = `running/${RUN_ID}`;
  ctx.window.dispatchEvent(new ctx.window.Event('hashchange'));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ctx.window.document.querySelector('#run-detail .rd-questions .qpanel').dataset.kind, 'clarify');

  ctx.dispatch({ type: 'question', runId: RUN_ID, id: 'gate-1', kind: 'gate',
    issues: [{ severity: 'major', title: 'Broken', detail: 'd' }] });
  assert.equal(ctx.window.document.querySelector('#run-detail .rd-questions .qpanel').dataset.kind, 'gate',
    'a new kind re-stamps the same node');
});

// ---------------------------------------------------------------------------
// Behaviour: the card-only "Open run" button
// ---------------------------------------------------------------------------

test('the clarify footer offers "Open run" beside Submit, and it navigates', async () => {
  const ctx = await boot();
  seedClarify(ctx);

  const card = ctx.window.document.querySelector(`.run-card[data-run-id="${RUN_ID}"]`);
  const foot = card.querySelector('.qpanel-foot');
  assert.ok(foot, 'footer present');
  const open = foot.querySelector('.qopen');
  assert.ok(open, '.qopen present on the card');
  assert.equal(open.textContent, 'Open run');
  assert.equal(open.type, 'button');
  // Open run sits DIRECTLY BEFORE Submit (§4.3: secondary beside the primary).
  // Asserted as a relative pair, not as absolute indices: Step 11 of this same
  // task prepends the "N of M answered" counter as the footer's FIRST child, and
  // C8 forbids that step from rewriting the case written here — so `order[0]`
  // would break the moment the counter lands.
  const order = [...foot.children].map((n) => n.className);
  const iOpen = order.findIndex((c) => c.includes('qopen'));
  const iGo = order.findIndex((c) => c.includes('btn-go'));
  assert.ok(iOpen >= 0, '.qopen is in the footer');
  assert.equal(iGo, iOpen + 1, `Submit answers & resume follows Open run (got ${order.join(',')})`);

  open.dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
  assert.equal(ctx.window.location.hash.replace(/^#/, ''), `running/${RUN_ID}`);
  assert.equal(ctx.calls.filter((c) => c.url.includes('/api/answer')).length, 0,
    'Open run navigates — it must never POST an answer');
});

test('"Open run" is NOT rendered on the detail screen (you are already there)', async () => {
  const ctx = await boot();
  seedClarify(ctx);
  ctx.window.location.hash = `running/${RUN_ID}`;
  ctx.window.dispatchEvent(new ctx.window.Event('hashchange'));
  await new Promise((r) => setTimeout(r, 0));

  const panel = ctx.window.document.querySelector('#run-detail .rd-questions .qpanel');
  assert.ok(panel, 'the detail renders the question panel');
  assert.ok(panel.querySelector('.qpanel-foot .btn-go'), 'Submit is still there');
  assert.equal(panel.querySelector('.qopen'), null, 'no Open run on the detail page');
});

test('setPanelBusy covers the new button while an answer is in flight', async () => {
  const ctx = await boot();
  seedClarify(ctx);
  const card = ctx.window.document.querySelector(`.run-card[data-run-id="${RUN_ID}"]`);

  // setPanelBusy (T6's rewrite of app.js:4297-4312) disables every button/input in
  // every mounted panel; the new .qopen must be inside that sweep, not an escape
  // hatch out of a busy panel.
  card.querySelector('.qpanel .btn-go').dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ctx.calls.filter((c) => c.url.includes('/api/answer')).length, 1, 'the answer was posted');
  assert.equal(card.querySelector('.qpanel .qopen').disabled, true,
    'the panel busy state covers the new button');
  assert.equal(card.querySelector('.qpanel .btn-go').disabled, true, 'and the primary, as before');
});

// setPanelBusy only covers the panels mounted AT THE INSTANT it runs. postAnswer
// keeps r.pendingQuestion on a 200 (resume is confirmed by a later frame), so a
// detail screen opened mid-answer builds a fresh, fully enabled panel — whose
// Submit hits postAnswer's `if (r._answering) return;` and dies silently.
test('a panel built while an answer is in flight comes up busy, not dead', async () => {
  const ctx = await boot();
  seedClarify(ctx);
  const card = ctx.window.document.querySelector(`.run-card[data-run-id="${RUN_ID}"]`);

  card.querySelector('.qpanel .btn-go').dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ctx.calls.filter((c) => c.url.includes('/api/answer')).length, 1, 'the card posted');

  // Now open the run — paintRdQuestions mints the detail's panel from scratch.
  ctx.window.location.hash = `running/${RUN_ID}`;
  ctx.window.dispatchEvent(new ctx.window.Event('hashchange'));
  await new Promise((r) => setTimeout(r, 0));

  const panel = ctx.window.document.querySelector('#run-detail .rd-questions .qpanel');
  assert.ok(panel, 'the detail rendered a panel');
  const go = panel.querySelector('.btn-go');
  assert.equal(go.disabled, true, 'the freshly built primary is disabled, not offered');
  assert.equal(go.textContent, 'Resuming…', 'and reads the in-flight affordance');
  assert.equal(panel.querySelector('.qopt').disabled, true, 'its options are disabled too');

  // And clicking it changes nothing — no second POST, no silent dead button.
  go.dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ctx.calls.filter((c) => c.url.includes('/api/answer')).length, 1, 'still exactly one POST');
});

// --- T11: the "N of M answered" counter (spec §5.4) ---
//
// These reuse THIS FILE's boot(): it returns { window, dispatch, showRunning,
// calls, wsBox } — there is no ctx.recv / ctx.settle. `dispatch` needs the socket
// opened first, exactly as seedClarify() above does.
//
// The frame field is `question`, not `text`: renderClarifyBody reads `q.question`
// and its real-question filter drops entries without one, so a `text:` key renders
// ZERO .qblock nodes.

const seedQ = (ctx, pq) => {
  ctx.wsBox.ws.dispatch('open', {});
  ctx.dispatch({
    type: 'hello',
    runs: [{ runId: 'r1', title: 'Counter run', projectDir: '/tmp/p', status: 'running',
      startedAt: '2026-01-01T00:00:00Z', kind: 'run' }],
  });
  ctx.showRunning();
  ctx.dispatch({ type: 'question', runId: 'r1', ...pq });
};
const cardR1 = (ctx) => ctx.window.document.querySelector('#run-list .run-card[data-run-id="r1"]');

test('the answered counter starts at 0 of N and tracks option picks', async () => {
  const ctx = await boot();
  seedQ(ctx, {
    id: 'q-1', kind: 'clarify', agent: 'refiner',
    questions: [
      { id: 'a', question: 'First?',  options: ['A', 'B'] },
      { id: 'b', question: 'Second?', options: ['C', 'D'] },
    ],
  });

  const card = cardR1(ctx);
  const count = card.querySelector('.qpanel .qanswered');
  assert.ok(count, 'the panel footer carries an answered counter');
  assert.equal(count.hidden, false);
  assert.equal(count.textContent, '0 of 2 answered');

  card.querySelectorAll('.qpanel .qblock')[0].querySelector('.qopt')
    .dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
  assert.equal(count.textContent, '1 of 2 answered', 'picking an option counts it');

  card.querySelectorAll('.qpanel .qblock')[1].querySelector('.qopt')
    .dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
  assert.equal(count.textContent, '2 of 2 answered');
});

test('free text counts as answered, and clearing it counts back down', async () => {
  const ctx = await boot();
  seedQ(ctx, {
    id: 'q-1', kind: 'clarify', agent: 'refiner',
    questions: [{ id: 'a', question: 'Free?', options: ['A'] }],
  });

  const card = cardR1(ctx);
  const count = card.querySelector('.qpanel .qanswered');
  const free = card.querySelector('.qpanel .qfree');

  free.value = 'my own answer';
  free.dispatchEvent(new ctx.window.Event('input', { bubbles: true }));
  assert.equal(count.textContent, '1 of 1 answered');

  free.value = '';
  free.dispatchEvent(new ctx.window.Event('input', { bubbles: true }));
  assert.equal(count.textContent, '0 of 1 answered', 'an emptied free-text field is not an answer');
});

test('the counter is absent on the gate body (nothing to count)', async () => {
  const ctx = await boot();
  seedQ(ctx, {
    id: 'q-1', kind: 'gate', agent: 'reviewer',
    issues: [{ severity: 'major', title: 'Something', detail: 'd', location: 'f.js:1' }],
  });
  const card = cardR1(ctx);
  assert.ok(card.querySelector('.qpanel .gate-another'), 'the gate body rendered');
  assert.equal(card.querySelector('.qpanel .qanswered'), null,
    'only renderClarifyBody builds a counter');
});

// The dual-mount rule from T6 applies here too: each panel counts ITS OWN slots.
test('the card and the detail panel count independently', async () => {
  const ctx = await boot();
  seedQ(ctx, {
    id: 'q-1', kind: 'clarify', agent: 'refiner',
    questions: [{ id: 'a', question: 'Which?', options: ['A', 'B'] }],
  });
  ctx.window.location.hash = 'running/r1';
  ctx.window.dispatchEvent(new ctx.window.Event('hashchange'));
  await new Promise((r) => setTimeout(r, 0));

  const cardCount = cardR1(ctx).querySelector('.qpanel .qanswered');
  const detail = ctx.window.document.querySelector('#run-detail .rd-questions .qpanel');
  const detailCount = detail.querySelector('.qanswered');
  assert.equal(cardCount.textContent, '0 of 1 answered');
  assert.equal(detailCount.textContent, '0 of 1 answered');

  detail.querySelector('.qopt').dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
  assert.equal(detailCount.textContent, '1 of 1 answered');
  assert.equal(cardCount.textContent, '0 of 1 answered',
    "the card's own slots are untouched — T6 made the slots per-panel");
});

test('the clarify footer is [counter, Open run, Submit] on the card', async () => {
  const ctx = await boot();
  seedQ(ctx, { id: 'q-1', kind: 'clarify', questions: [{ id: 'a', question: 'Which?', options: ['A'] }] });
  const foot = cardR1(ctx).querySelector('.qpanel-foot');
  assert.deepEqual([...foot.children].map((n) => n.className.split(' ')[0]),
    ['qanswered', 'qopen', 'btn-go']);
});
