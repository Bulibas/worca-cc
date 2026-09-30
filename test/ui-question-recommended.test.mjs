// test/ui-question-recommended.test.mjs — the clarify panel shows the agent's confidence per
// option and preselects its recommendation (night mode, Step 14). The panel mounts on the run
// page (#running/<id>); boot and navigation come from the shared run-page helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bootApp as boot, openRunPanel } from './helpers/run-page-boot.mjs';

const RUN_ID = 'run-rec-1';

test('confidence bars per option, a Recommended badge, and the recommendation is preselected', async () => {
  const ctx = await boot({ fetchHandler: (url) => (url.includes('/api/answer') ? Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) }) : null) });
  const panel = await openRunPanel(ctx, { runId: RUN_ID, question: { id: 'clarify-1', kind: 'clarify',
    questions: [{ id: 'q1', question: 'Pick?', options: ['A', 'B'], confidence: [70, 30], recommended: 'B', allowFreeText: true }] } });
  const opts = [...panel.querySelectorAll('.qopt')];
  assert.equal(opts.length, 2);
  assert.deepEqual(opts.map((b) => b.dataset.key), ['A', 'B'], 'the letter keys stay');
  assert.deepEqual(opts.map((b) => b.querySelector('.qconf-fill').style.width), ['70%', '30%'], 'bars keyed by option order');
  assert.equal(opts[0].querySelector('.qrec'), null);
  assert.equal(opts[1].querySelector('.qrec').textContent, 'Recommended');
  assert.ok(opts[1].classList.contains('sel'));
  assert.equal(opts[1].getAttribute('aria-pressed'), 'true');
  assert.equal(opts[0].getAttribute('aria-pressed'), 'false');
  panel.querySelector('.btn-go').dispatchEvent(new ctx.window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  const post = ctx.calls.find((c) => c.url.includes('/api/answer'));
  assert.ok(post, 'the answer was posted without a click on an option');
  assert.equal(JSON.parse(post.opts.body).payload.answers[0].choice, 'B');
});

test('a question without confidence renders plain options, nothing preselected', async () => {
  const ctx = await boot();
  const panel = await openRunPanel(ctx, { runId: RUN_ID, question: { id: 'clarify-2', kind: 'clarify',
    questions: [{ id: 'q1', question: 'Pick?', options: ['A', 'B'], allowFreeText: true }] } });
  assert.equal(panel.querySelectorAll('.qconf, .qrec, .qopt.sel').length, 0);
  assert.equal([...panel.querySelectorAll('.qopt .qopt-txt')].map((s) => s.textContent).join(','), 'A,B');
});

test('stylesheet carries the confidence bar and badge rules', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../ui/public/style.css'), 'utf8');
  assert.ok(/\.qopt \.qrec\s*\{/.test(css), '.qopt .qrec rule');
  assert.ok(/\.qopt \.qconf-fill\s*\{/.test(css), '.qopt .qconf-fill rule');
});
