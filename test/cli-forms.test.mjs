// test/cli-forms.test.mjs
// The CLI's kind:'form' answer path, driven end to end over a real stdin pipe
// (spec §8): the main arm, CRLF input and a web-only form. Defaults, review-lists,
// every input class and the re-prompts are pinned in-process on the asker itself
// (test/cli-forms-unit.test.mjs). Harness is test/cli-interactive.test.mjs's
// driveCli, verbatim: spawn the CLI with stdin a PIPE and NO --yes, then write an
// answer when its rendered prompt appears on stdout. Auto mode is P2's and is never
// exercised here.
//
// The fixture (decision S11, verified on a real host): a USER agent — built-ins
// are immutable, so a form cannot be bolted onto worca-cc-implementer — carrying
// `asksQuestions: true` (without it src/core/workflows.mjs forces
// nc.askQuestions to false), an `ask` block, and the MOCK_ASK_FORM marker in its
// .md BODY (ruling X10: the test places the marker, never the prompt block; the
// body becomes the system prompt and parseMarkers scans both). The graph is
// hand-built because node ids must match /^n_[a-z0-9]{1,32}$/, which
// writeKeyGraph's `n0_<key>` ids are not.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useTempHome } from './helpers/temp-home.mjs';
import { templateRepo } from './helpers/git-dir.mjs';
import { createAgent } from '../src/core/agent-store.mjs';
import { writeGraphWorkflow } from '../src/core/workflows.mjs';
import { readStepQuestions } from '../src/core/artifacts.mjs';
import { getDb } from '../src/core/db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, '..', 'src', 'cli', 'worca-cc.mjs');

const home = useTempHome(after, 'worca-cc-cliform-home-');
const scratch = [];
after(() => Promise.all(scratch.map((d) => rm(d, { recursive: true, force: true, maxRetries: 3 }))));

function freshRepo() {
  const dir = templateRepo('cliform-repo', { branch: 'main', user: true, files: { 'seed.txt': 'seed\n' } });
  scratch.push(dir);
  return dir;
}

const DRIVE_TIMEOUT_MS = process.platform === 'win32' ? 120000 : 30000;
/** test/cli-interactive.test.mjs's driveCli. Cues are consumed IN ORDER: each is
 *  searched for starting AFTER the previous cue's match. */
function driveCli(args, { script = [], env = {}, stdin = 'pipe', timeoutMs = DRIVE_TIMEOUT_MS } = {}) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, WORCA_HOME: home, WORCA_MOCK: '1', ...env },
      stdio: [stdin, 'pipe', 'pipe'],
    });
    child.stdin?.on('error', () => {});
    let stdout = ''; let stderr = ''; let pos = 0; let sent = 0; let timedOut = false;
    const pump = () => {
      while (sent < script.length && child.stdin) {
        const { cue, send } = script[sent];
        const re = cue instanceof RegExp ? new RegExp(cue.source, cue.flags.replace(/[gy]/g, '')) : new RegExp(cue);
        const m = re.exec(stdout.slice(pos));
        if (!m) break;
        pos += m.index + m[0].length;
        sent += 1;
        child.stdin.write(send);
      }
    };
    child.stdout.on('data', (b) => { stdout += b.toString(); pump(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('exit', (code, signal) => { clearTimeout(timer); res({ code, signal, stdout, stderr, sent, timedOut }); });
  });
}

const pipelineIdFrom = (stdout) => (/Pipeline directory: .*-([0-9a-f]{8})\s*$/m.exec(stdout) || [])[1] || null;
const pipelineStatuses = () => getDb().prepare('SELECT id, status FROM pipelines').all();

