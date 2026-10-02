// test/policy-night-fields.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIELDS, fieldMeta, validateValue } from '../src/core/policy/registry.mjs';
import { fmtValue } from '../src/core/policy/effective.mjs';

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

test('the policy editor can render, read and format every night.* field', () => {
  // Every night row uses a type the editor already handles, or the new 'criteria' type.
  const EDITOR_TYPES = ['usd', 'int', 'usd-or-null', 'bool', 'enum', 'string', 'semver', 'string[]', 'plugins', 'steps', 'criteria'];
  const rows = FIELDS.filter((x) => x.key.startsWith('night.'));
  assert.equal(rows.length, 15);
  for (const f of rows) assert.ok(EDITOR_TYPES.includes(f.type), `${f.key} type ${f.type}`);
  assert.equal(fmtValue(fieldMeta('night.criteria'), { cost: 2, reversible: 3 }), 'cost 2 · reversible 3');
});
