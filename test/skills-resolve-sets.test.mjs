// test/skills-resolve-sets.test.mjs
// Skills registry §4.1–§4.2: the pure resolver — which skills a spawn mounts, under which generated plugin (one per
// set, `/<plugin>:<skill>`), the skip reasons in order, keep order and the cap, installed-plugin renames, Team skills,
// and byte-identical output for shuffled input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as resolveMod from '../src/core/skills-registry/resolve.mjs';
import * as setsMod from '../src/core/mcp/sets.mjs';
import * as registryMod from '../src/core/mcp/registry.mjs';
import { SKILL_CAP, pluginNamesFor, resolveSkillSets } from '../src/core/skills-registry/resolve.mjs';
import { checkRows } from './helpers/rows.mjs';
import { canonicalJson, sha256Hex } from '../src/core/mcp/definitions.mjs';

const cat = (id, o = {}) => {
  const plugin = id.startsWith('skill:plugin:') ? id.slice(13, id.indexOf('/')) : null;
  const name = o.name ?? id.slice(id.lastIndexOf(plugin ? '/' : ':') + 1);
  return { id, source: plugin ? 'plugin' : 'library', plugin, name, dir: o.dir === undefined ? `/lib/${plugin ?? 'library'}/${name}` : o.dir,
    description: o.description ?? `${name} skill`, whenToUse: null,
    frontmatter: { allowedTools: null, hooks: false, shell: false, disableModelInvocation: false, pluginRootRefs: false },
    files: 1, bytes: 10, scripts: [], shellBlocks: 0, hash: 'h', code: plugin ? 'abc1234' : null,
    pluginEnabled: o.pluginEnabled ?? true, valid: o.valid ?? true, problems: [] };
};
const sk = (skill, enabled = true) => ({ skill, enabled });
const P = (key, o = {}) => ({ kind: 'project', key, name: key, rank: 0, ...o });
const DEPLOY = 'skill:plugin:acme/deploy-checklist';
const CONSENT = sha256Hex(canonicalJson({ plugin: 'acme', skill: 'deploy-checklist' }));   // P5 skillConsentHash
const GRAPH = 'skill:plugin:graphify/graphify';
const NOTES = 'skill:library:release-notes';
const AUDIT = 'skill:library:audit';
const CATALOG = [cat(DEPLOY), cat(GRAPH), cat(NOTES), cat(AUDIT)];
const BILLING = 'billing-1a2b3c4d';
const SHOP = 'shop-5e6f7a8b';
const TEAM_HOME = 'acme/platform';
const STORE = {
  catalog: CATALOG,
  sets: {
    general: { name: 'General', members: [], skills: [sk(GRAPH)] },
    billing: { name: 'Billing', slug: 'billing', members: [], skills: [sk(DEPLOY), sk(NOTES, false)] },
    shop: { name: 'Shop', slug: 'shop', members: [], skills: [sk(DEPLOY), sk(AUDIT)] },
  },
  teams: { [TEAM_HOME]: { id: 'team-acme-platform-9333', slug: 'team-platfor', name: 'Team · acme/platform', members: {},
    skills: { [DEPLOY]: { enabled: true, consent: CONSENT } } } },
  projects: { [BILLING]: { sets: ['billing'], includeGeneral: false }, [SHOP]: { sets: ['shop'], includeGeneral: true } },
};
// A required skill that is not in the catalog is P2's collectSets call (member or checklist row): not exercised here.
const TEAM = { home: TEAM_HOME, required: [], requiredSkills: [{ plugin: 'acme', skill: 'deploy-checklist' }] };
const resolve = (o = {}) => resolveSkillSets({ surface: 'pipeline', targets: [], teams: {}, ...o, store: { ...STORE, ...o.store } });
const qn = (r) => r.mounted.map((m) => m.qualifiedName);
const why = (r) => r.skipped.map((s) => `${s.setId}|${s.skillId}:${s.reason}`);

test('P2 owns pluginNameFor, teamSkillMembers and requiredSkillsOf; resolve.mjs re-exports the same functions', () => {
  assert.equal(resolveMod.pluginNameFor, setsMod.pluginNameFor);
  assert.equal(resolveMod.teamSkillMembers, setsMod.teamSkillMembers);
  assert.equal(resolveMod.requiredSkillsOf, registryMod.requiredSkillsOf);
});

