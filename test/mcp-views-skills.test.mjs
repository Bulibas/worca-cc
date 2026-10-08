// test/mcp-views-skills.test.mjs — the read models of skills in sets (skills registry §6.2, §6.3, §7): skill cards on a set
// (name agents see, catalog facts, state and problem text), the plugin name a set loads as, skill counts, the skills
// catalog view, the Team locks on skills, and viewContext's skill catalog and host facts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { useTempHome } from './helpers/temp-home.mjs';
import {
  buildSetsView, buildSetView, buildSkillCatalogView, skillMemberViews, teamSkillMemberRefusal, teamDuplicateSource,
  getSetView, viewContext, listSkillCatalogView, recordSkillUpdateCheck,
} from '../src/core/mcp/views.mjs';
import { createSet, putSkillMember } from '../src/core/mcp/store.mjs';
import { skillSkipReasonText } from '../src/core/skills-registry/texts.mjs';
import { canonicalJson, sha256Hex } from '../src/core/mcp/definitions.mjs';

useTempHome(after);

const nul = (o) => Object.assign(Object.create(null), o);
const DEPLOY = 'skill:plugin:acme-tools/deploy-checklist';
const LINT = 'skill:plugin:acme-tools/lint';
const NOTES = 'skill:library:release-notes';
const OLD = 'skill:plugin:old-tools/legacy';
const BAD = 'skill:library:bad-one';
const GONE = 'skill:library:gone';
const TEAM = 'team-acme-platform-9333';
const skill = (id, extra = {}) => {
  const [source, rest] = id.startsWith('skill:plugin:') ? ['plugin', id.slice(13)] : ['library', id.slice(14)];
  const plugin = source === 'plugin' ? rest.slice(0, rest.indexOf('/')) : null;
  const name = rest.slice(rest.indexOf('/') + 1);
  return { id, source, plugin, name, dir: `/x/${name}`, description: `${name} steps`, whenToUse: null,
    frontmatter: { allowedTools: null, hooks: false, shell: false, disableModelInvocation: false, pluginRootRefs: false },
    files: 1, bytes: 10, scripts: [], shellBlocks: 0, hash: 'h', code: source === 'plugin' ? '3f9c21a' : null,
    pluginEnabled: true, valid: true, problems: [], ...extra };
};
const BOTH = 'skill:plugin:old-tools/both';
const AUDIT = 'skill:plugin:acme-tools/audit';
const SKILLS = [
  skill(BAD, { valid: false, problems: ['frontmatter name differs from the folder'] }),
  skill(BOTH, { pluginEnabled: false, valid: false, problems: ['no frontmatter'] }),
  skill(DEPLOY, { files: 4, scripts: ['scripts/run.sh'], shellBlocks: 2 }),
  skill(LINT, { frontmatter: { allowedTools: null, hooks: true, shell: false, disableModelInvocation: false, pluginRootRefs: true } }),
  skill(NOTES),
  skill(OLD, { pluginEnabled: false }),
  skill(AUDIT),
];
const TEAMS = [{ home: 'acme/platform', required: [], requiredSkills: [{ plugin: 'acme-tools', skill: 'deploy-checklist' }, { plugin: 'acme-tools', skill: 'lint' },
  { plugin: 'acme-tools', skill: 'not-installed' }, { plugin: 'acme-tools', skill: 'audit' }] }];
