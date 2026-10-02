import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  normalizeProjectActions, validatePortValue, expandPlaceholders, assertNoRawCommand,
  resolveCwd, memberAliases, normalizeStacks, ActionConfigError, isSafeOpenUrl,
} from '../src/core/actions/model.mjs';

test('normalizes a full config and fills defaults', () => {
  const cfg = normalizeProjectActions({
    setup: ' npm ci ',
    actions: [{ id: 'run', label: 'Run', kind: 'service', cmd: 'npm start',
      env: [{ name: 'PORT', type: 'port', value: 'auto' }], openUrl: 'http://localhost:{PORT}', ready: { kind: 'port' } }],
  });
  assert.equal(cfg.setup, 'npm ci');
  assert.deepEqual(cfg.actions[0].ready, { kind: 'port', port: 'PORT', timeoutMs: 60000 });
  assert.equal(cfg.actions[0].cwd, '.');
  assert.deepEqual(cfg.builtins, { editor: true, terminal: true, fileManager: true, copyCommand: true });
});

test('rejects duplicate ids, bad kinds, bad env names and escaping cwd', () => {
  const base = { id: 'a', label: 'A', kind: 'task', cmd: 'x' };
  assert.throws(() => normalizeProjectActions({ actions: [base, base] }), ActionConfigError);
  assert.throws(() => normalizeProjectActions({ actions: [{ ...base, kind: 'daemon' }] }), /kind/);
  assert.throws(() => normalizeProjectActions({ actions: [{ ...base, env: [{ name: '1X', type: 'text', value: '' }] }] }), /env name/);
  assert.throws(() => normalizeProjectActions({ actions: [{ ...base, cwd: '../up' }] }), /inside the worktree/);
  assert.throws(() => normalizeProjectActions({ actions: [{ ...base, cwd: '/etc' }] }), /inside the worktree/);
  assert.throws(() => normalizeProjectActions({ actions: [{ ...base, kind: 'service', ready: { kind: 'port' } }] }), /port variable/);
});

test('port values: auto or 1024..65535', () => {
  assert.equal(validatePortValue('auto'), 'auto');
  assert.equal(validatePortValue('4417'), 4417);
  assert.throws(() => validatePortValue('80'), /1024/);
  assert.throws(() => validatePortValue('70000'), /65535/);
  assert.throws(() => validatePortValue('12.5'), /whole number/);
});

test('placeholders expand known names only, never a shell ${…}', () => {
  const vars = { branch: 'worca-cc/x', worktree: '/w', runId: 'ab12cd34', member: 'web', PORT: 4417, 'api.PORT': 4401 };
  assert.equal(expandPlaceholders('http://localhost:{PORT}/{api.PORT}', vars), 'http://localhost:4417/4401');
  assert.equal(expandPlaceholders('find . -exec rm {} \\; ${HOME} {UNKNOWN}', vars), 'find . -exec rm {} \\; ${HOME} {UNKNOWN}');
  assert.equal(expandPlaceholders('vite --port ${PORT} --host {branch}', vars), 'vite --port ${PORT} --host worca-cc/x');
});

test('open link must be http(s)', () => {
  const svc = { id: 'run', label: 'Run', kind: 'service', cmd: 'x', env: [{ name: 'PORT', type: 'port', value: 'auto' }] };
  assert.equal(normalizeProjectActions({ actions: [{ ...svc, openUrl: 'http://localhost:{PORT}/app' }] }).actions[0].openUrl, 'http://localhost:{PORT}/app');
  assert.throws(() => normalizeProjectActions({ actions: [{ ...svc, openUrl: 'javascript:alert(1)' }] }), /http/);
  assert.throws(() => normalizeProjectActions({ actions: [{ ...svc, openUrl: 'file:///etc/passwd' }] }), /http/);
  assert.equal(isSafeOpenUrl('https://x.test'), true);
  assert.equal(isSafeOpenUrl('JavaScript:alert(1)'), false);
});

test('assertNoRawCommand rejects command-shaped bodies', () => {
  assert.doesNotThrow(() => assertNoRawCommand({ member: 'web-5e6f7a8b' }));
  for (const k of ['cmd', 'cmdWin32', 'command', 'setup', 'env', 'cwd', 'shell', 'args']) {
    assert.throws(() => assertNoRawCommand({ [k]: 'rm -rf /' }), (e) => e.code === 'RAW_COMMAND');
  }
});

test('resolveCwd pins inside the worktree', () => {
  assert.equal(resolveCwd('/w/repo', 'packages/web'), resolve('/w/repo', 'packages/web'));
  assert.throws(() => resolveCwd('/w/repo', '../x'), /inside the worktree/);
});

test('member aliases slugify and dedupe, independent of input order', () => {
  const ms = [{ projectKey: 'a-1', name: 'API' }, { projectKey: 'b-2', name: 'api' }, { projectKey: 'c-3', name: 'Web App' }];
  const want = { 'a-1': 'api', 'b-2': 'api_2', 'c-3': 'web_app' };
  assert.deepEqual(memberAliases(ms), want);
  assert.deepEqual(memberAliases(ms.slice().reverse()), want);
});

test('stack step env rows are text-only', () => {
  const memberActions = { 'api-1': [{ id: 'run', kind: 'service' }] };
  const out = normalizeStacks({ stacks: [{ id: 'dev', kind: 'service', steps: [{ member: 'api-1', action: 'run',
    env: [{ name: 'API_URL', type: 'port', value: 'http://localhost:{api.PORT}' }] }] }] }, { memberActions });
  assert.deepEqual(out.stacks[0].steps[0].env, [{ name: 'API_URL', type: 'text', value: 'http://localhost:{api.PORT}' }]);
});
