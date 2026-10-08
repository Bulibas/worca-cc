// test/mcp-store-skills-compat.test.mjs — skills registry §2b-1: mcp/sets.json stays schema 1 and every skills key sits inside
// an object the store already reads, keeps and writes back verbatim. This file imports only what the store exported before
// skills, so it also passes against the store as it was before skills (1515292a) — the older Worca a user may go back to.
// Known limit, by design not tested: an older Worca writes General only while it has an MCP member, so General's skills
// survive a downgrade only then.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshHomes, put, disk } from './helpers/mcp-store-fixtures.mjs';
import { readMcpStore, createSet, renameSet, putMember, setTeamState, setProjectAssignment, addManualServer } from '../src/core/mcp/store.mjs';

freshHomes(after);
const TEAM = 'team-acme-platform-9333';
const SKILLS = [{ skill: 'skill:plugin:acme-tools/deploy-checklist', enabled: true }, { skill: 'skill:library:release-notes', enabled: false, later: 'kept' }];
const TEAM_SKILLS = { 'skill:plugin:acme-tools/deploy-checklist': { enabled: true, consent: 'c'.repeat(64), later: 1 } };

test('every set write keeps sets[].skills and teams[].skills verbatim, and the file stays schema 1', async () => {
  put('sets', {
    sets: {
      general: { name: 'General', members: [{ server: 'manual:pg', enabled: true, values: {} }], skills: [SKILLS[1]] },
      billing: { name: 'Billing', slug: 'billing', members: [], skills: SKILLS },
    },
    teams: { 'acme/platform': { id: TEAM, slug: 'team-platfor', name: 'Team · acme/platform', members: {}, skills: TEAM_SKILLS } },
    projects: {},
  });
  const def = await addManualServer('pg', { type: 'stdio', command: 'npx', args: ['-y', 'pg-mcp'], fields: [], description: 'pg' });
  for (const write of [
    () => renameSet('billing', 'Billing EU'),
    () => createSet('Shop'),
    () => putMember('billing', 'manual:pg', { enabled: true }, { def }),
    () => setTeamState('acme/platform', 'manual:pg', { enabled: false }),
    () => setProjectAssignment('billing-1a2b3c4d', { sets: ['billing'], includeGeneral: true }),
  ]) {
    await write();
    const d = disk('sets');
    assert.equal(d.schema, 1);
    assert.deepEqual(d.sets.billing.skills, SKILLS);
    assert.deepEqual(d.sets.general.skills, [SKILLS[1]]);
    assert.deepEqual(d.teams['acme/platform'].skills, TEAM_SKILLS);
  }
  const s = await readMcpStore();
  assert.deepEqual(JSON.parse(JSON.stringify(s.sets.billing.skills)), SKILLS, 'a read keeps them as written');
});
