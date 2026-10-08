// test/ask-skills-preview.test.mjs — skills registry §4.4/§7: POST /api/ask/mcp-preview's body gains `skills`
// (mounted, plugins, skipped with the qualified name, message and why, started, layer) and every set row its skill counts;
// the turn-end worktree notice names the skills a new worktree brings. Resolvers faked (P3 tests their rules), but one
// row runs P3's real resolver over a fixed snapshot: the names it gives skipped rows reach the picker unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askMcpPreview, askMcpJoinNotice } from '../src/core/ask/mcp.mjs';
import { resolveSkillRegistry } from '../src/core/skills-registry/resolve.mjs';
import { skillSkipReasonText, skillSkipMessage, skillLayerText } from '../src/core/skills-registry/texts.mjs';

const PROJECTS = [{ key: 'billing-00000001', name: 'billing', path: '/p/billing' }, { key: 'shop-00000002', name: 'shop', path: '/p/shop' }];
const readers = (worktrees = []) => ({
  listProjects: async () => PROJECTS,
  readWorkspace: async () => null,
  listWorktrees: (threadId) => (threadId === 'ask_00000001' ? worktrees : []),
});
const MCP = () => ({
  servers: {}, env: {}, secretValues: [], grants: [], disallowedTools: [], skippedTools: [], skipped: [],
  copies: [{ name: 'jira', copy: 'jira', setId: 'general', setName: 'General', serverId: 'plugin:acme-tools/jira', projects: [], description: 'Jira', renamedFrom: null, provisional: false }],
  sets: [
    { id: 'general', name: 'General', group: 'general', routes: [], members: 1, started: 1 },
    { id: 'team-zeta-x-1111', name: 'Team · zeta/x', group: 'team', routes: [], members: 1, started: 0 },
  ],
});
const m = (setId, setName, pluginName, name, projects = []) => ({
  id: `skill:library:${name}`, name, qualifiedName: `${pluginName}:${name}`, pluginName, setId, setName, setSlug: setId === 'general' ? null : setId,
  dir: `/lib/${name}`, projects, description: `${name} help`, plugin: null,
});
// A skipped row as P3 writes it: its set's plugin name and the name the skill would load as.
const sk = (setId, setName, pluginName, name, reason, skillId = `skill:library:${name}`) => ({ setId, setName, pluginName, qualifiedName: `${pluginName}:${name}`, skillId, name, reason });
const SKILLS = () => ({
  mounted: [m('billing', 'Billing', 'billing', 'deploy-checklist', ['billing-00000001']), m('general', 'General', 'general', 'graphify')],
  plugins: [{ setId: 'billing', setName: 'Billing', pluginName: 'billing', renamedPlugin: false, skills: ['deploy-checklist'] },
    { setId: 'general', setName: 'General', pluginName: 'general', renamedPlugin: false, skills: ['graphify'] }],
  skipped: [
    sk('billing', 'Billing', 'billing', 'db-migrations', 'off'),
    sk('billing', 'Billing', 'billing', 'old', 'missing-skill'),
    sk('shop', 'Shop', 'shop-set', 'notes', 'chat-off'),
    sk('team-acme-platform-9333', 'Team · acme/platform', 'team-platfor', 'deploy-checklist', 'needs-consent', 'skill:plugin:acme/deploy-checklist'),
  ],
  sets: [
    { id: 'general', name: 'General', group: 'general', routes: [], skills: 1, started: 1 },
    { id: 'billing', name: 'Billing', group: 'set', routes: [{ project: 'billing-00000001', route: 'pinned' }], skills: 3, started: 1 },
    { id: 'shop', name: 'Shop', group: 'set', routes: [{ project: 'shop-00000002', route: 'worktree' }], skills: 1, started: 0 },
    { id: 'team-acme-platform-9333', name: 'Team · acme/platform', group: 'team', routes: [], skills: 1, started: 0 },
  ],
});
const deps = (over = {}) => ({
  ...readers(), cachedTeamFor: () => null, cachedSkillTeamFor: async () => null,
  resolveRegistry: async () => MCP(), resolveSkillRegistry: async () => SKILLS(),
  // MCP() skips nothing, so nothing may read the store: the skills block takes its names from the resolve.
  readMcpStore: async () => { throw new Error('the preview read the store again'); }, loadCatalog: async () => [],
  ...over,
});