test('pluginNamesFor: unique names per spawn (same-name plugins MERGE), stable whatever other sets a spawn brings', async () => {
  const set = (id, slug) => ({ id, slug });
  const store = { sets: { general: { name: 'General' }, billing: { slug: 'billing' }, 'billing-set': { slug: 'billing-set' }, shop: { slug: 'shop' } },
    teams: { 'acme/platform': { id: 'team-acme-platform-9333', slug: 'team-platfor' } } };
  const all = [set('general', null), set('billing', 'billing'), set('billing-set', 'billing-set'), set('shop', 'shop')];
  const names = (sets, taken) => Object.fromEntries([...pluginNamesFor(sets, store, taken)].map(([id, r]) => [id, `${r.pluginName}${r.renamed ? '*' : ''}`]));
  await checkRows([
    { name: 'nothing installed: every set keeps its slug, General is general', run: () => {
      assert.deepEqual(names(all, []), { general: 'general', billing: 'billing', 'billing-set': 'billing-set', shop: 'shop' });
    } },
    { name: 'billing installed: billing → billing-set-2 (billing-set is another set\'s slug), never merged with it', run: () => {
      assert.deepEqual(names(all, ['billing']), { general: 'general', billing: 'billing-set-2*', 'billing-set': 'billing-set', shop: 'shop' });
    } },
    { name: 'the same name when billing-set is not in this spawn', run: () => {
      assert.deepEqual(names([set('billing', 'billing')], ['billing']), { billing: 'billing-set-2*' });
    } },
    { name: 'a renamed set skips a Team slug and installed -set names too', run: () => {
      assert.deepEqual(names([set('general', null)], ['general', 'general-set']), { general: 'general-set-2*' });
      const teamStore = { sets: {}, teams: { h: { slug: 'shop-set' } } };
      assert.deepEqual(Object.fromEntries([...pluginNamesFor([set('shop', 'shop')], teamStore, ['shop'])].map(([id, r]) => [id, r.pluginName])), { shop: 'shop-set-2' });
    } },
    { name: 'two sets with one slug (hand edit): the second in id order is renamed', run: () => {
      assert.deepEqual(names([set('b-two', 'dup'), set('a-one', 'dup')], []), { 'a-one': 'dup', 'b-two': 'dup-set*' });
    } },
    { name: 'input order does not matter; junk installed names are ignored', run: () => {
      assert.deepEqual(names([...all].reverse(), [7, 'billing', null]), names(all, ['billing']));
      assert.deepEqual(names(all, 'billing'), names(all, []));
    } },
    { name: 'a hand-edited duplicate slug names the same with or without its twin in the call', run: () => {
      const dupStore = { sets: { 'a-one': { slug: 'dup' }, 'b-two': { slug: 'dup' } }, teams: {} };
      const got = (sets) => Object.fromEntries([...pluginNamesFor(sets, dupStore, [])].map(([id, r]) => [id, r.pluginName]));
      assert.deepEqual(got([set('b-two', 'dup')]), { 'b-two': 'dup-set' });
      assert.deepEqual(got([set('a-one', 'dup'), set('b-two', 'dup')]), { 'a-one': 'dup', 'b-two': 'dup-set' });
    } },
    { name: 'a provisional Team set (no record yet) never moves a persisted set', run: () => {
      const teamStore = { sets: {}, teams: { 'acme/pl': { id: 'team-acme-pl-518a', slug: 'team-pl' } } };
      const acme = set('team-acme-pl-518a', 'team-pl');
      const beta = set('team-beta-pl-set-62b6', 'team-pl-set');
      const got = (sets) => Object.fromEntries([...pluginNamesFor(sets, teamStore, ['team-pl'])].map(([id, r]) => [id, r.pluginName]));
      assert.deepEqual(got([acme]), { 'team-acme-pl-518a': 'team-pl-set' });
      assert.deepEqual(got([acme, beta]), { 'team-acme-pl-518a': 'team-pl-set', 'team-beta-pl-set-62b6': 'team-pl-set-set' });
    } },
    { name: 'two sets that both rename still get two names; no store reads as an empty store', run: () => {
      const got = pluginNamesFor([set('b-two', 'dup'), set('a-one', 'dup')], undefined, ['dup']);
      assert.deepEqual([...got].map(([id, r]) => `${id}=${r.pluginName}`).sort(), ['a-one=dup-set', 'b-two=dup-set-2']);
    } },
  ]);
});

