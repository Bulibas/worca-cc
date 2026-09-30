// test/ui-question-panel.test.mjs — the redesigned clarify/gate/recovery panel
// (design §4.3 + §5.4): amber wash, numbered ink circles (19px card / 22px detail),
// green-tinted picked options with a filled radio + white check, a free-text field
// that turns white-on-green once it holds a non-option value, a right-aligned
// footer. The panel mounts only on the run page (#running/<id>); the list card
// carries just the `.rc-wait` strip, so there is no "Open run" button in the footer.
//
// ruleBody() is a verbatim copy of test/ui-run-flow-css.test.mjs:17-21.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bootApp as boot, runCard, runPanel, openRunPanel } from './helpers/run-page-boot.mjs';

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

test('a picked option goes green-tinted with a filled radio and a white check', () => {
  const sel = ruleBody('.qopt.sel');
  assert.ok(sel, '.qopt.sel rule missing');
  assert.match(sel, /background:\s*var\(--green-bg\)/);
  assert.match(sel, /border-color:\s*var\(--green\)/);

  const radio = ruleBody('.qopt::before');
  assert.ok(radio, '.qopt::before radio missing');
  assert.match(radio, /border-radius:\s*50%/);
  assert.match(radio, /border:\s*1\.5px solid var\(--radio-ring\)/);

  const on = ruleBody('.qopt.sel::before');
  assert.ok(on, '.qopt.sel::before missing');
  assert.match(on, /var\(--green\)/, 'the filled radio uses --green');
  assert.match(on, /data:image\/svg\+xml/, 'the white check is a CSS-only data URI');
  assert.match(on, /stroke='%23fff'/, 'the check strokes white');
});

test('the free-text field turns white with a green border once it holds a value', () => {
  const base = ruleBody('.qfree');
  assert.ok(base, '.qfree rule missing');
  assert.match(base, /background:\s*var\(--field\)/);
  const has = ruleBody('.qfree.has');
  assert.ok(has, '.qfree.has rule missing');
  assert.match(has, /background:\s*var\(--panel\)/);
  assert.match(has, /border-color:\s*var\(--green\)/);
});

test('the footer is right-aligned on both surfaces; the detail panel rises', () => {
  const foot = ruleBody('.qpanel-foot');
  assert.ok(foot, '.qpanel-foot rule missing');
  assert.match(foot, /justify-content:\s*flex-end/);
  const detail = ruleBody('.rd-questions .qpanel');
  assert.ok(detail, '.rd-questions .qpanel rule missing');
  assert.match(detail, /background:\s*var\(--amber-wash-2\)/);
  assert.match(detail, /border:\s*1\.5px solid var\(--amber-line\)/);
  // The rise lives on the WRAPPER (Task 6's `.rd-questions`), not on the panel:
  // animating both nests the transform and doubles the travel and the fade.
  assert.match(ruleBody('.rd-questions'), /animation:wr-rise/);
  assert.doesNotMatch(detail, /animation:/, 'the panel must not re-animate its own wrapper\'s entrance');
});


// ---------------------------------------------------------------------------
// Behaviour: the panel on the run page
// ---------------------------------------------------------------------------

const RUN_ID = 'run-qp-1';
const click = (ctx, el) => el.dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
const answers = (ctx) => ctx.calls.filter((c) => c.url.includes('/api/answer'));

const CLARIFY = {
  id: 'clarify-1', kind: 'clarify',
  questions: [
    { id: 'q1', question: 'Where to store sessions?', options: ['Redis', 'Postgres', ''], allowFreeText: true },
  ],
};

test('the clarify footer has no "Open run" button: the panel only lives on the run page', async () => {
  const ctx = await boot();
  const panel = await openRunPanel(ctx, { runId: RUN_ID, question: CLARIFY });
  assert.ok(panel, 'the run page renders the question panel');
  assert.ok(panel.querySelector('.qpanel-foot .btn-go'), 'Submit is there');
  assert.equal(panel.querySelector('.qopen'), null, 'no Open run on the run page (you are already there)');

  // The list card never mounts a panel; its wait strip is the way in.
  ctx.showRunning();
  const card = runCard(ctx, RUN_ID);
  assert.equal(card.querySelector('.qpanel'), null, 'no panel on the list card');
  assert.equal(card.querySelector('.qopen'), null, 'and no Open run button');
});

test('setPanelBusy covers every control while an answer is in flight', async () => {
  const ctx = await boot();
  const panel = await openRunPanel(ctx, { runId: RUN_ID, question: CLARIFY });

  click(ctx, panel.querySelector('.btn-go'));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(answers(ctx).length, 1, 'the answer was posted');
  assert.equal(panel.querySelector('.btn-go').disabled, true, 'the primary is disabled');
  assert.equal(panel.querySelector('.qopt').disabled, true, 'options are disabled');
  assert.equal(panel.querySelector('.qfree').disabled, true, 'free text is disabled');
});

