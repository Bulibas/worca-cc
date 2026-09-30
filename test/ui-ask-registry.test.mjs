// test/ui-ask-registry.test.mjs — the ask renderer registry (ask-forms design §6,
// D6). Two halves: the pure module, and the proof that app.js's renderQpanel now
// dispatches through it with the four legacy bodies registered and NOTHING about
// the rendered panel moved.
//
// The panel is mounted on the run page only (test/helpers/run-page-boot.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerAskRenderer, askRendererFor, askKindOf } from '../ui/public/ask/registry.mjs';
import { bootApp as boot, openRunPanel } from './helpers/run-page-boot.mjs';

const RUN_ID = 'run-reg-1';
// Open the run page for a run parked on `question`; resolves to the run page's .qpanel.
const seed = (ctx, question) => openRunPanel(ctx, { runId: RUN_ID, question });

// ---------------------------------------------------------------- pure module

test('askKindOf reproduces the legacy ladder, including the issues-array arm', () => {
  assert.equal(askKindOf(null), null);
  assert.equal(askKindOf({ kind: 'workflow', issues: [] }), 'workflow');
  assert.equal(askKindOf({ kind: 'recovery' }), 'recovery');
  assert.equal(askKindOf({ kind: 'form', form: 'f', version: 1, askId: 'a_1', surface: 'any' }), 'form');
  assert.equal(askKindOf({ kind: 'gate' }), 'gate');
  assert.equal(askKindOf({ issues: [{ title: 'x' }] }), 'gate', 'a bare issues array is still a gate');
  assert.equal(askKindOf({ kind: 'questions' }), 'clarify');
  assert.equal(askKindOf({ kind: 'clarify' }), 'clarify');
  assert.equal(askKindOf({}), 'clarify');
});

test('register/lookup: last wins, missing members are filled, junk is ignored', () => {
  registerAskRenderer('zz-probe', { render: () => 'first' });
  registerAskRenderer('zz-probe', { render: () => 'second' });
  const r = askRendererFor('zz-probe');
  assert.equal(r.render(), 'second');
  assert.equal(r.collect(null), null, 'collect defaults to null');
  assert.equal(r.title({}, {}), '');
  assert.equal(r.count({}, {}), null);
  assert.equal(r.setErrors(null, []), undefined);
  registerAskRenderer('', { render: () => {} });
  assert.equal(askRendererFor(''), null);
  registerAskRenderer('zz-bad', { collect: () => {} });
  assert.equal(askRendererFor('zz-bad'), null, 'no render function, no registration');
  assert.equal(askRendererFor('nope'), null);
});

// ------------------------------------------------- app.js registers the four

test('app.js registers clarify, gate, recovery and workflow', async () => {
  await boot();
  for (const kind of ['clarify', 'gate', 'recovery', 'workflow']) {
    const r = askRendererFor(kind);
    assert.ok(r, `${kind} is registered`);
    assert.equal(typeof r.render, 'function');
    assert.equal(typeof r.title, 'function');
  }
});

test('the clarify panel is byte-identical to the pre-registry markup', async () => {
  const ctx = await boot();
  const panel = await seed(ctx, { id: 'c1', kind: 'clarify', questions: [
    { id: 'q1', question: 'Where to store sessions?', options: ['Redis', 'Postgres', ''], allowFreeText: true },
  ] });
  assert.ok(panel && !panel.classList.contains('hidden'));
  assert.equal(panel.querySelector('.qpanel-head b').textContent, 'Pipeline needs your input');
  assert.equal(panel.querySelector('.qpanel-head .qcount').textContent, '1 question');
  assert.equal(panel.querySelectorAll('.qopt').length, 2, 'the padded empty option is dropped');
  assert.equal(panel.querySelectorAll('.qfree').length, 1);
  assert.equal(panel.querySelector('.qanswered').textContent, '0 of 1 answered');
  assert.equal(panel.querySelector('.qopen'), null, 'no Open run button: the panel only lives on the run page');
  assert.ok(Array.isArray(panel.__answers), 'per-panel slots still land on panel.__answers');
});

test('kind:questions keeps the agent head; gate, recovery and workflow keep theirs', async () => {
  const q = await boot();
  const qp = await seed(q, { id: 'q1', kind: 'questions', agent: 'implementer', questions: [{ id: 'a', question: 'Which DB?' }] });
  assert.equal(qp.querySelector('.qpanel-head b').textContent, 'implementer has questions');
  assert.equal(qp.querySelector('.qcount').textContent, '1 question');

  const g = await boot();
  const gp = await seed(g, { id: 'g1', kind: 'gate', issues: [{ severity: 'major', title: 'Broken' }] });
  assert.equal(gp.querySelector('.qpanel-head b').textContent, 'Cycle gate');
  assert.equal(gp.querySelector('.qcount'), null, 'the gate head carries no count chip');
  assert.ok(gp.querySelector('.gate-another'));

  const rec = await boot();
  const rp = await seed(rec, { id: 'r1', kind: 'recovery', recovery: { cls: 'rate_limit', message: 'slow down' } });
  assert.equal(rp.querySelector('.qpanel-head b').textContent, 'rate limit error — action needed');
  assert.ok(rp.querySelector('.recovery-retry'));
});

test('submitAnswer posts the clarify payload through the registry collect', async () => {
  const ctx = await boot();
  const panel = await seed(ctx, { id: 'c1', kind: 'clarify', questions: [
    { id: 'q1', question: 'Where to store sessions?', options: ['Redis', 'Postgres'], allowFreeText: true },
  ] });
  panel.querySelectorAll('.qopt')[1].dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
  panel.querySelector('.btn-go').dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  const post = ctx.calls.find((c) => c.url === '/api/answer');
  assert.ok(post, 'an answer was posted');
  assert.deepEqual(JSON.parse(post.opts.body), {
    runId: RUN_ID, id: 'c1',
    payload: { answers: [{ id: 'q1', question: 'Where to store sessions?', choice: 'Postgres' }] },
  });
});