test('resolveSkillSets: pipeline run on billing + shop with a Team policy — mounts, plugins, skips, sets', () => {
  const r = resolve({ targets: [P(BILLING, { route: 'pinned', rank: 0 }), P(SHOP, { route: 'worktree', rank: 1 })],
    teams: { [BILLING]: TEAM, [SHOP]: TEAM } });
  assert.deepEqual(qn(r), ['billing:deploy-checklist', 'general:graphify', 'shop:audit', 'shop:deploy-checklist', 'team-platfor:deploy-checklist']);
  assert.deepEqual(r.mounted.find((m) => m.qualifiedName === 'shop:audit'), {
    id: AUDIT, name: 'audit', qualifiedName: 'shop:audit', pluginName: 'shop', setId: 'shop', setName: 'Shop', setSlug: 'shop',
    dir: '/lib/library/audit', projects: [SHOP], description: 'audit skill', plugin: null });
  assert.deepEqual(r.mounted.find((m) => m.pluginName === 'team-platfor').projects, [BILLING, SHOP]);
  assert.deepEqual(r.plugins, [
    { setId: 'billing', setName: 'Billing', pluginName: 'billing', renamedPlugin: false, skills: ['deploy-checklist'] },
    { setId: 'general', setName: 'General', pluginName: 'general', renamedPlugin: false, skills: ['graphify'] },
    { setId: 'shop', setName: 'Shop', pluginName: 'shop', renamedPlugin: false, skills: ['audit', 'deploy-checklist'] },
    { setId: 'team-acme-platform-9333', setName: 'Team · acme/platform', pluginName: 'team-platfor', renamedPlugin: false, skills: ['deploy-checklist'] },
  ]);
  assert.deepEqual(why(r), [`billing|${NOTES}:off`]);
  assert.deepEqual(r.skipped.find((s) => s.reason === 'off'),
    { setId: 'billing', setName: 'Billing', pluginName: 'billing', qualifiedName: 'billing:release-notes', skillId: NOTES, name: 'release-notes', reason: 'off' });
  assert.deepEqual(r.sets.map((s) => [s.id, s.group, s.skills, s.started, s.pluginName]), [
    ['general', 'general', 1, 1, 'general'], ['billing', 'set', 2, 1, 'billing'], ['shop', 'set', 2, 2, 'shop'],
    ['team-acme-platform-9333', 'team', 1, 1, 'team-platfor']]);
  assert.deepEqual(r.sets.find((s) => s.id === 'team-acme-platform-9333').routes,
    [{ project: BILLING, route: 'pinned' }, { project: SHOP, route: 'worktree' }]);
});

