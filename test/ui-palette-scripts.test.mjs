// test/ui-palette-scripts.test.mjs — the Scripts palette group (spec §10.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paletteEntries, SCRIPTS_GROUP } from '../ui/public/graph/palette.mjs';

const AGENTS = [
  { key: 'planner', displayName: 'Plan', domain: 'coding', color: 'violet', order: 1, inputs: [{ id: 'task', type: 'md' }], outputs: [{ id: 'plan', type: 'md' }] },
  { key: 'writer', displayName: 'Writer', domain: 'general', color: 'green', order: 9, inputs: [], outputs: [{ id: 'doc', type: 'md' }] },
];
const SCRIPTS = [
  { key: 'gitDiff', displayName: 'Git diff', runtime: 'node', color: 'green', order: 30, inputs: [{ id: 'done', type: 'void' }], outputs: [{ id: 'diff', type: 'md' }] },
  { key: 'shell', displayName: 'Shell', runtime: 'shell', color: 'amber', order: 10, ports: 'config', defaultPorts: { inputs: [{ id: 'in', type: 'md' }], outputs: [{ id: 'log', type: 'md' }] } },
  { key: 'hidden', displayName: 'Hidden', runtime: 'node', order: 1, placeable: false, inputs: [], outputs: [] },
];

test('paletteEntries: the Scripts group sits between the domain groups and the pinned Flow group, ordered, placeable only', () => {
  const groups = paletteEntries(AGENTS, { scripts: SCRIPTS });
  assert.deepEqual(groups.map((g) => g.domain), ['coding', 'general', SCRIPTS_GROUP, 'flow']);
  const s = groups[2];
  assert.equal(s.scripts, true);
  assert.equal(s.flow, false);
  assert.deepEqual(s.agents.map((e) => [e.key, e.kind, e.chip, e.portLine]), [['shell', 'script', 'shell', 'in/out (per card)'], ['gitDiff', 'script', 'node', 'in done · out diff']]);
  assert.equal(paletteEntries(AGENTS, {}).some((g) => g.scripts), false, 'no scripts: no group');
});