test('askMcpPreview: a skills block beside the MCP fields — mounted (no host paths), plugins, skipped with the qualified name, message, why and problem, started, layer', async () => {
  const p = await askMcpPreview({ ctx: { pinned: true, projectKey: 'billing-00000001' }, threadId: null, off: null, model: 'claude-opus-5-5' }, deps());
  assert.deepEqual(Object.keys(p).sort(), ['copies', 'newer', 'sets', 'skills', 'skipped', 'skippedTools', 'started']);
  assert.equal(p.started, 1, 'MCP copies only — the pill adds skills.started');
  const { dir, ...rest } = SKILLS().mounted[0];
  assert.equal(typeof dir, 'string');
  assert.deepEqual(p.skills.mounted[0], rest, 'the library or plugin path never reaches the browser');
  assert.deepEqual(p.skills.plugins, SKILLS().plugins);
  assert.equal(p.skills.started, 2);
  assert.deepEqual(p.skills.layer, { blocked: null, text: null });
  assert.equal(p.skills.newer, false);
  assert.deepEqual(p.skills.skipped.map((x) => [x.qualifiedName, x.reason, x.why, x.problem]), [
    ['billing:db-migrations', 'off', skillSkipReasonText({ reason: 'off' }), false],          // P3's qualifiedName, unchanged
    ['billing:old', 'missing-skill', skillSkipReasonText({ reason: 'missing-skill' }), true],
    ['shop-set:notes', 'chat-off', skillSkipReasonText({ reason: 'chat-off' }), false],
    ['team-platfor:deploy-checklist', 'needs-consent', skillSkipReasonText({ reason: 'needs-consent' }), false],
  ]);
  assert.deepEqual(p.skills.skipped.map((x) => x.message), SKILLS().skipped.map((x) => skillSkipMessage(x)), 'the line P4\'s /api/mcp/preview gives a skipped skill');
});

test('askMcpPreview over the real P3 resolver: a skipped skill shows the plugin its set loads under — an installed clash, a taken -set name, a Team set with no record yet', async () => {
  const lib = (name, over = {}) => ({ id: `skill:library:${name}`, source: 'library', plugin: null, name, dir: `/lib/${name}`, description: '', valid: true, pluginEnabled: true, problems: [], ...over });
  const snap = { newer: false, projects: { 'billing-00000001': { sets: ['shop', 'shop-set'], includeGeneral: true } }, teams: {},
    sets: { general: { name: 'General', members: [], skills: [] },
      shop: { name: 'Shop', slug: 'shop', members: [], skills: [{ skill: 'skill:library:notes', enabled: false }] },
      'shop-set': { name: 'Shop set', slug: 'shop-set', members: [], skills: [{ skill: 'skill:library:stock', enabled: false }] } } };
  const catalog = [lib('notes'), lib('stock'), lib('deploy-checklist', { id: 'skill:plugin:acme/deploy-checklist', source: 'plugin', plugin: 'acme' })];
  const real = (opts) => resolveSkillRegistry(opts, { readStore: async () => snap, loadSkills: () => catalog,
    hostFacts: () => ({ installedPluginNames: ['shop'], sideloadDisabled: false }) });
  const team = { home: 'acme/platform', required: [], requiredSkills: [{ plugin: 'acme', skill: 'deploy-checklist' }] };
  const p = await askMcpPreview({ ctx: { pinned: true, projectKey: 'billing-00000001' }, off: null }, deps({ resolveSkillRegistry: real,
    cachedSkillTeamFor: async (t) => (t.projectKey === 'billing-00000001' ? team : null) }));
  assert.deepEqual(p.skills.skipped.map((x) => [x.setId, x.qualifiedName, x.reason]), [
    ['shop', 'shop-set-2:notes', 'off'],                                          // `shop` is installed and `shop-set` is a set's slug
    ['shop-set', 'shop-set:stock', 'off'],
    ['team-acme-platform-9333', 'team-platfor:deploy-checklist', 'needs-consent'],   // provisional: no store.teams record
  ]);
  assert.ok(!JSON.stringify(p).includes('/lib/'), 'no host path anywhere in the preview');
});

