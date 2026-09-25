import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMetaV2, normalizeAgentMeta } from '../src/shared/graph/agent-meta.mjs';

const base = (outputs) => ({
  key: 'x', metaVersion: 2, runnerType: 'producer', inputs: [{ id: 'in', type: 'md' }], outputs,
});

test('extraFiles: one-level globs under the pipeline dir are kept, each with a kind', () => {
  const { meta, errors } = normalizeAgentMeta(base([{ id: 'built', type: 'md', filename: 'deck-manifest.md',
    extraFiles: [{ kind: 'deck', glob: 'deck/*' }, { kind: 'deck-shot', glob: 'shots/*.png' }] }]), { warn() {} });
  assert.deepEqual(errors, []);
  assert.deepEqual(meta.outputs[0].extraFiles, [{ kind: 'deck', glob: 'deck/*' }, { kind: 'deck-shot', glob: 'shots/*.png' }]);
});

test('extraFiles: traversal, absolute paths, nested wildcards and void ports are errors', () => {
  const bad = (extraFiles, type = 'md', filename = 'a.md') =>
    validateMetaV2(base([{ id: 'o', type, ...(type === 'void' ? {} : { filename }), extraFiles }])).errors;
  assert.match(bad([{ kind: 'k', glob: '../x/*' }])[0], /extraFiles/);
  assert.match(bad([{ kind: 'k', glob: '/abs/*' }])[0], /extraFiles/);
  assert.match(bad([{ kind: 'k', glob: 'a/*/b' }])[0], /extraFiles/);
  assert.match(bad([{ glob: 'a/*' }])[0], /kind/);
  assert.match(bad([{ kind: 'k', glob: 'a/*' }], 'void')[0], /void/);
});

// `[A-Za-z0-9_.-]+` accepts a BARE DOT as the directory segment, and the `..`
// check does not catch it — so `./deck.html` validated. _indexExtraFiles then
// keys its prune on the prefix "./", which matches no stored row (a top-level
// file is stored under its bare name), and every top-level file is re-attributed
// on every sweep. Sidecars are agent-written, so the validator says no.
test('extraFiles: a "./" directory segment is rejected, a real dotted dir is not', () => {
  const bad = (glob) => validateMetaV2(base([{ id: 'o', type: 'md', filename: 'a.md',
    extraFiles: [{ kind: 'k', glob }] }])).errors;
  assert.match(bad('./deck.html')[0], /extraFiles/);
  assert.match(bad('./*.png')[0], /extraFiles/);
  assert.deepEqual(bad('.worca/x.json'), [], 'a genuinely dotted directory is still legal');
  assert.deepEqual(bad('deck/deck.html'), []);
});