function snapshot() {
  return {
    newer: false, bases: nul({}), manual: nul({}), policy: nul({}), retired: [], secrets: nul({}), tests: nul({}),
    sets: nul({
      general: { name: 'General', members: [], skills: [{ skill: NOTES, enabled: true }] },
      billing: { name: 'Billing', slug: 'billing', members: [], skills: [
        { skill: DEPLOY, enabled: true }, { skill: LINT, enabled: true, pending: true }, { skill: OLD, enabled: true },
        { skill: BAD, enabled: true }, { skill: GONE, enabled: true }, { skill: 'skill:git:acme/x', enabled: true }, { skill: BOTH, enabled: false }] },
      shop: { name: 'Shop', slug: 'shop', members: [] },
    }),
    teams: nul({
      'acme/platform': { id: TEAM, slug: 'team-platfor', name: 'Team · acme/platform', members: nul({}),
        skills: nul({ [DEPLOY]: { enabled: true, consent: sha256Hex(canonicalJson({ plugin: 'acme-tools', skill: 'deploy-checklist' })) },
          [LINT]: { enabled: true, consent: 7 } }) },
      'old/home': { id: 'team-old-home-1234', slug: 'team-home', name: 'Team · old/home', members: nul({}), skills: nul({ [LINT]: { enabled: true, consent: 'h' } }) },
    }),
    projects: nul({ 'billing-1a2b3c4d': { sets: ['billing'], includeGeneral: false } }),
  };
}
function ctx(over = {}) {
  return { snapshot: snapshot(), catalog: [], skillCatalog: SKILLS, teams: TEAMS, projects: [{ key: 'billing-1a2b3c4d', name: 'billing' }],
    projectHomes: { 'billing-1a2b3c4d': 'acme/platform' }, claudeNames: [], hostFacts: { installedPluginNames: [] },
    env: {}, platform: 'linux', execPath: '/usr/bin/node', worcaRoot: '/w', now: 0, ...over };
}
const why = (set, m) => skillSkipReasonText({ setId: set.id, setName: set.name, skillId: m.skillId, name: m.name, reason: m.reason });

test('skill cards: the name agents see, the catalog facts, and a state per member (reason; text for a problem only)', () => {
  const v = buildSetView(ctx(), 'billing');
  assert.deepEqual([v.set.pluginName, v.set.renamedPlugin], ['billing', false]);
  assert.deepEqual(v.members, [], 'servers unchanged');
  const by = Object.fromEntries(v.skills.map((m) => [m.skillId, m]));
  assert.deepEqual(v.skills.map((m) => m.skillId), [DEPLOY, LINT, OLD, BAD, GONE, 'skill:git:acme/x', BOTH], 'in the set\'s order');
  assert.equal(by[BOTH].reason, 'plugin-disabled', 'first match wins: missing, plugin disabled, invalid, needs consent, off');
  assert.deepEqual(by[DEPLOY], { skillId: DEPLOY, name: 'deploy-checklist', qualifiedName: 'billing:deploy-checklist', source: 'plugin',
    sourceLabel: 'acme-tools', description: 'deploy-checklist steps', enabled: true, valid: true, problems: [], files: 4,
    scripts: ['scripts/run.sh'], shellBlocks: 2, pluginRootRefs: false, hooks: false, reason: null, problem: null });
  assert.deepEqual([by[LINT].enabled, by[LINT].reason, by[LINT].problem, by[LINT].pluginRootRefs], [false, 'off', null, true], 'pending reads off; off is a choice');
  assert.deepEqual([by[LINT].hooks, by[GONE].hooks], [true, false], 'frontmatter `hooks:` is shown (U1: a badge, never a refusal); no entry ⇒ false');
  assert.deepEqual([by[OLD].reason, by[OLD].problem], ['plugin-disabled', why({ id: 'billing', name: 'Billing' }, by[OLD])]);
  assert.deepEqual([by[BAD].reason, by[BAD].valid, by[BAD].problems], ['invalid-skill', false, ['frontmatter name differs from the folder']]);
  assert.equal(by[BAD].problem, why({ id: 'billing', name: 'Billing' }, by[BAD]));
  assert.deepEqual([by[GONE].reason, by[GONE].name, by[GONE].source, by[GONE].sourceLabel, by[GONE].valid, by[GONE].qualifiedName],
    ['missing-skill', 'gone', 'library', 'Imported', false, 'billing:gone'], 'not in the catalog: named from its id');
  assert.ok(by[GONE].problem);
  assert.deepEqual([by['skill:git:acme/x'].name, by['skill:git:acme/x'].source, by['skill:git:acme/x'].sourceLabel], ['skill:git:acme/x', null, '']);
  assert.equal(buildSetView(ctx(), 'general').skills[0].qualifiedName, 'general:release-notes');
  assert.equal(buildSetView(ctx(), 'general').skills[0].sourceLabel, 'Imported');
  assert.deepEqual(buildSetView(ctx(), 'shop').skills, []);
});