/** The form the fixture agent declares. */
const REVIEW_FORM = {
  version: 1,
  title: 'Review mockups',
  data: { type: 'object', required: ['images'], properties: {
    summary: { type: 'string', maxLength: 8000 },
    images: { type: 'array', maxItems: 12, items: { type: 'object', required: ['id'], properties: {
      id: { type: 'string' }, caption: { type: 'string' } } } } } },
  answer: { type: 'object', required: ['verdict'], properties: {
    verdict: { type: 'string', enum: ['approve', 'changes'], default: 'approve' },
    picked: { type: 'string', enumFrom: 'data.images[].id' },
    notes: { type: 'string', maxLength: 4000 } } },
  layout: [
    { widget: 'markdown', bind: 'data.summary' },
    { widget: 'select', field: 'verdict', label: 'Verdict' },
    { widget: 'select', field: 'picked', label: 'Which one' },
    { widget: 'textarea', field: 'notes', label: 'What should change?', when: { verdict: 'changes' } },
  ],
  example: { summary: 'Two directions.', images: [{ id: 'a', caption: 'Option A' }, { id: 'b', caption: 'Option B' }] },
};

/** What the mock writes as the ask payload (X10: the TEST supplies it). */
const MOCK_PAYLOAD = { form: 'review-mockups', data: REVIEW_FORM.example };

/** Seed a user agent with `ask` + the mock marker, and a graph that runs it. */
async function seed(agentKey, workflowId, forms, payload = MOCK_PAYLOAD) {
  await createAgent({
    meta: {
      key: agentKey, displayName: 'Form Asker', metaVersion: 2, description: 'ask-forms fixture',
      uiPhase: 'implement', order: 50, runnerType: 'producer',
      asksQuestions: true, questionsDefault: true,
      inputs: [{ id: 'task', type: 'md', required: true }],
      outputs: [{ id: 'notes', type: 'md', filename: 'notes.md', store: 'run' }],
      tools: ['Read', 'Write'],
      ask: { forms },
    },
    markdown: `# Form Asker\n\nDo the thing.\n\nMOCK_ASK_FORM: ${JSON.stringify(payload)}\n`,
  });
  await writeGraphWorkflow({
    id: workflowId, name: 'Form arm', domain: 'coding',
    nodes: [
      { id: 'n_task', kind: 'task', x: 0, y: 100, config: {} },
      { id: 'n_asker', kind: 'agent', key: agentKey, x: 120, y: 100, config: { askQuestions: true } },
      { id: 'n_end', kind: 'end', x: 240, y: 100, config: {} },
    ],
    wires: [
      { id: 'w1', from: { node: 'n_task', port: 'task' }, to: { node: 'n_asker', port: 'task' } },
      { id: 'w2', from: { node: 'n_asker', port: 'notes' }, to: { node: 'n_end', port: 'result' } },
    ],
  });
}

/** The single persisted form round for n_asker (P2 E13 / X3). */
function formRound(pipelineId) {
  return readStepQuestions(pipelineId).find((r) => r.nodeId === 'n_asker' && r.ask);
}

test('form arm: the projection renders, fields prompt in layout order, `when` gates the last', async () => {
  await seed('formAskerA', 'wf_cliform_a', { 'review-mockups': REVIEW_FORM });
  const repo = freshRepo();
  const r = await driveCli(['--project', repo, '--prompt', 'form arm e2e', '--workflow', 'wf_cliform_a'], {
    script: [
      { cue: /Choose \[number or value, Enter = approve\]/, send: '2\n' },   // verdict -> changes
      { cue: /Choose \[number or value\]/, send: 'b\n' },                    // picked  -> by VALUE
      { cue: /Your answer/, send: 'tighten the spacing\n' },                 // notes, revealed by `when`
    ],
  });
  assert.equal(r.timedOut, false, r.stdout);
  assert.equal(r.sent, 3, `only ${r.sent} prompt(s) rendered:\n${r.stdout}`);
  assert.equal(r.code, 0, r.stderr);

  // P1's projectForm output: `<title> — <agent>`, the markdown display widget, then
  // one numbered two-line block per input field.
  assert.match(r.stdout, /\? Review mockups — /);
  assert.match(r.stdout, /Two directions\./);
  assert.match(r.stdout, /^1\. Verdict \{verdict\}$/m);
  assert.match(r.stdout, /one of: 1\) approve {2}2\) changes/);
  assert.match(r.stdout, /^3\. What should change\? \{notes\}$/m);
  assert.doesNotMatch(r.stdout, /Reply: \/answer/, 'no ref on the CLI, so no reply line');
  // formatFormField's own lines (Task 2): the required marker and the numbered options.
  assert.match(r.stdout, /^Verdict \*$/m);
  // `when: { verdict: 'changes' }` — the textarea PROMPT only opens after verdict.
  assert.ok(r.stdout.indexOf('Your answer') > r.stdout.indexOf('Choose [number or value, Enter = approve]'), r.stdout);

  // Behavioural consequence: { values } reached orch.answer and was persisted.
  const id = pipelineIdFrom(r.stdout);
  assert.ok(id, `no pipeline id in:\n${r.stdout}`);
  const round = formRound(id);
  assert.ok(round, `no persisted form round for ${id}`);
  assert.deepEqual(round.formAnswer.values, { verdict: 'changes', picked: 'b', notes: 'tighten the spacing' });
  assert.deepEqual(round.ask.values, round.formAnswer.values, 'X3: the snapshot carries the answer');
  assert.deepEqual(round.questions, [], 'X3: the legacy arrays stay empty');
  assert.deepEqual(round.answers, []);
});

