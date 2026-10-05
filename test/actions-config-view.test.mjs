// test/actions-config-view.test.mjs — the Actions config editors of ui/public/actions-config-view.mjs
// (issue #529): the project editor (Setup, Actions, Built in) and the workspace stack editor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { checkRows } from './helpers/rows.mjs';
import { editorFieldEl, renderProjectActionsEditor, readEditorForm, renderStackEditor, readStackForm } from '../ui/public/actions-config-view.mjs';

const dom = new JSDOM('<!doctype html><body></body>');
const doc = dom.window.document;
const fire = (el, type) => el.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
const type = (el, value) => { el.value = value; fire(el, 'input'); };

const CFG = () => ({ setup: 'npm ci', actions: [{ id: 'run', label: 'Run', kind: 'service', cmd: 'npm start', cmdWin32: null, cwd: '.',
  env: [{ name: 'PORT', type: 'port', value: 'auto' }], openUrl: 'http://localhost:{PORT}', ready: { kind: 'port', port: 'PORT', timeoutMs: 60000 } }],
  builtins: { editor: true, terminal: false, fileManager: true, copyCommand: true } });

test('project editor round-trips configs through the form (service+port, task+output ready+Windows cmd)', async () => {
  await checkRows([
    { name: 'editor round-trips a config through the form', run: () => {
      const cfg = CFG();
      const root = renderProjectActionsEditor(cfg, { doc, detected: { editor: { label: 'VS Code' }, terminal: null, fileManager: { label: 'Finder' } } });
      assert.deepEqual(readEditorForm(root), cfg);
      assert.match(root.textContent, /Terminal.*not found on this machine/s);
      assert.match(root.textContent, /VS Code/);
      assert.match(root.textContent, /\{branch\}.*\{worktree\}.*\{runId\}.*\{member\}.*\{PORT\}/s);
    } },
    { name: 'round-trips a task, an output ready check, a typed port and a Windows command', run: () => {
      const cfg = { setup: null, actions: [
        { id: 'web', label: 'Web', kind: 'service', cmd: 'vite', cmdWin32: 'vite.cmd', cwd: 'web',
          env: [{ name: 'PORT', type: 'port', value: 5173 }, { name: 'MODE', type: 'text', value: 'dev' }],
          openUrl: null, ready: { kind: 'output', text: 'ready in', timeoutMs: 30000 } },
        { id: 'test', label: 'Test', kind: 'task', cmd: 'npm test', cmdWin32: null, cwd: '.', env: [], openUrl: null, ready: { kind: 'immediate' } },
      ], builtins: { editor: false, terminal: true, fileManager: false, copyCommand: false } };
      const root = renderProjectActionsEditor(cfg, { doc, detected: {} });
      assert.deepEqual(readEditorForm(root), cfg);
    } },
  ]);
});

test('Add action appends an empty row; port rows validate inline', () => {
  const root = renderProjectActionsEditor(CFG(), { doc, detected: {} });
  fire(root.querySelector('.ac-add-action'), 'click');
  const form = readEditorForm(root);
  assert.equal(form.actions.length, 2);
  assert.deepEqual(form.actions[1], { id: '', label: '', kind: 'service', cmd: '', cmdWin32: null, cwd: '.', env: [], openUrl: null, ready: { kind: 'immediate' } });

  const port = root.querySelector('.ac-action .ac-env-row .ac-env-value');
  type(port, '80');
  const err = root.querySelector('.ac-action .ac-env-row .field-err');
  assert.ok(err && !err.hidden, 'an inline error shows');
  assert.match(err.textContent, /1024/);
  type(port, 'abc');
  assert.match(err.textContent, /auto/);
  type(port, '4417');
  assert.ok(err.hidden, 'a valid port clears the error');
  assert.equal(readEditorForm(root).actions[0].env[0].value, 4417);

  // A text row never validates as a port; switching it to port does.
  const row2 = root.querySelectorAll('.ac-action')[1];
  fire(row2.querySelector('.ac-add-env'), 'click');
  const envRow = row2.querySelector('.ac-env-row');
  type(envRow.querySelector('.ac-env-value'), '80');
  assert.ok(envRow.querySelector('.field-err').hidden);
  const sel = envRow.querySelector('.ac-env-type');
  sel.value = 'port'; fire(sel, 'change');
  assert.ok(!envRow.querySelector('.field-err').hidden);
});

test('remove buttons drop actions and env rows; Save and Try it hand back the form', () => {
  const saved = []; const tried = [];
  const root = renderProjectActionsEditor(CFG(), { doc, detected: {}, onSave: (c) => saved.push(c), onTry: (id) => tried.push(id) });
  fire(root.querySelector('.ac-try'), 'click');
  assert.deepEqual(tried, ['run']);
  fire(root.querySelector('.ac-env-row .ac-remove-env'), 'click');
  assert.deepEqual(readEditorForm(root).actions[0].env, []);
  fire(root.querySelector('.ac-save'), 'click');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].setup, 'npm ci');
  fire(root.querySelector('.ac-remove-action'), 'click');
  assert.deepEqual(readEditorForm(root).actions, []);
});

