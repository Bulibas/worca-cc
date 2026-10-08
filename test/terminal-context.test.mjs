// test/terminal-context.test.mjs — where a run's terminal opens, and what env it starts with (#573).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTempHome } from './helpers/temp-home.mjs';
import { terminalTargets, terminalEnv, LIVE_WARNING } from '../src/core/terminal/context.mjs';

useTempHome(after);
const dir = mkdtempSync(join(tmpdir(), 'term-ctx-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const projectRow = (extra) => ({ id: 'r1', target: 'project', project_key: 'app-0000aaaa', status: 'running',
  branch: JSON.stringify({ feature: 'worca/f', worktreeDir: dir }), workspace_meta: null, ...extra });

test('a running run opens its live worktree, with the warning', () => {
  const t = terminalTargets(projectRow(), { isLive: () => true });
  assert.equal(t.live, true);
  assert.deepEqual(t.members.map((m) => [m.state, m.cwd, m.branch, m.warning]), [['worktree', dir, 'worca/f', LIVE_WARNING]]);
});

test('a paused run with a folder opens it without the warning; one without a folder is unavailable', () => {
  assert.equal(terminalTargets(projectRow({ status: 'paused' })).members[0].warning, undefined);
  const gone = terminalTargets(projectRow({ status: 'paused', branch: JSON.stringify({ feature: 'f', worktreeDir: join(dir, 'nope') }) }));
  assert.equal(gone.members[0].state, 'unavailable');
});

test('a finished run opens its checkout, or asks for one', () => {
  const kept = projectRow({ status: 'done', branch: JSON.stringify({ feature: 'f', worktreeDir: dir, checkout: { at: 't', by: 'x', policy: 'on-demand' } }) });
  assert.deepEqual(terminalTargets(kept).members.map((m) => [m.state, m.cwd]), [['checkout', dir]]);
  const none = projectRow({ status: 'done', branch: JSON.stringify({ feature: 'f' }) });
  assert.deepEqual(terminalTargets(none).members.map((m) => [m.state, m.cwd]), [['needs-checkout', null]]);
});

test('a workspace run lists one target per member', () => {
  const row = { id: 'w1', target: 'workspace', project_key: null, status: 'running', branch: null,
    workspace_meta: JSON.stringify({ projects: [{ projectKey: 'api-0000bbbb', projectName: 'api', projectDir: '/p/api' }, { projectKey: 'web-0000cccc', projectName: 'web', projectDir: '/p/web' }],
      branches: { 'api-0000bbbb': { feature: 'f', worktreeDir: dir }, 'web-0000cccc': { feature: 'f', worktreeDir: join(dir, 'missing') } } }) };
  const t = terminalTargets(row, { isLive: () => true });
  assert.equal(t.workspace, true);
  assert.deepEqual(t.members.map((m) => [m.projectName, m.state]), [['api', 'worktree'], ['web', 'unavailable']]);
});

test('terminalEnv: run vars, action ports, stripped secrets, pipes extras', () => {
  const env = terminalEnv({
    base: { PATH: '/bin', GH_TOKEN: 'secret', WORCA_HOME: '/h', HOME: '/u', PORT: '4317' }, sessionId: 't-1', mode: 'pipes',
    runId: 'r1', member: 'api-0000bbbb', projectKey: 'api-0000bbbb', branch: 'worca/f', cwd: dir, workspace: true,
    actionSnaps: [{ member: 'api-0000bbbb', actionId: 'dev-server', ports: { PORT: 4401 }, url: 'http://127.0.0.1:4401/' }],
    shellEnv: { BASH_SILENCE_DEPRECATION_WARNING: '1' },
  });
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.WORCA_HOME, undefined);
  assert.equal(env.PORT, undefined, 'worca\'s own port is not passed on');
  assert.equal(env.HOME, '/u');
  assert.equal(env.TERM, 'dumb');
  assert.equal(env.PAGER, 'cat');
  assert.equal(env.WORCA_RUN_ID, 'r1');
  assert.equal(env.WORCA_BRANCH, 'worca/f');
  assert.equal(env.WORCA_TERMINAL_SESSION, 't-1');
  assert.equal(env.WORCA_PORT_API_0000BBBB_DEV_SERVER_PORT, '4401');
  assert.equal(env.WORCA_URL_API_0000BBBB_DEV_SERVER, 'http://127.0.0.1:4401/');
  assert.equal(env.BASH_SILENCE_DEPRECATION_WARNING, '1');
  const single = terminalEnv({ base: {}, sessionId: 't-2', mode: 'pty', cwd: dir, actionSnaps: [{ member: 'x', actionId: 'web', ports: { PORT: 4402 } }] });
  assert.equal(single.WORCA_PORT_WEB_PORT, '4402');
  assert.equal(single.TERM, 'xterm-256color');
  assert.equal(single.PAGER, undefined);
});

test('terminalEnv agent: no pager, no git prompt, no user rc, even under a pty', () => {
  const env = terminalEnv({ base: { PATH: '/bin' }, sessionId: 't-1', mode: 'pty', cwd: '/w', agent: true });
  assert.equal(env.PAGER, 'cat'); assert.equal(env.GIT_PAGER, 'cat');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0'); assert.equal(env.WORCA_TERMINAL_NORC, '1');
  const person = terminalEnv({ base: { PATH: '/bin' }, sessionId: 't-2', mode: 'pty', cwd: '/w' });
  assert.equal(person.PAGER, undefined); assert.equal(person.WORCA_TERMINAL_NORC, undefined);
});