test('the plugin name a set loads as: renamed when a Claude Code plugin of its slug is installed here', () => {
  const c = ctx({ hostFacts: { installedPluginNames: ['billing', 'general'] } });
  const v = buildSetView(c, 'billing');
  assert.deepEqual([v.set.pluginName, v.set.renamedPlugin], ['billing-set', true]);
  assert.equal(v.skills[0].qualifiedName, 'billing-set:deploy-checklist');
  assert.equal(buildSetView(c, 'general').skills[0].qualifiedName, 'general-set:release-notes');
  assert.deepEqual([buildSetView(c, TEAM).set.pluginName, buildSetView(c, TEAM).set.renamedPlugin], ['team-platfor', false]);
  const bare = ctx();
  delete bare.hostFacts;
  assert.equal(buildSetView(bare, 'billing').set.pluginName, 'billing', 'no host facts: nothing is taken');
});

test('Team set skills: from skills.required over the catalog; consent flag; never consented is a choice, not a problem', () => {
  const v = buildSetView(ctx(), TEAM);
  assert.deepEqual(v.skills.map((m) => [m.skillId, m.qualifiedName, m.enabled, m.reason, m.problem, m.team]), [
    [DEPLOY, 'team-platfor:deploy-checklist', true, null, null, { consented: true }],
    [LINT, 'team-platfor:lint', true, 'needs-consent', null, { consented: false }],
    [AUDIT, 'team-platfor:audit', false, 'needs-consent', null, { consented: false }]],
    'a consent that is not text is none; never consented comes before off; not-installed is no member');
  assert.deepEqual(buildSetView(ctx(), 'team-old-home-1234').skills, [], 'a greyed Team set has no skills');
});

test('buildSetsView: skillCount per set, beside serverCount', () => {
  const counts = Object.fromEntries(buildSetsView(ctx()).sets.map((s) => [s.id, [s.serverCount, s.skillCount]]));
  assert.deepEqual(counts, { general: [0, 1], billing: [0, 7], shop: [0, 0], [TEAM]: [0, 3], 'team-old-home-1234': [0, 0] });
});

test('buildSkillCatalogView: every entry as the catalog has it, the sets it is in, update and installed-plugin flags', () => {
  const v = buildSkillCatalogView(ctx({ hostFacts: { installedPluginNames: ['acme-tools'] }, updatesAvailable: [NOTES] }));
  assert.equal(v.newer, false);
  const by = Object.fromEntries(v.skills.map((s) => [s.id, s]));
  assert.deepEqual(v.skills.map((s) => s.id), SKILLS.map((s) => s.id));
  assert.deepEqual(by[DEPLOY].inSets, [{ id: 'billing', name: 'Billing' }, { id: TEAM, name: 'Team · acme/platform' }]);
  assert.deepEqual(by[NOTES].inSets, [{ id: 'general', name: 'General' }]);
  assert.deepEqual(by[LINT].inSets.map((s) => s.id), ['billing', TEAM], 'a greyed Team set\'s state is no membership');
  assert.deepEqual([by[NOTES].updateAvailable, by[DEPLOY].updateAvailable], [true, false]);
  assert.deepEqual([by[DEPLOY].installedPluginClash, by[OLD].installedPluginClash, by[NOTES].installedPluginClash], [true, false, false]);
  const { inSets, updateAvailable, installedPluginClash, ...rest } = by[DEPLOY];
  assert.deepEqual(rest, SKILLS.find((x) => x.id === DEPLOY), 'the §3.3 entry as it is');
  assert.equal(buildSkillCatalogView(ctx()).skills.every((s) => s.updateAvailable === false && s.installedPluginClash === false), true);
});

