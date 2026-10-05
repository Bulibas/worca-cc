// test/graph-constants.test.mjs — the shared v2 vocabulary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gatePorts, NODE_ID_RE, WIRE_ID_RE, PORT_ID_RE, MAX_PORTS_PER_SIDE,
} from '../src/shared/graph/constants.mjs';
import { checkRows } from './helpers/rows.mjs';

test('gatePorts: in1..inN + out per kind, arity clamped to [2, MAX_PORTS_PER_SIDE], never throws', async () => {
  await checkRows([
    { name: 'gatePorts: in1..inN + out, with the per-kind out type', run: () => {
      const and = gatePorts('and', 3);
      assert.deepEqual(and.inputs.map((p) => p.id), ['in1', 'in2', 'in3']);
      assert.deepEqual(and.inputs.map((p) => p.type), ['any', 'any', 'any']);
      assert.deepEqual({ ...and.outputs[0] }, { id: 'out', type: 'void', when: 'always' });
      const or = gatePorts('or', 2);
      assert.deepEqual(or.inputs.map((p) => p.type), ['any', 'any']);
      assert.equal(or.outputs[0].type, 'any', 'OR out stays any until resolved from wiring');
      const combine = gatePorts('combine', 2);
      assert.deepEqual(combine.inputs.map((p) => p.type), ['md', 'md']);
      assert.equal(combine.outputs[0].type, 'md');
    } },
    { name: 'gatePorts: arity is clamped to [2, MAX_PORTS_PER_SIDE] and never throws', run: () => {
      for (const bad of [undefined, null, 0, 1, -4, NaN, 'x', {}]) {
        assert.equal(gatePorts('and', bad).inputs.length, 2, `arity ${String(bad)} -> 2`);
      }
      assert.equal(gatePorts('and', 99).inputs.length, MAX_PORTS_PER_SIDE);
      assert.equal(gatePorts('and', 2.9).inputs.length, 2);
      assert.ok(Object.isFrozen(gatePorts('or', 2)) && Object.isFrozen(gatePorts('or', 2).inputs[0]));
    } },
  ]);
});

test('id shapes: minted ids and the seed graphs both match', () => {
  for (const id of ['n_task', 'n_or', 'n_a1b2c3d4']) assert.match(id, NODE_ID_RE);
  for (const id of ['task', 'N_task', 'n_', 'n_Task', 'w1']) assert.doesNotMatch(id, NODE_ID_RE);
  for (const id of ['w1', 'w17', 'w_a1b2c3d4']) assert.match(id, WIRE_ID_RE);
  for (const id of ['fb_0', 'W1', 'n_task', 'w_']) assert.doesNotMatch(id, WIRE_ID_RE);
  for (const id of ['task', 'revise', 'in1', 'await', 'planStoreSeed']) assert.match(id, PORT_ID_RE);
  for (const id of ['Task', 'in-1', 'in_1', '1in', '', 'x'.repeat(33)]) assert.doesNotMatch(id, PORT_ID_RE);
});
