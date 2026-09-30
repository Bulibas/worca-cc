import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootApp as boot, openRunPanel } from './helpers/run-page-boot.mjs';

// Behavior tests for Task 10: kind:'questions' (per-agent user questions) in the
// question panel on the run page. Harness: test/helpers/run-page-boot.mjs (real
// app.js + real index.html under jsdom, WS constructor stub, fetch recorder).

const RUN_ID = 'run-aaa';

function questionsEvent() {
  return {
    id: 'questions-1:s0_0-r1',
    kind: 'questions',
    agent: 'Plan',
    nodeId: 's0_0',
    questions: [{ id: 'q1', question: 'Which storage?', options: ['Redis', 'Postgres'], allowFreeText: true }],
  };
}

test('kind:questions renders the clarify-style body with the agent name in the head', async () => {
  const ctx = await boot({
    fetchHandler: (url, opts) => {
      if (url.includes('/api/answer') && opts && opts.method === 'POST') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
      }
      return null;
    },
  });
  const panel = await openRunPanel(ctx, { runId: RUN_ID, question: questionsEvent() });
  assert.equal(panel.querySelector('.qpanel-head b').textContent, 'Plan has questions');
  assert.equal(panel.querySelectorAll('.qopt').length, 2, 'options rendered');
  assert.ok(panel.querySelector('.qfree'), 'free text rendered');
  // Submit posts the standard answers payload.
  panel.querySelector('.qopt').click();
  panel.querySelector('.qpanel-foot .btn-go').click();
  await new Promise((r) => setTimeout(r, 0));
  const post = ctx.calls.find((c) => c.url.includes('/api/answer'));
  assert.ok(post, 'POST /api/answer fired');
  const body = JSON.parse(post.opts.body);
  assert.equal(body.runId, RUN_ID);
  assert.equal(body.id, 'questions-1:s0_0-r1');
  assert.equal(body.payload.answers[0].choice, 'Redis');
});
