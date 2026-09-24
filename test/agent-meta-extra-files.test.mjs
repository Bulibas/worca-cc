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