test('resolveSkillSets: skip reasons, first match wins, and each surface reads only its own opt-out', async () => {
  const one = (skills, o = {}) => resolve({ ...o, targets: [P(BILLING)], store: { ...o.store,
    sets: { general: { name: 'General', members: [] }, billing: { name: 'Billing', slug: 'billing', members: [], skills } } } });
  const rows = [
    ['missing-skill', [sk('skill:library:ghost')], {}],
    ['plugin-disabled (before off)', [sk(DEPLOY, false)], { store: { catalog: [cat(DEPLOY, { pluginEnabled: false })] } }],
    ['invalid-skill (catalog says invalid)', [sk(NOTES)], { store: { catalog: [cat(NOTES, { valid: false })] } }],
    ['invalid-skill (a name that is no path segment)', [sk(NOTES)], { store: { catalog: [cat(NOTES, { name: '../x' })] } }],
    ['invalid-skill (reserved name)', [sk(NOTES)], { store: { catalog: [cat(NOTES, { name: 'synced' })] } }],
    ['invalid-skill (no folder)', [sk(NOTES)], { store: { catalog: [cat(NOTES, { dir: null })] } }],
    ['off', [sk(NOTES, false)], {}],
    ['opted-out', [sk(NOTES)], { optOut: [`billing|${NOTES}`] }],
  ];
  await checkRows([
    ...rows.map(([label, skills, o]) => ({ name: label, run: () => {
      const r = one(skills, o);
      assert.deepEqual(r.mounted, []);
      assert.deepEqual(r.skipped.map((s) => s.reason), [label.split(' ')[0]]);
    } })),
    { name: 'pipeline ignores the Ask chat-off; Ask ignores the run opt-out', run: () => {
      assert.deepEqual(qn(one([sk(NOTES)], { off: { sets: ['billing'], members: [] } })), ['billing:release-notes']);
      assert.deepEqual(qn(one([sk(NOTES)], { surface: 'ask', optOut: [`billing|${NOTES}`] })), ['billing:release-notes']);
    } },
    { name: 'chat-off by set and by member key (Ask)', run: () => {
      assert.deepEqual(one([sk(NOTES)], { surface: 'ask', off: { sets: ['billing'], members: [] } }).skipped.map((s) => s.reason), ['chat-off']);
      assert.deepEqual(one([sk(NOTES)], { surface: 'ask', off: { sets: [], members: [`billing|${NOTES}`] } }).skipped.map((s) => s.reason), ['chat-off']);
    } },
    { name: 'needs-consent: a Team skill never consented; off once consented but switched off', run: () => {
      const team = (state) => resolve({ targets: [P(BILLING)], teams: { [BILLING]: TEAM },
        store: { teams: { [TEAM_HOME]: { ...STORE.teams[TEAM_HOME], skills: state } } } });
      assert.ok(why(team({})).includes(`team-acme-platform-9333|${DEPLOY}:needs-consent`));
      assert.equal(team({}).skipped.find((s) => s.reason === 'needs-consent').qualifiedName, 'team-platfor:deploy-checklist');
      assert.ok(why(team({ [DEPLOY]: { enabled: false, consent: CONSENT } })).includes(`team-acme-platform-9333|${DEPLOY}:off`));
    } },
    { name: 'name-taken: two skills with one name in a set (hand edit) — the first by id mounts', run: () => {
      const r = one([sk('skill:plugin:graphify/audit'), sk(AUDIT)], { store: { catalog: [cat('skill:plugin:graphify/audit'), cat(AUDIT)] } });
      assert.deepEqual(qn(r), ['billing:audit']);
      assert.equal(r.mounted[0].id, AUDIT);
      assert.deepEqual(why(r), ['billing|skill:plugin:graphify/audit:name-taken']);
    } },
    { name: 'a repeated skill id in a set reads once', run: () => {
      const r = one([sk(NOTES), sk(NOTES, false)]);
      assert.deepEqual(qn(r), ['billing:release-notes']);
      assert.deepEqual(r.skipped, []);
    } },
  ]);
});

test('resolveSkillSets: keep order (project sets by rank, Team, General), the cap drops from the end and counts each mount', async () => {
  const targets = [P(BILLING, { rank: 0 }), P(SHOP, { rank: 1 })];
  const teams = { [BILLING]: TEAM, [SHOP]: TEAM };
  const kept = (cap) => qn(resolve({ targets, teams, skillCap: cap }));
  const capped = (cap) => resolve({ targets, teams, skillCap: cap }).skipped.filter((s) => s.reason === 'cap').map((s) => `${s.setId}|${s.name}`);
  await checkRows([
    { name: 'cap 1 keeps the best-ranked project set', run: () => assert.deepEqual(kept(1), ['billing:deploy-checklist']) },
    { name: 'rank beats set name: shop ranked first keeps shop', run: () => {
      assert.deepEqual(qn(resolve({ targets: [P(SHOP, { rank: 0 }), P(BILLING, { rank: 1 })], teams, skillCap: 1 })), ['shop:audit']);
    } },
    { name: 'cap 3: billing, then shop by skill name', run: () => assert.deepEqual(kept(3), ['billing:deploy-checklist', 'shop:audit', 'shop:deploy-checklist']) },
    { name: 'cap 4 adds Team before General', run: () => assert.deepEqual(capped(4), ['general|graphify']) },
    { name: 'the same skill in three sets is three mounts', run: () => assert.equal(kept(24).filter((q) => q.endsWith(':deploy-checklist')).length, 3) },
    { name: 'SKILL_CAP defaults: pipeline 24, Ask 12', run: () => {
      assert.deepEqual(SKILL_CAP, { pipeline: 24, ask: 12 });
      const many = Array.from({ length: 30 }, (_, i) => `skill:library:s${String(i).padStart(2, '0')}`);
      const store = { catalog: many.map((id) => cat(id)), sets: { general: { name: 'General', members: [], skills: many.map((id) => sk(id)) } }, projects: {} };
      assert.equal(resolveSkillSets({ surface: 'ask', targets: [], store }).mounted.length, 12);
      assert.equal(resolveSkillSets({ surface: 'pipeline', targets: [P('p')], store: { ...store, projects: { p: { sets: [] } } } }).mounted.length, 24);
      assert.equal(resolveSkillSets({ surface: 'ask', targets: [], store, skillCap: 'x' }).mounted.length, 12);
    } },
  ]);
});