test('form arm: CRLF-terminated input answers exactly like LF (Windows pipes)', async () => {
  await seed('formAskerD', 'wf_cliform_d', { 'review-mockups': REVIEW_FORM });
  const repo = freshRepo();
  const r = await driveCli(['--project', repo, '--prompt', 'form crlf e2e', '--workflow', 'wf_cliform_d'], {
    script: [
      { cue: /Choose \[number or value, Enter = approve\]/, send: '2\r\n' },
      { cue: /Choose \[number or value\]/, send: 'a\r\n' },
      { cue: /Your answer/, send: 'more contrast\r\n' },
    ],
  });
  assert.equal(r.timedOut, false, r.stdout);
  assert.equal(r.sent, 3, r.stdout);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(formRound(pipelineIdFrom(r.stdout)).formAnswer.values,
    { verdict: 'changes', picked: 'a', notes: 'more contrast' },
    'no stray \\r anywhere in the answer');
});

// ── surface: 'web' (ruling X11) ────────────────────────────────────────────────
// A form that is meaningless as text. Chat prints it and keeps waiting — a chat run
// lives in the server and a browser can answer it. The CLI owns its orchestrator
// in-process and NOTHING can answer it there, so it declines: the projection
// prints, one line names the web UI, and the existing abandon ladder stops the run.

const WEB_ONLY_FORM = { ...REVIEW_FORM, surface: 'web', title: 'Pick a mockup' };

test('surface:"web": the CLI prints the projection, names the web UI, and stops the run', async () => {
  await seed('formAskerW', 'wf_cliform_w', { 'pick-mockup': WEB_ONLY_FORM },
    { form: 'pick-mockup', data: REVIEW_FORM.example });
  const repo = freshRepo();
  const r = await driveCli(['--project', repo, '--prompt', 'form web-only e2e', '--workflow', 'wf_cliform_w'], {
    script: [],
  });
  assert.equal(r.timedOut, false, `the run HUNG instead of declining\n${r.stdout}`);
  assert.notEqual(r.code, 0, `a declined form is not a successful run\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

  // The projection still prints — the user sees what was asked.
  assert.match(r.stdout, /\? Pick a mockup — /);
  assert.match(r.stdout, /Two directions\./);
  // Exactly one line names the web UI, and NO prompt is ever opened.
  assert.match(r.stdout, /^This form is answered in the worca web UI\.$/m);
  assert.equal(/Choose \[/.test(r.stdout), false, 'no prompt is opened for a web-only form');

  // The existing abandon ladder owns the outcome: the row is never left running.
  assert.match(r.stderr, /worca: cannot continue without an answer — stopping the run\./);
  const rows = pipelineStatuses();
  assert.equal(rows.filter((p) => p.status === 'running').length, 0, JSON.stringify(rows));
});
