// test/ui-script-wizard.test.mjs — the two steps' pixels (script-wizard plan S1, S9, S11, S16, S20): pure renderers, jsdom.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  renderRuntimeStep, renderWorkspace, renderInterfacePanel, collectScriptDraft, EDITOR_LANGUAGE, IFACE_HINTS,
} from '../ui/public/script-wizard.mjs';
import { iconSvgOf } from '../src/shared/graph/script-icons.mjs';
import { inferInterface, mergeInterface } from '../src/shared/graph/script-infer.mjs';
import { blankScriptMeta, SCRIPT_EXAMPLES } from '../src/shared/graph/script-templates.mjs';

const win = new JSDOM('<!doctype html><body></body>').window;
const doc = win.document;
const RUNTIMES = { node: { ok: true, version: '22.13.0' }, shell: { ok: true, path: '/bin/sh' },
  python: { ok: false, reason: 'no python 3.8 or newer found (tried python3, python)' } };
const q = (root, sel) => root.querySelector(sel);
const qa = (root, sel) => [...root.querySelectorAll(sel)];
const dispose = (root) => (root._editors || []).forEach((e) => e.destroy());

const USER_META = {
  key: 'diffGate', metaVersion: 2, displayName: 'Diff gate', description: 'Blocks wide diffs.', domain: 'coding', color: 'teal',
  icon: iconSvgOf('funnel'), order: 20, origin: 'user', runtime: 'node', file: 'diffGate.mjs', timeoutMs: 120000,
  params: [{ id: 'maxFiles', type: 'number', default: 10, required: false }, { id: 'mode', type: 'enum', options: ['a', 'b'], default: 'a', required: false }],
  inputs: [{ id: 'done', type: 'void', required: false }],
  outputs: [{ id: 'report', type: 'md', when: 'blocking', filename: 'r-{cycle}.md' }],
  verdict: { filename: 'dg-{cycle}.json' },
};
const USER = { meta: USER_META, source: SCRIPT_EXAMPLES.node.source, sourceWin32: '', sourcePath: '/home/u/.worca-cc/scripts/diffGate.mjs',
  sourceTruncated: false, cases: [], userCases: [], casesWritable: true };
const rowsFor = (data) => mergeInterface({ inferred: inferInterface(data.source, data.meta.runtime), saved: data.meta });

test('read-only: every control disabled, no Save, no Load example, no runtime change, the path and Copy', () => {
  const data = { ...USER, meta: { ...USER_META, origin: 'builtin' } };
  const root = renderWorkspace(data, { doc, runtimes: RUNTIMES, rows: rowsFor(data), verdict: true, readOnly: true, highlight: async (t) => t });
  // the code editor's textarea is READ-ONLY (createCodeEditor's own rule), not disabled: it stays scrollable and selectable
  for (const c of qa(root, 'input:not([type="hidden"]),textarea:not(.code-editor-ta),.sw,.ico,.tchip,[data-routing]')) assert.equal(c.disabled, true, c.outerHTML.slice(0, 60));
  assert.equal(q(root, '.code-editor-ta').readOnly, true);
  assert.equal(q(root, '.script-save'), null);
  assert.equal(q(root, '.wz-example'), null);
  assert.equal(q(root, '.wz-step-pill[data-step="1"]').disabled, true);
  assert.equal(q(root, '.script-path').textContent, USER.sourcePath);
  assert.ok(q(root, '.script-copy'));
  assert.ok(q(root, '.code-editor').classList.contains('ro'));
  dispose(root);
});