test('resolveSkillSets: installed plugin names rename the set\'s plugin — stable, unique per spawn, never another set\'s name', async () => {
  const sets = { general: { name: 'General', members: [], skills: [sk(GRAPH)] },
    billing: { name: 'Billing', slug: 'billing', members: [], skills: [sk(DEPLOY), sk(AUDIT, false)] },
    'billing-set': { name: 'Billing set', slug: 'billing-set', members: [], skills: [sk(NOTES)] } };
  const projects = { [BILLING]: { sets: ['billing', 'billing-set'] } };
  const r = resolve({ targets: [P(BILLING)], takenPluginNames: ['billing', 'superpowers'], store: { sets, projects } });
  await checkRows([
    { name: 'billing loads as billing-set-2 (billing-set is another set\'s name)', run: () => {
      assert.deepEqual(qn(r), ['billing-set-2:deploy-checklist', 'billing-set:release-notes', 'general:graphify']);
      assert.deepEqual(r.plugins.map((p) => [p.setId, p.pluginName, p.renamedPlugin]),
        [['billing-set', 'billing-set', false], ['billing', 'billing-set-2', true], ['general', 'general', false]]);
      assert.equal(r.sets.find((s) => s.id === 'billing').renamedPlugin, true);
      assert.deepEqual(r.skipped.map((s) => [s.name, s.reason, s.pluginName, s.qualifiedName]), [['audit', 'off', 'billing-set-2', 'billing-set-2:audit']],
        'skipped rows name the plugin and the qualified name too');
    } },
    { name: 'the same name when billing-set is not in this spawn', run: () => {
      const alone = resolve({ targets: [P(BILLING)], takenPluginNames: ['billing'], store: { sets, projects: { [BILLING]: { sets: ['billing'] } } } });
      assert.deepEqual(alone.plugins.find((p) => p.setId === 'billing').pluginName, 'billing-set-2');
    } },
    { name: 'two sets with one slug (hand edit): the second by id is renamed, never merged', run: () => {
      const dup = resolve({ targets: [P(BILLING)], store: { projects,
        sets: { ...sets, 'billing-set': { ...sets['billing-set'], slug: 'billing' } } } });
      assert.deepEqual(dup.plugins.map((p) => [p.setId, p.pluginName]), [['billing', 'billing'], ['billing-set', 'billing-set'], ['general', 'general']]);
    } },
  ]);
});

test('resolveSkillSets: the Team short form { home, required:[{plugin, skill}] } equals { home, required, requiredSkills }; a workspace target brings its members\' sets', () => {
  const short = { home: TEAM_HOME, required: TEAM.requiredSkills };
  const a = resolve({ targets: [P(BILLING)], teams: { [BILLING]: TEAM } });
  const b = resolve({ targets: [P(BILLING)], teams: { [BILLING]: short } });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.ok(qn(a).includes('team-platfor:deploy-checklist'));
  const ws = resolve({ targets: [{ kind: 'workspace', id: 'ws1', rank: 0, members: [{ key: BILLING }, { key: SHOP }] }] });
  assert.deepEqual(qn(ws), ['billing:deploy-checklist', 'general:graphify', 'shop:audit', 'shop:deploy-checklist']);
  assert.deepEqual(ws.mounted.find((m) => m.pluginName === 'general').projects, [SHOP]);
});

