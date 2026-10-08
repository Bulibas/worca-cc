// test/mcp-sets-collect.test.mjs — set collection shared by the MCP and skills resolvers (skills registry §4.2): collectSets
// in src/core/mcp/sets.mjs returns each set's servers and skills; Team skills derive from `skills.required`; workspaces
// bring their members' sets only (F7); the plugin name a set's skills load under (§4.1); the policy-cache readers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectSets, teamMembers, teamSkillMembers, pluginNameFor } from '../src/core/mcp/sets.mjs';
import * as registry from '../src/core/mcp/registry.mjs';
import { canonicalJson, sha256Hex } from '../src/core/mcp/definitions.mjs';

const nul = (o) => Object.assign(Object.create(null), o);
const DEPLOY = 'skill:plugin:acme-tools/deploy-checklist';
const LINT = 'skill:plugin:acme-tools/lint';
const NOTES = 'skill:library:release-notes';
const SENTRY = 'plugin:acme-tools/sentry';
const SKILL_CATALOG = [{ id: DEPLOY }, { id: LINT }, { id: NOTES }, { id: 'skill:plugin:other-tools/lint' }];
const TEAM = 'team-acme-platform-9333';
const consentOf = (plugin, skill) => sha256Hex(canonicalJson({ plugin, skill }));   // the Team checklist's consent hash (§2b-10)
const DEPLOY_OK = consentOf('acme-tools', 'deploy-checklist');
function store(over = {}) {
  return {
    catalog: SKILL_CATALOG,
    sets: nul({
      general: { name: 'General', members: [], skills: [{ skill: NOTES, enabled: true }] },
      billing: { name: 'Billing', slug: 'billing', members: [{ server: SENTRY, enabled: true, values: {} }],
        skills: [{ skill: DEPLOY, enabled: true }, { skill: LINT, enabled: true, pending: true }, { skill: 'skill:library:gone', enabled: false }] },
      shop: { name: 'Shop', slug: 'shop', members: [] },
    }),
    teams: nul({ 'acme/platform': { id: TEAM, slug: 'team-platfor', name: 'Team · acme/platform', members: nul({}),
      skills: nul({ [DEPLOY]: { enabled: true, consent: DEPLOY_OK }, [LINT]: { enabled: true, consent: { not: 'text' } } }) } }),
    projects: nul({ 'billing-1a2b3c4d': { sets: ['billing'], includeGeneral: false }, 'shop-2b3c4d5e': { sets: ['shop'] } }),
    ...over,
  };
}
const P = (key, rank = 0, route = null) => ({ kind: 'project', key, name: key, rank, route });
const plainSets = (m) => [...m.values()].map((s) => ({ ...s, projects: [...s.projects].sort(), routes: [...s.routes] }));
const REQ = [{ plugin: 'acme-tools', skill: 'deploy-checklist' }, { plugin: 'acme-tools', skill: 'lint' }];

test('collectSets lives in sets.mjs; registry.mjs keeps exporting teamMembers (one function)', () => {
  assert.equal(registry.teamMembers, teamMembers);
  assert.equal(typeof registry.requiredSkillsOf, 'function');
});

test('every set carries its skills: a user set\'s list (pending reads off, consent null), General\'s, a Team set\'s from its policy', () => {
  const sets = collectSets({ ask: false, targets: [P('billing-1a2b3c4d'), P('shop-2b3c4d5e', 1)],
    teams: { 'billing-1a2b3c4d': { home: 'acme/platform', required: [], requiredSkills: REQ } }, store: store() });
  const byId = Object.fromEntries(plainSets(sets).map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(byId).sort(), ['billing', 'general', 'shop', TEAM]);
  assert.deepEqual(byId.billing.skills, [
    { skillId: DEPLOY, team: false, consent: null, enabled: true },
    { skillId: LINT, team: false, consent: null, enabled: false },
    { skillId: 'skill:library:gone', team: false, consent: null, enabled: false }], 'not filtered by the catalog: the resolver skips missing-skill');
  assert.deepEqual(byId.billing.members, [{ serverId: SENTRY, team: false, enabled: true, values: {} }], 'servers unchanged');
  assert.deepEqual(byId.general.skills, [{ skillId: NOTES, team: false, consent: null, enabled: true }]);
  assert.deepEqual(byId.shop.skills, []);
  assert.deepEqual(byId[TEAM].skills, [
    { skillId: DEPLOY, team: true, consent: DEPLOY_OK, enabled: true },
    { skillId: LINT, team: true, consent: null, enabled: true }], 'only the entry\'s consent hash is a consent');
  assert.deepEqual(byId[TEAM].members, [], 'the skill catalog holds no server');
  assert.deepEqual([byId[TEAM].group, byId[TEAM].provisional, byId[TEAM].projects], ['team', false, ['billing-1a2b3c4d']]);
});

