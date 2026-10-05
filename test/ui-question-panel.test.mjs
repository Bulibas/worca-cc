// test/ui-question-panel.test.mjs — the clarify/gate/recovery panel on the run page
// (#running/<id>): its in-flight busy guards (no double POST) and the "N of M answered"
// counter in the clarify footer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootApp as boot, runPanel, openRunPanel } from './helpers/run-page-boot.mjs';

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
  // Leave through another view: side by side a bare #runs would reopen this run (rule 1).
  ctx.go('new');
  await ctx.settle();
  ctx.go(`running/${RUN_ID}`);
  await ctx.settle();

  const panel = runPanel(ctx);
  assert.ok(panel, 'the run page rendered a panel');
  assert.notEqual(panel, first, 'a freshly minted panel, not the one that posted');
  const go = panel.querySelector('.btn-go');
  assert.equal(go.disabled, true, 'the freshly built primary is disabled, not offered');
  assert.equal(go.textContent, 'Resuming…', 'and reads the in-flight affordance');
  assert.equal(panel.querySelector('.qopt').disabled, true, 'its options are disabled too');

  // And clicking it changes nothing — no second POST, no silent dead button.
  click(ctx, go);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(answers(ctx).length, 1, 'still exactly one POST');
});