test('resolveSkillSets: byte-identical output for shuffled targets, catalog, set skills, opt-outs and installed names', () => {
  const rev = (a) => [...a].reverse();
  const base = { targets: [P(BILLING, { rank: 0 }), P(SHOP, { rank: 1 })], teams: { [BILLING]: TEAM, [SHOP]: TEAM },
    optOut: [`shop|${AUDIT}`, `billing|${NOTES}`], takenPluginNames: ['shop', 'superpowers'], skillCap: 3 };
  const shuffledStore = { catalog: rev(CATALOG), sets: Object.fromEntries(rev(Object.entries(STORE.sets))
    .map(([id, s]) => [id, { ...s, skills: rev(s.skills ?? []) }])) };
  const a = resolve(base);
  const b = resolve({ ...base, targets: rev(base.targets), optOut: rev(base.optOut), takenPluginNames: rev(base.takenPluginNames), store: shuffledStore });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.ok(qn(a).includes('shop-set:deploy-checklist'));
});

test('resolveSkillSets: order inside a set, workspace member order, a pipeline ignores off.members, reason order, name length', async () => {
  const ALPHA = 'skill:plugin:zeta/alpha';
  const BETA = 'skill:library:beta';
  const LONG = `skill:library:${'a'.repeat(65)}`;
  const one = (skills, o = {}) => resolve({ ...o, targets: [P(BILLING)], store: { ...o.store,
    sets: { general: { name: 'General', members: [] }, billing: { name: 'Billing', slug: 'billing', members: [], skills } } } });
  await checkRows([
    { name: 'inside a set by skill name, not id: cap 1 keeps alpha (plugin zeta) over beta', run: () => {
      const r = one([sk(BETA), sk(ALPHA)], { skillCap: 1, store: { catalog: [cat(ALPHA), cat(BETA)] } });
      assert.deepEqual(qn(r), ['billing:alpha']);
      assert.equal(r.mounted[0].plugin, 'zeta');
      assert.deepEqual(why(r), [`billing|${BETA}:cap`]);
    } },
    { name: 'a pipeline ignores off.members too', run: () => {
      assert.deepEqual(qn(one([sk(NOTES)], { off: { sets: [], members: [`billing|${NOTES}`] } })), ['billing:release-notes']);
    } },
    { name: 'plugin-disabled wins over invalid-skill; a 65-character name is invalid-skill', run: () => {
      assert.deepEqual(one([sk(NOTES)], { store: { catalog: [cat(NOTES, { pluginEnabled: false, valid: false })] } }).skipped.map((s) => s.reason), ['plugin-disabled']);
      assert.deepEqual(one([sk(LONG)], { store: { catalog: [cat(LONG)] } }).skipped.map((s) => s.reason), ['invalid-skill']);
    } },
    { name: 'skipped rows sort by set id then skill id, whatever reason or cap pushed them', run: () => {
      const r = resolve({ targets: [P(SHOP, { rank: 0 }), P(BILLING, { rank: 1 })], optOut: [`shop|${AUDIT}`], skillCap: 1 });
      assert.deepEqual(why(r), [`billing|${NOTES}:off`, `billing|${DEPLOY}:cap`, `general|${GRAPH}:cap`, `shop|${AUDIT}:opted-out`]);
    } },
    { name: 'a workspace\'s member order changes nothing (projects, routes)', run: () => {
      const ws = (members) => resolve({ targets: [{ kind: 'workspace', id: 'ws1', rank: 0, members }], teams: { 'ws:ws1': TEAM } });
      assert.equal(JSON.stringify(ws([{ key: SHOP }, { key: BILLING }])), JSON.stringify(ws([{ key: BILLING }, { key: SHOP }])));
    } },
  ]);
});