test('a Team set comes for skills alone; a home with no record is named provisionally; neither list ⇒ no Team set', () => {
  const s = store({ teams: nul({}) });
  const one = plainSets(collectSets({ ask: false, targets: [P('billing-1a2b3c4d')], teams: { 'billing-1a2b3c4d': { home: 'acme/platform', required: [], requiredSkills: REQ } }, store: s }));
  const team = one.find((x) => x.group === 'team');
  assert.deepEqual([team.id, team.slug, team.provisional], [TEAM, 'team-platfor', true]);
  assert.deepEqual(team.skills.map((k) => [k.skillId, k.enabled, k.consent]), [[DEPLOY, false, null], [LINT, false, null]], 'no state: off, never consented');
  for (const t of [null, { home: 'acme/platform', required: [] }, { home: 'acme/platform', required: [], requiredSkills: [] }, { home: 'acme/platform' }]) {
    const sets = plainSets(collectSets({ ask: false, targets: [P('billing-1a2b3c4d')], teams: { 'billing-1a2b3c4d': t }, store: s }));
    assert.equal(sets.some((x) => x.group === 'team'), false, JSON.stringify(t));
  }
});

test('teamSkillMembers: plugin entries only, valid ids in the catalog; a repeated name keeps the first; state or off', () => {
  const required = [{ plugin: 'acme-tools', skill: 'lint' }, { plugin: 'other-tools', skill: 'lint' }, { plugin: 'acme-tools', skill: 'lint' },
    { plugin: 'acme-tools', skill: 'missing' }, { plugin: 'Acme', skill: 'x' }, { plugin: 'acme-tools', skill: 'a/b' }, { skill: 'lint' },
    { plugin: 'acme-tools', server: 'sentry' }, null, 'x', { plugin: 'acme-tools', skill: 'deploy-checklist' }];
  const LINT_OK = consentOf('acme-tools', 'lint');
  assert.deepEqual(teamSkillMembers('acme/platform', required, SKILL_CATALOG, nul({ [LINT]: { enabled: true, consent: LINT_OK } })), [
    { skillId: LINT, state: { enabled: true, consent: LINT_OK } },
    { skillId: DEPLOY, state: { enabled: false, consent: null } }]);
  for (const consent of ['h', consentOf('other-tools', 'lint'), DEPLOY_OK, LINT_OK.toUpperCase()]) {   // a hand edit, another entry's hash
    assert.deepEqual(teamSkillMembers('acme/platform', required, SKILL_CATALOG, nul({ [LINT]: { enabled: true, consent } }))[0],
      { skillId: LINT, state: { enabled: true, consent: null } }, `${consent}: not this entry's consent hash ⇒ never consented`);
  }
  assert.deepEqual(teamSkillMembers('acme/platform', undefined, SKILL_CATALOG, undefined), []);
});

test('workspaces attach no sets (F7): a workspace target brings its members\' sets and the workspace policy\'s Team set', () => {
  const s = store({ projects: nul({ 'billing-1a2b3c4d': { sets: ['billing'], includeGeneral: false }, 'shop-2b3c4d5e': { sets: ['shop'] },
    'ws-00000001': { sets: ['shop'], includeGeneral: true } }) });
  const ws = { kind: 'workspace', id: 'ws-00000001', name: 'Platform', rank: 0, route: null,
    members: [{ key: 'billing-1a2b3c4d', name: 'billing' }, { key: 'shop-2b3c4d5e', name: 'shop' }] };
  const sets = plainSets(collectSets({ ask: false, targets: [ws], teams: { 'ws:ws-00000001': { home: 'acme/platform', required: [], requiredSkills: REQ } }, store: s }));
  assert.deepEqual(sets.map((x) => [x.id, x.projects]).sort(), [
    ['billing', ['billing-1a2b3c4d']], ['general', ['shop-2b3c4d5e']], ['shop', ['shop-2b3c4d5e']],
    [TEAM, ['billing-1a2b3c4d', 'shop-2b3c4d5e']]], 'an assignment keyed by the workspace id is not read');
});

