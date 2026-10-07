// git-info addition for Publish branch (#618): the local and remote-tracking tips of a
// run's feature branch, read from refs only (no network). Every command goes through
// the stubbed runner; no git is spawned.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { _testing as gitInfo, branchTips } from '../src/core/git-info.mjs';
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

test('branchTips: local and remote-tracking shas of one branch, exact ref names only', async () => {
  await checkRows([
    { name: 'branchTips: reads both refs with one for-each-ref', run: async () => {
      const calls = stub(() => ok('refs/heads/worca-cc/x aaa\nrefs/remotes/origin/worca-cc/x bbb\n'));
      assert.deepEqual(await branchTips('/p', 'worca-cc/x', 'origin'), { local: 'aaa', remote: 'bbb' });
      assert.equal(calls[0].cmd, 'git');
      assert.deepEqual(calls[0].args, ['for-each-ref', '--format=%(refname) %(objectname)',
        'refs/heads/worca-cc/x', 'refs/remotes/origin/worca-cc/x']);
      assert.equal(calls[0].opts.cwd, '/p');
    } },
    { name: 'branchTips: a ref under the branch name (prefix match) is not the branch', run: async () => {
      stub(() => ok('refs/heads/feat/sub ccc\r\nrefs/heads/feat aaa\r\n'));
      assert.deepEqual(await branchTips('/p', 'feat', 'origin'), { local: 'aaa', remote: null });
    } },
    { name: 'branchTips: no remote reads the local tip only', run: async () => {
      const calls = stub(() => ok('refs/heads/feat aaa\n'));
      assert.deepEqual(await branchTips('/p', 'feat', null), { local: 'aaa', remote: null });
      assert.deepEqual(calls[0].args, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/feat']);
    } },
    { name: 'branchTips: null on git failure or missing input (no spawn)', run: async () => {
      stub(() => fail());
      assert.equal(await branchTips('/p', 'feat', 'origin'), null);
      const calls = stub(() => ok());
      assert.equal(await branchTips(null, 'feat', 'origin'), null);
      assert.equal(await branchTips('/p', '', 'origin'), null);
      assert.equal(calls.length, 0);
    } },
  ]);
});