const STACK_DATA = () => ({
  stacks: [{ id: 'dev', label: 'Dev stack', kind: 'service', steps: [
    { member: 'api-1a2b3c4d', action: 'run', env: [] },
    { member: 'web-5e6f7a8b', action: 'run', env: [{ name: 'API_URL', value: 'http://localhost:{api.PORT}' }] },
  ] }],
  members: [
    { projectKey: 'api-1a2b3c4d', name: 'api', alias: 'api', actions: [{ id: 'run', label: 'Run', kind: 'service' }, { id: 'test', label: 'Test', kind: 'task' }] },
    { projectKey: 'web-5e6f7a8b', name: 'web', alias: 'web', actions: [{ id: 'run', label: 'Run', kind: 'service' }] },
  ],
});

test('stack editor numbers steps and lists member actions', () => {
  const root = renderStackEditor(STACK_DATA(), { doc });
  const nums = [...root.querySelectorAll('.ac-step-num')].map((n) => n.textContent);
  assert.deepEqual(nums, ['1.', '2.']);
  assert.match(root.textContent, /\{api\.PORT\}/);
  assert.match(root.textContent, /\{web\.PORT\}/);
  const opts = [...root.querySelector('.ac-step .ac-step-action').options].map((o) => o.value);
  assert.deepEqual(opts, ['run', 'test']);
  assert.deepEqual(readStackForm(root), { stacks: STACK_DATA().stacks });
});

test('stack editor: changing a member refills its actions; add/remove steps renumber; Save hands back stacks', () => {
  const saved = [];
  const root = renderStackEditor(STACK_DATA(), { doc, onSave: (s) => saved.push(s) });
  const step = root.querySelector('.ac-step');
  const mem = step.querySelector('.ac-step-member');
  mem.value = 'web-5e6f7a8b'; fire(mem, 'change');
  assert.deepEqual([...step.querySelector('.ac-step-action').options].map((o) => o.value), ['run']);
  fire(root.querySelector('.ac-add-step'), 'click');
  assert.deepEqual([...root.querySelectorAll('.ac-step-num')].map((n) => n.textContent), ['1.', '2.', '3.']);
  fire(root.querySelector('.ac-remove-step'), 'click');
  assert.deepEqual([...root.querySelectorAll('.ac-step-num')].map((n) => n.textContent), ['1.', '2.']);
  fire(root.querySelector('.ac-add-stack'), 'click');
  fire(root.querySelector('.ac-save'), 'click');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].stacks.length, 2);
  assert.deepEqual(saved[0].stacks[1], { id: '', label: '', kind: 'service', steps: [] });
});

// #555: a server ActionConfigError.field names an input; the app puts the error on it.
test('editorFieldEl resolves ActionConfigError fields to the editor inputs', () => {
  const cfg = CFG();
  cfg.actions.push({ id: 'test', label: 'Test', kind: 'task', cmd: 'npm test', cmdWin32: null, cwd: '.', env: [], openUrl: null, ready: { kind: 'immediate' } });
  cfg.actions[0].env.push({ name: 'MODE', type: 'text', value: 'dev' });
  const root = renderProjectActionsEditor(cfg, { doc, detected: {} });
  const rows = root.querySelectorAll('.ac-action');
  assert.equal(editorFieldEl(root, 'setup'), root.querySelector('.ac-setup'));
  assert.equal(editorFieldEl(root, 'actions[1].cmd'), rows[1].querySelector('.ac-f-cmd'));
  assert.equal(editorFieldEl(root, 'actions[0].env[1]'), rows[0].querySelectorAll('.ac-env-name')[1]);
  assert.equal(editorFieldEl(root, 'actions[0].ready'), rows[0].querySelector('.ac-ready-port'));
  rows[0].querySelector('.ac-ready-kind').value = 'output';
  assert.equal(editorFieldEl(root, 'actions[0].ready'), rows[0].querySelector('.ac-ready-text'));
  assert.equal(editorFieldEl(root, 'actions'), null);
  assert.equal(editorFieldEl(root, 'bogus'), null);

  const stacks = renderStackEditor(STACK_DATA(), { doc });
  const stack = stacks.querySelector('.ac-stack');
  assert.equal(editorFieldEl(stacks, 'stacks[0].label'), stack.querySelector('.ac-stack-label'));
  assert.equal(editorFieldEl(stacks, 'stacks[0].steps[1].action'), stack.querySelectorAll('.ac-step')[1].querySelector('.ac-step-action'));
  assert.equal(editorFieldEl(stacks, 'stacks[0].steps'), null);
});