test('the MCP resolver is unchanged by skills: same copies and skips; its catalog brings no Team skill', () => {
  const PG = { id: 'manual:pg', source: 'manual', name: 'pg', base: 'pg', provisional: false, pluginEnabled: true, code: null, dir: null,
    def: { type: 'stdio', command: '/usr/bin/pg', args: [], fields: [], description: 'pg' } };
  const base = { catalog: [PG], bases: nul({}), secrets: nul({}), tests: nul({}),
    teams: nul({}), projects: nul({ 'billing-1a2b3c4d': { sets: ['billing'], includeGeneral: true } }) };
  const opts = (sets, teams) => ({ surface: 'pipeline', targets: [P('billing-1a2b3c4d')], teams, platform: 'linux', execPath: '/usr/bin/node', worcaRoot: '/w',
    store: { ...base, sets } });
  const without = nul({ billing: { name: 'Billing', slug: 'billing', members: [{ server: 'manual:pg', enabled: true, values: {} }] } });
  const withSkills = nul({ billing: { ...without.billing, skills: [{ skill: DEPLOY, enabled: true }] }, general: { name: 'General', members: [], skills: [{ skill: NOTES, enabled: true }] } });
  const a = registry.resolveMcpServers(opts(without, {}));
  const b = registry.resolveMcpServers(opts(withSkills, {}));
  assert.deepEqual(b.copies, a.copies);
  assert.deepEqual(b.servers, a.servers);
  const c = registry.resolveMcpServers(opts(without, { 'billing-1a2b3c4d': { home: 'acme/platform', required: [], requiredSkills: REQ } }));
  assert.deepEqual(c.copies, a.copies);
  assert.deepEqual(c.sets.find((x) => x.group === 'team'), { id: TEAM, name: 'Team · acme/platform', group: 'team',
    routes: [{ project: 'billing-1a2b3c4d', route: null }], members: 0, started: 0 }, 'a skills-only Team set is listed, with no server');
});

test('pluginNameFor (§4.1): the slug, General → general; a name an installed Claude Code plugin holds → -set, -set-2, -set-3', () => {
  assert.deepEqual(pluginNameFor({ id: 'billing', slug: 'billing' }, []), { pluginName: 'billing', renamed: false });
  assert.deepEqual(pluginNameFor({ id: 'general', slug: null }), { pluginName: 'general', renamed: false });
  assert.deepEqual(pluginNameFor({ id: TEAM, slug: 'team-platfor' }, ['billing']), { pluginName: 'team-platfor', renamed: false });
  assert.deepEqual(pluginNameFor({ id: 'billing', slug: 'billing' }, ['billing']), { pluginName: 'billing-set', renamed: true });
  assert.deepEqual(pluginNameFor({ id: 'billing', slug: 'billing' }, ['billing-set', 'billing', 'billing-set-2']), { pluginName: 'billing-set-3', renamed: true });
  assert.deepEqual(pluginNameFor({ id: 'general' }, ['general']), { pluginName: 'general-set', renamed: true });
});

test('requiredSkillsOf / cachedTeams / cachedTeamFor: skills.required entries; a home requiring only skills counts; MCP-only output unchanged', async () => {
  const ENTRY = { plugin: 'acme-tools', server: 'sentry' };
  const SK = { plugin: 'acme-tools', skill: 'deploy-checklist' };
  const doc = (mcp, skills) => ({ fields: { ...(mcp ? { 'mcp.required': { kind: 'soft', value: mcp } } : {}), ...(skills ? { 'skills.required': { kind: 'soft', value: skills } } : {}) } });
  assert.deepEqual(registry.requiredSkillsOf(doc(null, [SK])), [SK]);
  for (const d of [null, undefined, doc(), doc(null, 'x'), { fields: { 'skills.required': null } }]) assert.deepEqual(registry.requiredSkillsOf(d), []);
  const homes = [{ slug: 'acme/a', doc: doc([ENTRY]) }, { slug: 'acme/b', doc: doc(null, [SK]) }, { slug: 'acme/c', doc: doc([ENTRY], [SK]) }, { slug: 'acme/d', doc: doc([], []) }];
  assert.deepEqual(registry.cachedTeams(homes), [
    { home: 'acme/a', required: [ENTRY], doc: homes[0].doc },
    { home: 'acme/b', required: [], requiredSkills: [SK], doc: homes[1].doc },
    { home: 'acme/c', required: [ENTRY], requiredSkills: [SK], doc: homes[2].doc }]);
  const policies = { 'p-00000001': { home: 'acme/a', doc: doc([ENTRY]) }, 'p-00000002': { home: 'acme/b', doc: doc(null, [SK]) }, 'p-00000003': { home: 'acme/d', doc: doc([], []) } };
  const deps = { policyForKey: (k) => policies[k] ?? null };
  assert.deepEqual(await registry.cachedTeamFor({ projectKey: 'p-00000001' }, deps), { home: 'acme/a', required: [ENTRY] });
  assert.deepEqual(await registry.cachedTeamFor({ projectKey: 'p-00000002' }, deps), { home: 'acme/b', required: [], requiredSkills: [SK] });
  assert.equal(await registry.cachedTeamFor({ projectKey: 'p-00000003' }, deps), null);
});