// setPanelBusy only covers the panel mounted AT THE INSTANT it runs. postAnswer
// keeps r.pendingQuestion on a 200 (resume is confirmed by a later frame), so a
// run page opened mid-answer builds a fresh, fully enabled panel — whose Submit
// hits postAnswer's `if (r._answering) return;` and dies silently.
test('a panel built while an answer is in flight comes up busy, not dead', async () => {
  const ctx = await boot();
  const first = await openRunPanel(ctx, { runId: RUN_ID, question: CLARIFY });

  click(ctx, first.querySelector('.btn-go'));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(answers(ctx).length, 1, 'the first panel posted');

  // Leave the run page and come back — paintRdQuestions mints the panel afresh.
  ctx.showRunning();
  await ctx.settle();
  ctx.go(`running/${RUN_ID}`);
  await ctx.settle();

  const panel = runPanel(ctx);
  assert.ok(panel, 'the run page rendered a panel');
  const go = panel.querySelector('.btn-go');
  assert.equal(go.disabled, true, 'the freshly built primary is disabled, not offered');
  assert.equal(go.textContent, 'Resuming…', 'and reads the in-flight affordance');
  assert.equal(panel.querySelector('.qopt').disabled, true, 'its options are disabled too');

  // And clicking it changes nothing — no second POST, no silent dead button.
  click(ctx, go);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(answers(ctx).length, 1, 'still exactly one POST');
});

// --- the "N of M answered" counter (spec §5.4) ---
//
// The frame field is `question`, not `text`: renderClarifyBody reads `q.question`
// and its real-question filter drops entries without one, so a `text:` key renders
// ZERO .qblock nodes.

test('the answered counter starts at 0 of N and tracks option picks', async () => {
  const ctx = await boot();
  const panel = await openRunPanel(ctx, { runId: 'r1', question: {
    id: 'q-1', kind: 'clarify', agent: 'refiner',
    questions: [
      { id: 'a', question: 'First?',  options: ['A', 'B'] },
      { id: 'b', question: 'Second?', options: ['C', 'D'] },
    ],
  } });

  const count = panel.querySelector('.qanswered');
  assert.ok(count, 'the panel footer carries an answered counter');
  assert.equal(count.hidden, false);
  assert.equal(count.textContent, '0 of 2 answered');

  click(ctx, panel.querySelectorAll('.qblock')[0].querySelector('.qopt'));
  assert.equal(count.textContent, '1 of 2 answered', 'picking an option counts it');

  click(ctx, panel.querySelectorAll('.qblock')[1].querySelector('.qopt'));
  assert.equal(count.textContent, '2 of 2 answered');
});

test('free text counts as answered, and clearing it counts back down', async () => {
  const ctx = await boot();
  const panel = await openRunPanel(ctx, { runId: 'r1', question: {
    id: 'q-1', kind: 'clarify', agent: 'refiner',
    questions: [{ id: 'a', question: 'Free?', options: ['A'] }],
  } });
  const count = panel.querySelector('.qanswered');
  const free = panel.querySelector('.qfree');

  free.value = 'my own answer';
  free.dispatchEvent(new ctx.window.Event('input', { bubbles: true }));
  assert.equal(count.textContent, '1 of 1 answered');

  free.value = '';
  free.dispatchEvent(new ctx.window.Event('input', { bubbles: true }));
  assert.equal(count.textContent, '0 of 1 answered', 'an emptied free-text field is not an answer');
});

test('the counter is absent on the gate body (nothing to count)', async () => {
  const ctx = await boot();
  const panel = await openRunPanel(ctx, { runId: 'r1', question: {
    id: 'q-1', kind: 'gate', agent: 'reviewer',
    issues: [{ severity: 'major', title: 'Something', detail: 'd', location: 'f.js:1' }],
  } });
  assert.ok(panel.querySelector('.gate-another'), 'the gate body rendered');
  assert.equal(panel.querySelector('.qanswered'), null, 'only renderClarifyBody builds a counter');
});

test('the clarify footer is [counter, Submit] on the run page', async () => {
  const ctx = await boot();
  const panel = await openRunPanel(ctx, { runId: 'r1', question: {
    id: 'q-1', kind: 'clarify', questions: [{ id: 'a', question: 'Which?', options: ['A'] }],
  } });
  const foot = panel.querySelector('.qpanel-foot');
  assert.deepEqual([...foot.children].map((n) => n.className.split(' ')[0]), ['qanswered', 'btn-go']);
});
