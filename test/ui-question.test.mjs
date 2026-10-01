import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootApp as boot, helloRun, runCard, runPanel, openRunPanel } from './helpers/run-page-boot.mjs';

// Behavior tests for the clarify/gate question panel. The panel mounts ONLY on
// the run page (#running/<id>, `#run-detail .rd-questions .qpanel`); the Runs
// list row just puts the run in Needs you and names the wait in its subline
// ("Question", "Workflow review"), and its click opens the page. We boot the REAL
// app.js against the REAL index.html under jsdom (test/helpers/run-page-boot.mjs),
// dispatch server frames through the captured WebSocket and capture POST
// /api/answer via a fetch stub.
//
// Each test gets a fresh DOM + a fresh module import (cache-busted) so module
// top-level state can't leak between cases.

const RUN_ID = 'run-aaa';

function clarifyEvent() {
  return {
    id: 'clarify-1',
    kind: 'clarify',
    questions: [
      // options padded to 3 slots with '' per the clarify contract — UI must filter.
      { id: 'q1', question: 'Where to store sessions?', options: ['Redis', 'Postgres', ''], allowFreeText: true },
      { id: 'q2', question: 'How to handle invalid input?', options: ['Fail fast', '', ''], allowFreeText: true },
    ],
  };
}

const click = (ctx, el) => el.dispatchEvent(new ctx.window.Event('click', { bubbles: true }));

// The run's copy in Needs you (null when nothing waits on you), and a row's word:
// the subline's head, before " · <step or time>".
const needsRow = (ctx, runId) =>
  ctx.window.document.querySelector(`#runs-list .runs-needs .runs-row[data-run-id="${runId}"]`);
const rowWord = (row) => row.querySelector('.runs-row-sub').textContent.split(' · ')[0];