// ── IO shell: resolveSkillRegistry (§4.2); cachedSkillTeamFor ──────────────────────────────────────────────
import { after } from 'node:test';
import { join as joinPath } from 'node:path';
import { cachedSkillTeamFor, resolveSkillRegistry } from '../src/core/skills-registry/resolve.mjs';
import { useTempHome } from './helpers/temp-home.mjs';

const tempHome = useTempHome(after, 'worca-skills-resolve-');
const SNAP = { newer: false, bases: {}, sets: STORE.sets, teams: STORE.teams, projects: STORE.projects, secrets: {}, tests: {} };

test('resolveSkillRegistry: one snapshot + the catalog + host facts; installed names rename; a managed host is blocked', async () => {
  let reads = 0;
  const r = await resolveSkillRegistry({ surface: 'pipeline', targets: [P(BILLING)] }, {
    readStore: async () => { reads += 1; return SNAP; },
    loadSkills: async () => CATALOG,
    hostFacts: () => ({ installedPluginNames: ['billing'], sideloadDisabled: true }),
  });
  assert.equal(reads, 1);
  assert.deepEqual(qn(r), ['billing-set:deploy-checklist']);
  assert.equal(r.plugins[0].renamedPlugin, true);
  assert.equal(r.newer, false);
  assert.equal(r.blocked, 'sideload-disabled');
});

test('resolveSkillRegistry: a registry written by a newer Worca resolves nothing and reads no catalog', async () => {
  const never = () => { throw new Error('must not be called'); };
  const deps = { readStore: async () => ({ ...SNAP, newer: true }), loadSkills: never, hostFacts: never };
  assert.deepEqual(await resolveSkillRegistry({ surface: 'ask' }, deps), { mounted: [], plugins: [], skipped: [], sets: [], newer: true, blocked: null });
});

test('resolveSkillRegistry: the real IO on an empty home mounts nothing (only the implicit General) and is not blocked', async () => {
  const prev = process.env.WORCA_CLAUDE_MANAGED_SETTINGS;
  process.env.WORCA_CLAUDE_MANAGED_SETTINGS = joinPath(tempHome, 'no-managed-settings.json');
  try {
    const r = await resolveSkillRegistry({ surface: 'pipeline', targets: [P(BILLING)] });
    assert.deepEqual([r.mounted, r.plugins, r.skipped, r.newer, r.blocked], [[], [], [], false, null]);
    assert.deepEqual(r.sets.map((s) => [s.id, s.skills, s.started, s.pluginName]), [['general', 0, 0, 'general']]);
  } finally {
    if (prev === undefined) delete process.env.WORCA_CLAUDE_MANAGED_SETTINGS; else process.env.WORCA_CLAUDE_MANAGED_SETTINGS = prev;
  }
});

test('cachedSkillTeamFor: P2\'s cached Team input as is — requiredSkills only when the policy requires a skill; null without a policy', async () => {
  const doc = (fields) => ({ fields });
  const policy = { home: TEAM_HOME, doc: doc({ 'skills.required': { value: [{ plugin: 'acme', skill: 'deploy-checklist' }] },
    'mcp.required': { value: [{ plugin: 'acme', server: 'sentry' }] } }) };
  const seam = (p) => ({ policyForKey: () => p });
  assert.deepEqual(await cachedSkillTeamFor({ projectKey: BILLING }, seam(policy)),
    { home: TEAM_HOME, required: [{ plugin: 'acme', server: 'sentry' }], requiredSkills: [{ plugin: 'acme', skill: 'deploy-checklist' }] });
  assert.deepEqual(await cachedSkillTeamFor({ projectKey: BILLING }, seam({ home: TEAM_HOME, doc: doc({ 'mcp.required': { value: [{ plugin: 'acme', server: 'sentry' }] } }) })),
    { home: TEAM_HOME, required: [{ plugin: 'acme', server: 'sentry' }] });
  assert.equal(await cachedSkillTeamFor({ projectKey: BILLING }, seam(null)), null);
  // Fed to the resolver as is: the Team skill mounts under the Team set's plugin.
  const team = await cachedSkillTeamFor({ projectKey: BILLING }, seam(policy));
  assert.ok(qn(resolve({ targets: [P(BILLING)], teams: { [BILLING]: team } })).includes('team-platfor:deploy-checklist'));
});