test('Check for updates: the last result per skill shows in the catalog view until a later check, Update or Remove clears it', () => {
  const avail = () => Object.fromEntries(buildSkillCatalogView(ctx()).skills.map((s) => [s.id, s.updateAvailable]));
  assert.equal(Object.values(avail()).some(Boolean), false, 'no check yet');
  recordSkillUpdateCheck(NOTES, true);
  recordSkillUpdateCheck(LINT, 'yes');
  assert.deepEqual([avail()[NOTES], avail()[LINT], avail()[DEPLOY]], [true, false, false], 'only `true` records one');
  assert.equal(buildSkillCatalogView(ctx({ updatesAvailable: [] })).skills.find((s) => s.id === NOTES).updateAvailable, false, 'ctx wins');
  recordSkillUpdateCheck(NOTES, false);
  assert.equal(avail()[NOTES], false);
});

test('Team locks on skills: update only, no add by hand, a never-consented skill turns on only from the checklist', () => {
  const c = ctx();
  assert.deepEqual(teamSkillMemberRefusal(c, TEAM, DEPLOY, { enabled: false }), { home: 'acme/platform' });
  assert.deepEqual(teamSkillMemberRefusal(c, TEAM, DEPLOY, { enabled: true }), { home: 'acme/platform' }, 'a consented skill switches freely');
  assert.deepEqual(teamSkillMemberRefusal(c, TEAM, LINT, { enabled: false }), { home: 'acme/platform' });
  assert.deepEqual(teamSkillMemberRefusal(c, TEAM, LINT, { enabled: true }), { status: 409, error: 'turn it on from the team checklist' });
  assert.deepEqual(teamSkillMemberRefusal(c, TEAM, NOTES, {}), { status: 409, error: 'Team set skills come from team policy and cannot be added here' });
  assert.equal(teamSkillMemberRefusal(c, 'team-nope-0000', DEPLOY, {}).status, 404);
  assert.equal(teamSkillMemberRefusal(c, 'team-old-home-1234', LINT, {}).status, 409, 'a greyed set has no skills');
  assert.deepEqual(teamDuplicateSource(c, TEAM), { home: 'acme/platform', members: [], skills: [DEPLOY, LINT, AUDIT] });
  assert.deepEqual(skillMemberViews(c, { id: 'billing', name: 'Billing', slug: 'billing', group: 'set' }).length, 7);
});

test('viewContext over the real store: the skill catalog and this host\'s installed Claude Code plugins', async () => {
  const home = mkdtempSync(join(tmpdir(), 'worca-views-skills-'));
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;   // os.homedir(): HOME on POSIX, USERPROFILE on Windows
  process.env.USERPROFILE = home;
  try {
    const { id } = await createSet('Payments');
    await putSkillMember(id, NOTES, {}, { entry: { id: NOTES } });
    let c = await viewContext();
    assert.deepEqual(c.skillCatalog, []);
    assert.deepEqual(c.hostFacts, { installedPluginNames: [] }, 'no ~/.claude/settings.json');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'payments@acme-market': true, 'tools@x': false, 'payments@other': true } }));
    c = await viewContext();
    assert.deepEqual(c.hostFacts.installedPluginNames, ['payments', 'tools'], 'every enabledPlugins key, before its @');
    const v = await getSetView(id);
    assert.deepEqual([v.set.pluginName, v.set.renamedPlugin], ['payments-set', true]);
    assert.deepEqual(v.skills.map((m) => [m.qualifiedName, m.reason]), [['payments-set:release-notes', 'missing-skill']]);
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: ['payments'] }));
    assert.deepEqual((await viewContext()).hostFacts.installedPluginNames, [], 'enabledPlugins is a map or nothing');
    writeFileSync(join(home, '.claude', 'settings.json'), '{ not json');
    assert.deepEqual((await viewContext()).hostFacts.installedPluginNames, [], 'unreadable: none');
    assert.deepEqual((await listSkillCatalogView()).skills, []);
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
