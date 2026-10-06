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
import { checkRows } from './helpers/rows.mjs';

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

test('prLifecycleState: CLOSED/OPEN/MERGED pass through; null on gh failure, bad JSON, unknown state or missing input (no spawn)', async () => {
  await checkRows([
    { name: 'prLifecycleState: reports CLOSED (unlike findPrForBranch)', run: async () => {
      const calls = stub(() => ok('{"state":"CLOSED"}'));
      assert.equal(await prLifecycleState({ projectDir: '/p', prUrl: PR }), 'CLOSED');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].cmd, 'gh');
      assert.deepEqual(calls[0].args, ['pr', 'view', PR, '--json', 'state']);
      assert.equal(calls[0].opts.cwd, '/p');
    } },
    { name: 'prLifecycleState: OPEN and MERGED pass through', run: async () => {
      stub(() => ok('{"state":"OPEN"}'));
      assert.equal(await prLifecycleState({ projectDir: '/p', prUrl: PR }), 'OPEN');
      stub(() => ok('{"state":"MERGED"}'));
      assert.equal(await prLifecycleState({ projectDir: '/p', prUrl: PR }), 'MERGED');
    } },
    { name: 'prLifecycleState: null on gh failure, bad JSON, unknown state or missing input', run: async () => {
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
    } },
  ]);
});

test('Check out branch discovery + restore: branchPushedTo cases and restoreBranchFromRemote argv/failure', async () => {
  await checkRows([
    { name: 'branchPushedTo: finds origin among several remotes', run: async () => {
      const calls = stub(() => ok('refs/remotes/fork/feat\nrefs/remotes/origin/feat\n'));
      assert.deepEqual(await branchPushedTo('/p', 'feat'), { remote: 'origin' });
      assert.deepEqual(calls[0].args, ['for-each-ref', '--format=%(refname)', 'refs/remotes/*/feat']);
      assert.equal(calls[0].opts.cwd, '/p');
    } },
    { name: 'branchPushedTo: falls back to the first remote when origin lacks it', run: async () => {
      stub(() => ok('refs/remotes/fork/feat\r\nrefs/remotes/upstream/feat\r\n'));
      assert.deepEqual(await branchPushedTo('/p', 'feat'), { remote: 'fork' });
    } },
    { name: 'branchPushedTo: slashed branch name worca-cc/x', run: async () => {
      const calls = stub(() => ok('refs/remotes/origin/worca-cc/x\n'));
      assert.deepEqual(await branchPushedTo('/p', 'worca-cc/x'), { remote: 'origin' });
      assert.deepEqual(calls[0].args, ['for-each-ref', '--format=%(refname)', 'refs/remotes/*/worca-cc/x']);
    } },
    { name: 'branchPushedTo: null when not pushed or git fails', run: async () => {
      stub(() => ok(''));
      assert.equal(await branchPushedTo('/p', 'feat'), null);
      stub(() => fail());
      assert.equal(await branchPushedTo('/p', 'feat'), null);
    } },
    { name: 'restoreBranchFromRemote: issues git branch <b> refs/remotes/<r>/<b>', run: async () => {
      const calls = stub(() => ok());
      assert.equal(await restoreBranchFromRemote('/p', 'worca-cc/x', 'origin'), true);
      assert.equal(calls[0].cmd, 'git');
      assert.deepEqual(calls[0].args, ['branch', '--', 'worca-cc/x', 'refs/remotes/origin/worca-cc/x']);
      assert.equal(calls[0].opts.cwd, '/p');
    } },
    { name: 'restoreBranchFromRemote: false when git fails', run: async () => {
      stub(() => fail('fatal: not a valid object name'));
      assert.equal(await restoreBranchFromRemote('/p', 'feat', 'origin'), false);
    } },
  ]);
});