test('collectScriptDraft (node): the POST body — identity, minted and saved filenames, the verdict, typed defaults, a removed row is gone', () => {
  const rows = rowsFor(USER);
  const root = renderWorkspace(USER, { doc, runtimes: RUNTIMES, rows, verdict: true, highlight: async (t) => t });
  const d = collectScriptDraft(root);
  assert.equal(d.meta.key, 'diffGate');
  assert.equal(d.meta.color, 'teal');
  assert.equal(d.meta.icon, iconSvgOf('funnel'));
  assert.equal(d.meta.timeoutMs, 120000);
  assert.deepEqual(d.meta.inputs, [{ id: 'plan', type: 'md', required: false }, { id: 'diff', type: 'md', required: false }, { id: 'done', type: 'void', required: false }]);
  assert.deepEqual(d.meta.outputs, [{ id: 'report', type: 'md', when: 'blocking', filename: 'r-{cycle}.md' }]);
  assert.deepEqual(d.meta.params, [{ id: 'maxFiles', type: 'number', default: 10, required: false }, { id: 'mode', type: 'enum', default: 'a', required: false, options: ['a', 'b'] }]);
  assert.deepEqual(d.meta.verdict, { filename: 'dg-{cycle}.json' }, 'the workspace hands the panel the sidecar`s verdict filename');
  assert.equal(d.meta.ports, null);
  assert.equal(d.meta.command, null);
  assert.equal(d.source, SCRIPT_EXAMPLES.node.source);
  assert.equal(d.sourceWin32, '');
  // a panel painted WITHOUT the saved filename (a new script) mints one from the key
  q(root, '.wz-iface').replaceWith(renderInterfacePanel({ doc, runtime: 'node', key: 'diffGate', rows, verdict: true }));
  assert.deepEqual(collectScriptDraft(root).meta.verdict, { filename: 'diffGate-cycle{cycle}.json' });
  // drop the stale row from the DOM (what the controller does on ×): the draft no longer carries it
  q(root, '.wz-prow[data-id="done"]').remove();
  assert.deepEqual(collectScriptDraft(root).meta.inputs.map((p) => p.id), ['plan', 'diff']);
  dispose(root);
});

test('collectScriptDraft (shell): routing mints pass/fail, exit codes ride, Command mode sends a command and no file', () => {
  const meta = { ...blankScriptMeta('shell'), key: 'runTests', displayName: 'Run tests', exitCodes: { clean: [0], blocking: [1, 2] } };
  const data = { meta, source: SCRIPT_EXAMPLES.shell.source, sourceWin32: '' };
  const rows = rowsFor(data);
  const root = renderWorkspace(data, { doc, runtimes: RUNTIMES, isNew: true, rows, routing: true, srcMode: 'file', highlight: async (t) => t });
  const d = collectScriptDraft(root);
  assert.deepEqual(d.meta.outputs.map((p) => [p.id, p.when]), [['log', 'always'], ['pass', 'clean'], ['fail', 'blocking']]);
  assert.deepEqual(d.meta.verdict, { filename: 'runTests-cycle{cycle}.json' });
  assert.deepEqual(d.meta.exitCodes, { clean: [0], blocking: [1, 2] });
  assert.deepEqual(d.meta.params, [{ id: 'command', type: 'string', default: 'npm test', required: false }]);
  assert.equal(d.source, SCRIPT_EXAMPLES.shell.source);
  dispose(root);
  const cmd = { meta: { ...meta, command: 'npm test', file: null }, source: '', sourceWin32: '' };
  const croot = renderWorkspace(cmd, { doc, runtimes: RUNTIMES, isNew: true, rows: rowsFor({ ...cmd, source: 'npm test' }), routing: true, srcMode: 'command', highlight: async (t) => t });
  const c = collectScriptDraft(croot);
  assert.equal(c.meta.command, 'npm test');
  assert.equal(c.source, '');
  assert.equal(q(croot, '.wz-file').textContent, 'command');
  dispose(croot);
});

test('collectScriptDraft (config): ports:"config" and the defaultPorts pass through untouched, the sidecar`s verdict too', () => {
  const meta = { key: 'shellCopy', metaVersion: 2, displayName: 'Shell copy', origin: 'user', runtime: 'shell', color: 'amber', icon: '', order: 99, timeoutMs: 600000,
    ports: 'config', defaultPorts: { inputs: [{ id: 'in', type: 'md', required: false }], outputs: [{ id: 'log', type: 'md', when: 'always', filename: 'shell-cycle{cycle}.md' }, { id: 'pass', type: 'void', when: 'clean' }] },
    verdict: { filename: 'shell-cycle{cycle}.json' }, params: [{ id: 'command', type: 'command', required: true }] };
  const data = { meta, source: '', sourceWin32: '' };
  const root = renderWorkspace(data, { doc, runtimes: RUNTIMES, rows: rowsFor({ ...data, source: 'x' }), srcMode: 'command', highlight: async (t) => t });
  const d = collectScriptDraft(root);
  assert.equal(d.meta.ports, 'config');
  assert.deepEqual(d.meta.defaultPorts, meta.defaultPorts);
  assert.equal(d.meta.inputs, null);
  assert.deepEqual(d.meta.verdict, { filename: 'shell-cycle{cycle}.json' });
  assert.deepEqual(d.meta.params, [{ id: 'command', type: 'command', required: true }]);
  dispose(root);
});