test('askMcpPreview: set rows carry skill counts; a set only the skills resolver brings joins its group (Team sets by name), all started counts 0 when the layer is blocked', async () => {
  const p = await askMcpPreview({ ctx: {}, off: null }, deps());
  assert.deepEqual(p.sets.map((s) => [s.id, s.members, s.started, s.skills, s.startedSkills]), [
    ['general', 1, 1, 1, 1],
    ['billing', 0, 0, 3, 1],
    ['shop', 0, 0, 1, 0],
    ['team-acme-platform-9333', 0, 0, 1, 0],
    ['team-zeta-x-1111', 1, 0, 0, 0],
  ]);
  assert.deepEqual(p.sets[1].routes, [{ project: 'billing-00000001', route: 'pinned' }], 'a skills-only set keeps its routes (the picker label)');
  const blocked = await askMcpPreview({ ctx: {}, off: null }, deps({ resolveSkillRegistry: async () => ({ ...SKILLS(), blocked: 'sideload-disabled' }) }));
  assert.equal(blocked.skills.started, 0);
  assert.deepEqual(blocked.skills.layer, { blocked: 'sideload-disabled', text: skillLayerText('sideload-disabled') });
  assert.deepEqual(blocked.sets.map((s) => s.startedSkills), [0, 0, 0, 0, 0]);
  assert.equal(blocked.skills.mounted.length, 2, 'the rows stay listed');
});

test('askMcpPreview: a newer skills store says so', async () => {
  const newer = await askMcpPreview({ ctx: {}, off: null }, deps({ resolveSkillRegistry: async () => ({ mounted: [], plugins: [], skipped: [], sets: [], newer: true }) }));
  assert.equal(newer.skills.newer, true);
  assert.equal(newer.skills.started, 0);
});

test('askMcpJoinNotice (D17): names the copies and the skills a new worktree brings; skills alone read on their own', async () => {
  const before = { targets: [{ kind: 'project', key: 'billing-00000001', name: 'billing', route: 'pinned', rank: 0 }],
    result: { ...MCP(), copies: [] }, skills: { ...SKILLS(), mounted: [SKILLS().mounted[0]], blocked: null } };
  const shopSkill = m('shop', 'Shop', 'shop', 'notes', ['shop-00000002']);
  const args = { before, ctx: { pinned: true, projectKey: 'billing-00000001' }, threadId: 'ask_00000001', off: null, model: 'claude-opus-5-5' };
  const nextMcp = { ...MCP(), copies: [{ name: 'sentry_shop', projects: ['shop-00000002'] }] };
  const nextSkills = { ...SKILLS(), mounted: [...SKILLS().mounted, shopSkill] };
  const d = (over) => deps({ ...readers([{ projectKey: 'shop-00000002' }]), resolveRegistry: async () => nextMcp, resolveSkillRegistry: async () => nextSkills, ...over });
  assert.equal(await askMcpJoinNotice(args, d()), "shop's MCP servers (sentry_shop) and skills (shop:notes) join from the next message");
  assert.equal(await askMcpJoinNotice(args, d({ resolveRegistry: async () => ({ ...MCP(), copies: [] }) })), "shop's skills (shop:notes) join from the next message");
  assert.equal(await askMcpJoinNotice(args, d({ resolveSkillRegistry: async () => SKILLS() })), "shop's MCP servers (sentry_shop) join from the next message",
    'general:graphify was not mounted at the start either, but it is no worktree project\'s skill');
  assert.equal(await askMcpJoinNotice(args, d({ resolveRegistry: async () => ({ ...MCP(), copies: [] }), resolveSkillRegistry: async () => ({ ...nextSkills, blocked: 'sideload-disabled' }) })), null,
    'a blocked layer brings no skill');
  assert.equal(await askMcpJoinNotice({ ...args, before: { targets: before.targets, result: before.result } }, d({ resolveRegistry: async () => ({ ...MCP(), copies: [] }) })), null,
    'a caller that passes no skills (the MCP-only shape) gets the MCP-only notice');
  assert.equal(await askMcpJoinNotice({ ...args, off: { sets: ['shop'], members: [] } }, d({ resolveRegistry: async () => ({ ...MCP(), copies: [] }),
    resolveSkillRegistry: async (o) => (o.off.sets.includes('shop') ? SKILLS() : nextSkills) })), null,
    'the chat\'s choices reach the skills resolve: a set switched off in this chat brings no skill');
});