// A fetch stub that records /api/answer bodies.
function answerRecorder() {
  const captured = [];
  const fetchHandler = (url, opts) => {
    if (url.includes('/api/answer')) {
      captured.push(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
    }
    return null;
  };
  return { captured, fetchHandler };
}

test('clarify question renders on the run page; the list row is in Needs you and reads "Question", no panel', async () => {
  const ctx = await boot();
  const panel = await openRunPanel(ctx, { runId: RUN_ID, question: clarifyEvent() });
  assert.ok(panel, 'qpanel present on the run page');
  assert.equal(panel.classList.contains('hidden'), false, 'qpanel is visible (not hidden)');

  const blocks = panel.querySelectorAll('.qblock');
  assert.equal(blocks.length, 2, 'one .qblock per question');

  // q1 has 2 real options, q2 has 1 (the '' slots are filtered) => 3 total.
  const opts = panel.querySelectorAll('.qopt');
  assert.equal(opts.length, 3, 'empty option slots are filtered out');

  // Head: count chip + title with the phase label (defaults to phaseKey label).
  assert.ok(panel.querySelector('.qcount'), 'qcount chip present');
  assert.match(panel.querySelector('.qcount').textContent, /2 questions/);
  assert.ok(panel.querySelector('.qpanel-foot .btn-go'), 'submit button present');

  // The list row only points at it (Needs you + its word) — the panel is not mounted there.
  ctx.showRunning();
  await ctx.settle();
  const card = runCard(ctx, RUN_ID);
  assert.ok(card, 'run row exists in its project group');
  assert.ok(needsRow(ctx, RUN_ID), 'the run is in Needs you');
  assert.equal(card.querySelector('.qpanel'), null, 'no question panel on the list row');
  assert.equal(needsRow(ctx, RUN_ID).querySelector('.qpanel'), null, 'nor on its Needs-you copy');
  assert.equal(rowWord(card), 'Question', 'the row names the wait');
});

test('each option carries a letter key (A, B, ...) so it can be referenced by name', async () => {
  const ctx = await boot();
  const panel = await openRunPanel(ctx, { runId: RUN_ID, question: clarifyEvent() });
  const blocks = panel.querySelectorAll('.qblock');

  // The letter rides data-key (the stylesheet draws it as the option's key square);
  // the text node is the option itself, so the key is never printed twice.
  // q1: 2 real options -> A Redis, B Postgres.
  const q1opts = blocks[0].querySelectorAll('.qopt');
  assert.equal(q1opts[0].dataset.key, 'A');
  assert.equal(q1opts[0].textContent, 'Redis');
  assert.equal(q1opts[1].dataset.key, 'B');
  assert.equal(q1opts[1].textContent, 'Postgres');

  // q2: 1 real option, letters restart per-question -> A Fail fast.
  const q2opts = blocks[1].querySelectorAll('.qopt');
  assert.equal(q2opts[0].dataset.key, 'A');
  assert.equal(q2opts[0].textContent, 'Fail fast');
});

test('selecting an option marks it + submit posts {runId,id,payload:{answers}} with the choice', async () => {
  const { captured, fetchHandler } = answerRecorder();
  const ctx = await boot({ fetchHandler });
  const panel = await openRunPanel(ctx, { runId: RUN_ID, question: clarifyEvent() });
  const blocks = panel.querySelectorAll('.qblock');

  // Click the first option of q1 ("Redis").
  const q1opt = blocks[0].querySelectorAll('.qopt')[0];
  click(ctx, q1opt);
  assert.ok(q1opt.classList.contains('sel'), 'clicked option marked .sel');
  assert.equal(q1opt.getAttribute('aria-pressed'), 'true', 'clicked option aria-pressed=true');
  // Sibling stays unselected.
  const q1opt2 = blocks[0].querySelectorAll('.qopt')[1];
  assert.equal(q1opt2.getAttribute('aria-pressed'), 'false', 'sibling stays unpressed');

  // Click q2's only option ("Fail fast").
  click(ctx, blocks[1].querySelectorAll('.qopt')[0]);

  // Click submit.
  click(ctx, panel.querySelector('.qpanel-foot .btn-go'));
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(captured.length, 1, 'one POST /api/answer issued');
  const body = captured[0];
  assert.equal(body.runId, RUN_ID, 'body carries runId');
  assert.equal(body.id, 'clarify-1', 'body carries the question id');
  assert.ok(body.payload && Array.isArray(body.payload.answers), 'payload.answers is an array');
  assert.equal(body.payload.answers.length, 2, 'one answer per question');
  assert.equal(body.payload.answers[0].id, 'q1');
  assert.equal(body.payload.answers[0].choice, 'Redis', 'chosen option text captured as choice');
  assert.equal(body.payload.answers[1].id, 'q2');
  assert.equal(body.payload.answers[1].choice, 'Fail fast');

  // 200 must NOT immediately clear the panel — keep pendingQuestion until resume.
  assert.equal(runPanel(ctx).classList.contains('hidden'), false, 'panel still visible after 200');
  assert.equal(ctx.window.document.querySelector('#run-detail .rd-questions').hidden, false, 'question host stays up');
  ctx.showRunning();
  await ctx.settle();
  assert.ok(needsRow(ctx, RUN_ID), 'still in Needs you until a resume event confirms');

  // A following `state` event confirms resume -> panel clears, Needs you drops it.
  // (The v1 `phase` frame is gone; onState is the client's single resume seam.)
  ctx.dispatch({ type: 'state', runId: RUN_ID, status: 'running' });
  await ctx.settle();
  assert.equal(needsRow(ctx, RUN_ID), null, 'out of Needs you on resume');
  assert.equal(rowWord(runCard(ctx, RUN_ID)), 'Running', 'the row reads running again');
  ctx.go(`running/${RUN_ID}`);
  await ctx.settle();
  assert.equal(ctx.window.document.querySelector('#run-detail .rd-questions').hidden, true, 'question host hidden on resume');
  assert.equal(runPanel(ctx).innerHTML, '', 'panel emptied on resume');
});

test('free-text answer overrides option selection and is captured as the choice', async () => {
  const { captured, fetchHandler } = answerRecorder();
  const ctx = await boot({ fetchHandler });
  const panel = await openRunPanel(ctx, { runId: RUN_ID, question: clarifyEvent() });
  const blocks = panel.querySelectorAll('.qblock');

  // Select an option in q1, then type free text -> the option must clear.
  const q1opt = blocks[0].querySelectorAll('.qopt')[0];
  click(ctx, q1opt);
  const free = blocks[0].querySelector('.qfree');
  free.value = 'DynamoDB';
  free.dispatchEvent(new ctx.window.Event('input', { bubbles: true }));
  assert.equal(q1opt.classList.contains('sel'), false, 'typing free text clears the option selection');

  click(ctx, panel.querySelector('.qpanel-foot .btn-go'));
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(captured[0].payload.answers[0].choice, 'DynamoDB', 'free-text value captured as the choice');
});

test('A2: a hello-seeded pendingQuestion renders the panel when the run page opens (no question event)', async () => {
  const ctx = await boot();
  // hello seeds the run WITH a pendingQuestion (mid-pause reload: the original
  // question event is past the replay buffer). No separate `question` dispatched.
  const panel = await openRunPanel(ctx, {
    runId: RUN_ID,
    run: { title: 'Reloaded run', pendingQuestion: { ...clarifyEvent(), type: 'question', runId: RUN_ID } },
  });

  assert.ok(panel, 'panel built for the seeded run');
  assert.equal(panel.classList.contains('hidden'), false, 'panel rendered from the seed');
  assert.equal(panel.querySelectorAll('.qblock').length, 2, 'seeded questions rendered');

  // The list row points at it: Needs you plus its word.
  ctx.showRunning();
  await ctx.settle();
  assert.ok(needsRow(ctx, RUN_ID), 'the seeded question puts the run in Needs you');
  assert.equal(rowWord(runCard(ctx, RUN_ID)), 'Question', 'the row names the seeded question');
});

test('gate question renders issues + two decision buttons; approve posts {decision:"another"}', async () => {
  const { captured, fetchHandler } = answerRecorder();
  const ctx = await boot({ fetchHandler });
  const panel = await openRunPanel(ctx, {
    runId: RUN_ID,
    question: {
      id: 'gate-refine-5',
      kind: 'gate',
      issues: [
        { severity: 'critical', title: 'Missing tests', detail: 'No coverage for X', location: 'src/x.js:10' },
        { severity: 'minor', title: 'Naming', detail: 'foo -> bar' },
      ],
    },
  });

  assert.equal(panel.classList.contains('hidden'), false, 'gate panel visible');
  assert.equal(panel.querySelectorAll('.issues .issue').length, 2, 'both issues rendered');
  assert.ok(panel.querySelector('.issue.sev-critical'), 'critical severity class applied');
  assert.ok(panel.querySelector('.gate-continue'), 'continue button present');
  assert.ok(panel.querySelector('.gate-another'), 'approve-another button present');

  click(ctx, panel.querySelector('.gate-another'));
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(captured.length, 1, 'gate POST issued');
  assert.equal(captured[0].id, 'gate-refine-5');
  assert.deepEqual(captured[0].payload, { decision: 'another' }, 'approve posts decision:another');
});

test('multi-tab: a question-resolved event clears the run page WITHOUT this tab having answered', async () => {
  const ctx = await boot();
  const panel = await openRunPanel(ctx, { runId: RUN_ID, question: clarifyEvent() }); // this tab never submits (_answering stays false)
  const host = ctx.window.document.querySelector('#run-detail .rd-questions');
  assert.equal(host.hidden, false, 'the run page shows the question first');
  assert.equal(panel.classList.contains('hidden'), false, 'panel visible first');

  // Answered in ANOTHER tab -> the server broadcasts the resolution to this one.
  ctx.dispatch({ type: 'question-resolved', runId: RUN_ID, id: 'clarify-1' });

  assert.equal(host.hidden, true, 'question host hides for the non-answering tab');
  assert.equal(panel.innerHTML, '', 'panel emptied');
  ctx.showRunning();
  await ctx.settle();
  assert.ok(runCard(ctx, RUN_ID), 'the run is still listed');
  assert.equal(needsRow(ctx, RUN_ID), null, 'it leaves Needs you');
  assert.equal(rowWord(runCard(ctx, RUN_ID)), 'Running', 'and its row no longer names a question');
});

test('a question-resolved for a STALE id leaves a newer pending question untouched', async () => {
  const ctx = await boot();
  const panel = await openRunPanel(ctx, { runId: RUN_ID, question: clarifyEvent() }); // pending = clarify-1

  ctx.dispatch({ type: 'question-resolved', runId: RUN_ID, id: 'clarify-OLD' });

  assert.equal(ctx.window.document.querySelector('#run-detail .rd-questions').hidden, false, 'mismatched id leaves the question up');
  assert.equal(panel.querySelectorAll('.qblock').length, 2, 'panel still rendered');
  ctx.showRunning();
  await ctx.settle();
  assert.ok(needsRow(ctx, RUN_ID), 'the run stays in Needs you');
  assert.equal(rowWord(runCard(ctx, RUN_ID)), 'Question', 'and its row still names the question');
});

test('a pending question puts the run in Needs you reading "Question", and its row opens the run page', async () => {
  const ctx = await boot();
  helloRun(ctx, { runId: RUN_ID });
  ctx.dispatch({ type: 'question', runId: RUN_ID, ...clarifyEvent() });
  ctx.showRunning();
  await ctx.settle();

  const card = runCard(ctx, RUN_ID);
  assert.ok(card, 'the run is listed in its project group');
  assert.equal(card.dataset.icon, 'ask', 'a question gives the row the ask icon');
  assert.equal(rowWord(card), 'Question', 'clarify row word');
  assert.equal(card.querySelector('.qpanel'), null, 'the panel is not mounted on the row');
  const needs = needsRow(ctx, RUN_ID);
  assert.ok(needs, 'and repeated in Needs you');
  assert.equal(rowWord(needs), 'Question');

  click(ctx, needs);
  assert.equal(ctx.window.location.hash, `#running/${RUN_ID}`, 'the row opens the run page');
  await ctx.settle();
  assert.ok(runPanel(ctx).querySelector('.qblock'), 'and the question is there');
  assert.match(runPanel(ctx).querySelector('.qcount').textContent, /2 questions/, 'the page counts them');
  assert.equal(ctx.calls.filter((c) => c.url.includes('/api/answer')).length, 0, 'navigating never POSTs an answer');
});

test('the row reads "Workflow review" for a workflow question and leaves Needs you with no question', async () => {
  const ctx = await boot();
  helloRun(ctx, { runId: RUN_ID });
  ctx.showRunning();
  await ctx.settle();
  assert.equal(needsRow(ctx, RUN_ID), null, 'not in Needs you while nothing waits');
  assert.equal(rowWord(runCard(ctx, RUN_ID)), 'Running', 'a plain running row');

  ctx.dispatch({
    type: 'question', runId: RUN_ID, id: 'wf-1', kind: 'workflow',
    workflow: { name: 'web-task', agents: [] },
  });
  await ctx.settle();
  const card = runCard(ctx, RUN_ID);
  assert.ok(needsRow(ctx, RUN_ID), 'the workflow ask puts it in Needs you');
  assert.equal(rowWord(card), 'Workflow review');
  assert.equal(card.dataset.icon, 'ask');
});
