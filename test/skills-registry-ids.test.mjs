// test/skills-registry-ids.test.mjs — skill identity (skills registry design §3.1): names, ids, generated-plugin names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SKILL_NAME_RE, SKILL_NAME_MAX, RESERVED_SKILL_NAMES, SKILL_ID_SRC, SKILL_ID_RE, PLUGIN_NAME_RE, skillIdOf, parseSkillId,
} from '../src/core/skills-registry/ids.mjs';

test('the §3.1 constants, verbatim', () => {
  assert.equal(SKILL_NAME_RE.source, '^[a-z0-9]+(?:-[a-z0-9]+)*$');
  assert.equal(SKILL_NAME_MAX, 64);
  assert.deepEqual(RESERVED_SKILL_NAMES, ['synced', 'anthropic-skills']);
  assert.equal(SKILL_ID_SRC, '(?:skill:plugin:[a-z][a-z0-9]*(?:-[a-z0-9]+)*/[a-z0-9]+(?:-[a-z0-9]+)*|skill:library:[a-z0-9]+(?:-[a-z0-9]+)*)');
  assert.equal(SKILL_ID_RE.source, new RegExp('^(?=.{1,1024}$)' + SKILL_ID_SRC + '$').source);
  assert.equal(PLUGIN_NAME_RE.source, '^[a-z][a-z0-9-]{0,31}$');
});

test('valid and invalid names, ids and generated-plugin names', () => {
  const table = [
    [SKILL_NAME_RE, ['deploy-checklist', 'a', '9', 'x2-y3'], ['Deploy', 'a_b', '-a', 'a-', 'a--b', '', 'a/b', 'a.b']],
    [SKILL_ID_RE,
      ['skill:plugin:acme/deploy-checklist', 'skill:plugin:acme-tools/x', 'skill:library:release-notes', 'skill:library:9'],
      ['skill:plugin:acme', 'skill:plugin:Acme/x', 'skill:plugin:a--b/x', 'skill:plugin:9a/x', 'skill:plugin:acme/X',
        'skill:plugin:acme/a/b', 'skill:library:', 'skill:library:a_b', 'skill:lib:x', 'plugin:acme/x', 'skill:library:x\n',
        `skill:library:${'a'.repeat(1020)}`]],
    [PLUGIN_NAME_RE, ['billing', 'general', 'billing-set-2', 'a'.repeat(32)], ['Billing', '2x', 'a_b', 'a'.repeat(33), '']],
  ];
  for (const [re, valid, invalid] of table) {
    for (const s of valid) assert.match(s, re, s);
    for (const s of invalid) assert.doesNotMatch(s, re, JSON.stringify(s));
  }
});

test('skillIdOf formats; parseSkillId round-trips and refuses what SKILL_ID_RE refuses', () => {
  assert.equal(skillIdOf({ source: 'plugin', plugin: 'acme', name: 'deploy-checklist' }), 'skill:plugin:acme/deploy-checklist');
  assert.equal(skillIdOf({ source: 'library', name: 'release-notes' }), 'skill:library:release-notes');
  assert.equal(skillIdOf({ source: 'manual', name: 'x' }), null);
  assert.equal(skillIdOf(), null);
  assert.deepEqual(parseSkillId('skill:plugin:acme-tools/deploy-checklist'), { source: 'plugin', plugin: 'acme-tools', name: 'deploy-checklist' });
  assert.deepEqual(parseSkillId('skill:library:release-notes'), { source: 'library', plugin: null, name: 'release-notes' });
  for (const id of ['skill:plugin:acme/X', 'manual:pg', '', null, 7, 'skill:library:a_b']) assert.equal(parseSkillId(id), null, String(id));
  const ref = { source: 'plugin', plugin: 'acme', name: 'x' };
  assert.deepEqual(parseSkillId(skillIdOf(ref)), ref);
});
