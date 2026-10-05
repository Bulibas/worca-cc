// test/policy-night-fields.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fieldMeta, validateValue } from '../src/core/policy/registry.mjs';

test('night.* fields are default-kind and validate', () => {
  for (const f of ['enabled', 'window', 'strategy', 'criteria', 'neverDecide', 'spendCapUsd']) {
    const m = fieldMeta(`night.${f}`); assert.ok(m, f); assert.deepEqual(m.kinds, ['default']);
  }
  assert.equal(validateValue(fieldMeta('night.criteria'), { cost: 2 }), null);
  assert.match(validateValue(fieldMeta('night.criteria'), { nope: 2 }), /criterion/);
  assert.match(validateValue(fieldMeta('night.window'), '8pm'), /HH:MM/);
  assert.match(validateValue(fieldMeta('night.neverDecide'), ['gate', 'nope']), /neverDecide/);
  assert.match(validateValue(fieldMeta('night.timeZone'), 'Mars/Base'), /IANA/);
  assert.equal(validateValue(fieldMeta('night.graceMinutes'), 30), null);
});
