// git-info additions for Check out (#529): PR lifecycle lookup that reports
// CLOSED, remote-tracking branch discovery and local branch restore.
// Every command goes through the stubbed runner; no git or gh is spawned.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  _testing as gitInfo,
  prLifecycleState,
  branchPushedTo,
  restoreBranchFromRemote,
} from '../src/core/git-info.mjs';

const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' });
const fail = (stderr = 'boom') => ({ ok: false, code: 1, stdout: '', stderr });

function stub(answer) {
  const calls = [];
  gitInfo.setRunner(async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return answer(cmd, args, opts);
  });
  return calls;
}

afterEach(() => gitInfo.reset());

const PR = 'https://github.com/acme/app/pull/7';

test('prLifecycleState: reports CLOSED (unlike findPrForBranch)', async () => {
  const calls = stub(() => ok('{"state":"CLOSED"}'));
  assert.equal(await prLifecycleState({ projectDir: '/p', prUrl: PR }), 'CLOSED');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'gh');
  assert.deepEqual(calls[0].args, ['pr', 'view', PR, '--json', 'state']);
  assert.equal(calls[0].opts.cwd, '/p');
});

test('prLifecycleState: OPEN and MERGED pass through', async () => {
  stub(() => ok('{"state":"OPEN"}'));
  assert.equal(await prLifecycleState({ projectDir: '/p', prUrl: PR }), 'OPEN');
  stub(() => ok('{"state":"MERGED"}'));
  assert.equal(await prLifecycleState({ projectDir: '/p', prUrl: PR }), 'MERGED');
});

test('prLifecycleState: null on gh failure, bad JSON, unknown state or missing input', async () => {
  stub(() => fail());
  assert.equal(await prLifecycleState({ projectDir: '/p', prUrl: PR }), null);
  stub(() => ok('not json'));
  assert.equal(await prLifecycleState({ projectDir: '/p', prUrl: PR }), null);
  stub(() => ok('{"state":"DRAFT"}'));
  assert.equal(await prLifecycleState({ projectDir: '/p', prUrl: PR }), null);
  const calls = stub(() => ok('{"state":"OPEN"}'));
  assert.equal(await prLifecycleState({ projectDir: '/p', prUrl: null }), null);
  assert.equal(await prLifecycleState({ projectDir: null, prUrl: PR }), null);
  assert.equal(calls.length, 0);
});

test('branchPushedTo: finds origin among several remotes', async () => {
  const calls = stub(() => ok('refs/remotes/fork/feat\nrefs/remotes/origin/feat\n'));
  assert.deepEqual(await branchPushedTo('/p', 'feat'), { remote: 'origin' });
  assert.deepEqual(calls[0].args, ['for-each-ref', '--format=%(refname)', 'refs/remotes/*/feat']);
  assert.equal(calls[0].opts.cwd, '/p');
});

test('branchPushedTo: falls back to the first remote when origin lacks it', async () => {
  stub(() => ok('refs/remotes/fork/feat\r\nrefs/remotes/upstream/feat\r\n'));
  assert.deepEqual(await branchPushedTo('/p', 'feat'), { remote: 'fork' });
});

test('branchPushedTo: slashed branch name worca-cc/x', async () => {
  const calls = stub(() => ok('refs/remotes/origin/worca-cc/x\n'));
  assert.deepEqual(await branchPushedTo('/p', 'worca-cc/x'), { remote: 'origin' });
  assert.deepEqual(calls[0].args, ['for-each-ref', '--format=%(refname)', 'refs/remotes/*/worca-cc/x']);
});

test('branchPushedTo: null when not pushed or git fails', async () => {
  stub(() => ok(''));
  assert.equal(await branchPushedTo('/p', 'feat'), null);
  stub(() => fail());
  assert.equal(await branchPushedTo('/p', 'feat'), null);
});

test('restoreBranchFromRemote: issues git branch <b> refs/remotes/<r>/<b>', async () => {
  const calls = stub(() => ok());
  assert.equal(await restoreBranchFromRemote('/p', 'worca-cc/x', 'origin'), true);
  assert.equal(calls[0].cmd, 'git');
  assert.deepEqual(calls[0].args, ['branch', '--', 'worca-cc/x', 'refs/remotes/origin/worca-cc/x']);
  assert.equal(calls[0].opts.cwd, '/p');
});

test('restoreBranchFromRemote: false when git fails', async () => {
  stub(() => fail('fatal: not a valid object name'));
  assert.equal(await restoreBranchFromRemote('/p', 'feat', 'origin'), false);
});
