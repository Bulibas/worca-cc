// test/mcp-store-skills.test.mjs — skills in sets (skills registry §3.1, §3.2): the member-id grammar, `sets[].skills` and
// `teams[].skills` in mcp/sets.json (schema 1, additive), and the store's skill operations.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshHomes, plain, put, disk, recordWrites } from './helpers/mcp-store-fixtures.mjs';
import {
  readMcpStore, createSet, renameSet, duplicateSet, deleteSet, forgetTeamState,
  putSkillMember, deleteSkillMember, removeSkillEverywhere, setTeamSkillState,
} from '../src/core/mcp/store.mjs';
import {
  SET_MEMBER_ID_SRC, SET_MEMBER_ID_RE, MEMBERSHIP_KEY_RE, SERVER_ID_RE, SETS_API_NOUNS, isSkillMemberKey,
} from '../src/core/mcp/definitions.mjs';
import { SKILL_ID_SRC } from '../src/core/skills-registry/ids.mjs';

freshHomes(after);
const TEAM = 'team-acme-platform-9333';
const TEAM_REC = { id: TEAM, slug: 'team-platfor', name: 'Team · acme/platform' };

test('member ids (§3.1): a set member is a server id or a skill id; membership keys widen, SERVER_ID_RE does not', () => {
  assert.ok(SET_MEMBER_ID_SRC.endsWith(`|${SKILL_ID_SRC})`), 'definitions.mjs copies SKILL_ID_SRC as a literal: it must equal ids.mjs');
  const skills = ['skill:plugin:acme-tools/deploy-checklist', 'skill:plugin:a/x', 'skill:library:release-notes', 'skill:library:2fa'];
  const servers = ['manual:pg', 'plugin:acme-tools/sentry', 'policy:acme/platform/github'];
  for (const id of [...skills, ...servers]) {
    assert.match(id, SET_MEMBER_ID_RE, id);
    assert.match(`billing|${id}`, MEMBERSHIP_KEY_RE, id);
  }
  for (const id of skills) assert.doesNotMatch(id, SERVER_ID_RE, `server routes keep refusing ${id}`);
  for (const id of ['skill:plugin:acme', 'skill:plugin:Acme/x', 'skill:plugin:acme/X', 'skill:plugin:a--b/x', 'skill:library:',
    'skill:library:a_b', 'skill:library:-a', 'skill:git:x', 'skill:plugin:acme/x/y', 'skill:library:a/b', 'mcp:x']) {
    assert.doesNotMatch(id, SET_MEMBER_ID_RE, id);
    assert.doesNotMatch(`billing|${id}`, MEMBERSHIP_KEY_RE, id);
  }
  for (const k of ['billing|', '|skill:library:x', 'Billing|skill:library:x', 'billing|skill:library:x|y']) assert.doesNotMatch(k, MEMBERSHIP_KEY_RE, k);
});

test('isSkillMemberKey: a membership key whose member is a skill — text only', () => {
  assert.equal(isSkillMemberKey('billing|skill:plugin:acme-tools/deploy-checklist'), true);
  assert.equal(isSkillMemberKey('team-acme-platform-9333|skill:library:release-notes'), true);
  for (const k of ['billing|plugin:acme-tools/sentry', 'billing|manual:pg', 'Billing|skill:library:x', 'skill:library:x', 'billing|skill:git:x',
    null, 42, { toString: () => 'billing|skill:library:x' }]) {
    assert.equal(isSkillMemberKey(k), false, String(k));
  }
});

test('skill ids stop at 1024 characters and never throw on a long entry (mcpOptOut, mcpOff come from 8 MB bodies)', () => {
  for (const s of [`skill:plugin:a${'-a'.repeat(4e6)}/x`, `skill:plugin:a/${'a-'.repeat(4e6)}a`, `skill:library:${'a-'.repeat(4e6)}a`]) {
    assert.equal(SET_MEMBER_ID_RE.test(s), false);
    assert.equal(MEMBERSHIP_KEY_RE.test(`x|${s}`), false);
    assert.equal(isSkillMemberKey(`x|${s}`), false);
  }
  const id = (n) => `skill:library:${'a'.repeat(n - 14)}`;   // a skill id of n characters
  assert.match(`x|${id(1024)}`, MEMBERSHIP_KEY_RE);
  assert.equal(isSkillMemberKey(`x|${id(1024)}`), true);
  assert.doesNotMatch(`x|${id(1025)}`, MEMBERSHIP_KEY_RE);
  assert.equal(isSkillMemberKey(`x|${id(1025)}`), false);
});

test('SETS_API_NOUNS: the words after /api/sets/ that name another part of the Sets API, never a set', () => {
  assert.deepEqual([...SETS_API_NOUNS], ['servers', 'projects', 'teams', 'preview']);
  assert.equal(Object.isFrozen(SETS_API_NOUNS), true);
});

test('a sets.json without skills reads and writes as before: no skills key in the snapshot or the file', async () => {
  put('sets', { sets: { billing: { name: 'Billing', slug: 'billing', members: [] } }, teams: { 'acme/platform': { ...TEAM_REC, members: {} } } });
  const s = await readMcpStore();
  for (const o of [s.sets.billing, s.sets.general, s.teams['acme/platform']]) assert.equal(Object.hasOwn(o, 'skills'), false);
  await renameSet('billing', 'Billing EU');
  assert.deepEqual(disk('sets'), { schema: 1, sets: { billing: { name: 'Billing EU', slug: 'billing', members: [] } }, retired: [],
    teams: { 'acme/platform': { ...TEAM_REC, members: {} } }, projects: {} });
});

test('hand edits in skills read as absent: not an object, an id not text, a repeated id, a repeated name; none left ⇒ no key', async () => {
  const kept = [
    { skill: 'skill:plugin:acme-tools/deploy', enabled: true },
    { skill: 'skill:library:notes', enabled: 'yes' },            // kept as written: readers take enabled === true
    { skill: 'skill:git:acme/deploy', enabled: true, at: 'v9' },  // an id a newer Worca writes: kept, never parsed
  ];
  put('sets', {
    sets: {
      billing: { name: 'Billing', slug: 'billing', members: [], skills: ['x', null, { skill: 7 }, { enabled: true }, kept[0],
        { skill: 'skill:plugin:acme-tools/deploy', enabled: false }, { skill: 'skill:library:deploy', enabled: true }, kept[1], kept[2],
        { skill: 'skill:git:acme/deploy', enabled: false }] },   // a repeated id this build cannot parse
      shop: { name: 'Shop', slug: 'shop', members: [], skills: 'junk' },
      ops: { name: 'Ops', slug: 'ops', members: [], skills: [] },
    },
    teams: {
      'acme/platform': { ...TEAM_REC, members: {}, skills: { a: 'x', 'skill:plugin:acme-tools/deploy': { enabled: true, consent: null } } },
      'other/home': { id: 'team-other-home-1111', slug: 'team-home', name: 'Team · other/home', members: {}, skills: [1] },
      'third/home': { id: 'team-third-home-2222', slug: 'team-home-2', name: 'Team · third/home', members: {}, skills: { b: 1 } },
    },
  });
  const s = await readMcpStore();
  assert.deepEqual(plain(s.sets.billing.skills), kept);
  assert.equal(Object.hasOwn(s.sets.shop, 'skills'), false);
  assert.equal(Object.hasOwn(s.sets.ops, 'skills'), false);
  assert.deepEqual(plain(s.teams['acme/platform'].skills), { 'skill:plugin:acme-tools/deploy': { enabled: true, consent: null } });
  assert.equal(Object.hasOwn(s.teams['other/home'], 'skills'), false);
  assert.equal(Object.hasOwn(s.teams['third/home'], 'skills'), false);
  await renameSet('billing', 'Billing EU');   // the next write drops what read as absent
  const d = disk('sets');
  assert.deepEqual(d.sets.billing.skills, kept);
  assert.equal(Object.hasOwn(d.sets.shop, 'skills'), false);
  assert.deepEqual(d.teams['acme/platform'].skills, { 'skill:plugin:acme-tools/deploy': { enabled: true, consent: null } });
  assert.equal(Object.hasOwn(d.teams['other/home'], 'skills'), false);
});

test('General is written once it holds a skill, even with no MCP member (implicit only while it holds neither)', async () => {
  put('sets', { sets: { general: { name: 'General', members: [], skills: [{ skill: 'skill:library:notes', enabled: true }] } } });
  await createSet('Shop');
  assert.deepEqual(disk('sets').sets.general, { name: 'General', members: [], skills: [{ skill: 'skill:library:notes', enabled: true }] });
  put('sets', { sets: { general: { name: 'General', members: [], skills: [] } } });
  await createSet('Shop');
  assert.equal(Object.hasOwn(disk('sets').sets, 'general'), false, 'no members and no skills: still implicit');
});

test('a new set never takes an id the /api/sets paths use for something else (SETS_API_NOUNS)', async () => {
  for (const n of ['Servers', 'Projects', 'Teams', 'Preview']) assert.equal((await createSet(n)).id, `${n.toLowerCase()}-2`);
  assert.equal((await createSet('Sets')).id, 'sets', 'only the four nouns are reserved');
  assert.equal((await duplicateSet('sets', 'Servers!')).id, 'servers-3', 'nor does a duplicate');
});

const DEPLOY = 'skill:plugin:acme-tools/deploy-checklist';
const OTHER = 'skill:plugin:acme-tools/other';
const NOTES = 'skill:library:release-notes';
const entry = (id) => ({ id });   // a catalog entry: the store reads only its id
const BILLING = { name: 'Billing', slug: 'billing', members: [] };

test('putSkillMember: adds a skill on by default, switches it, one sets.json write each, no write when nothing changes', async () => {
  put('sets', { sets: { billing: BILLING } });
  let writes = await recordWrites(() => putSkillMember('billing', DEPLOY, {}, { entry: entry(DEPLOY) }));
  assert.deepEqual(writes.map((w) => w.file), ['sets']);
  assert.deepEqual(writes[0].json.sets.billing.skills, [{ skill: DEPLOY, enabled: true }]);
  writes = await recordWrites(() => putSkillMember('billing', DEPLOY, { enabled: false }, { entry: entry(DEPLOY) }));
  assert.deepEqual(writes.map((w) => [w.file, w.json.sets.billing.skills]), [['sets', [{ skill: DEPLOY, enabled: false }]]]);
  assert.deepEqual(await recordWrites(() => putSkillMember('billing', DEPLOY, { enabled: false }, { entry: entry(DEPLOY) })), []);
  assert.deepEqual(await recordWrites(() => putSkillMember('billing', DEPLOY, {}, { entry: entry(DEPLOY) })), [], 'no enabled keeps the switch');
  await putSkillMember('billing', NOTES, { enabled: true }, { entry: entry(NOTES) });
  assert.deepEqual(disk('sets').sets.billing.skills, [{ skill: DEPLOY, enabled: false }, { skill: NOTES, enabled: true }], 'added at the end');
  put('sets', { sets: { billing: { ...BILLING, skills: [{ skill: DEPLOY, enabled: true, pending: true, later: 1 }] } } });
  await putSkillMember('billing', DEPLOY, { enabled: true }, { entry: entry(DEPLOY) });
  assert.deepEqual(disk('sets').sets.billing.skills, [{ skill: DEPLOY, enabled: true, later: 1 }], 'a write clears pending and keeps other keys');
});

test('putSkillMember: one skill name per set (409) — the same name from another source too; another set may hold it', async () => {
  put('sets', { sets: { billing: { ...BILLING, skills: [{ skill: 'skill:plugin:acme-tools/deploy', enabled: true }] }, shop: { name: 'Shop', slug: 'shop', members: [] } } });
  for (const id of ['skill:library:deploy', 'skill:plugin:other-tools/deploy']) {
    await assert.rejects(putSkillMember('billing', id, {}, { entry: entry(id) }), { status: 409, message: 'a skill named "deploy" is already in this set' });
  }
  await putSkillMember('shop', 'skill:library:deploy', {}, { entry: entry('skill:library:deploy') });
  await putSkillMember('billing', 'skill:plugin:acme-tools/deploy', { enabled: false }, { entry: entry('skill:plugin:acme-tools/deploy') });
  assert.deepEqual(disk('sets').sets.billing.skills, [{ skill: 'skill:plugin:acme-tools/deploy', enabled: false }], 'its own name: an update');
  assert.deepEqual(disk('sets').sets.shop.skills, [{ skill: 'skill:library:deploy', enabled: true }]);
});

test('putSkillMember refusals: no such set 404; a bad id, a missing or other entry, enabled not boolean 400; General holds skills', async () => {
  put('sets', {});
  await assert.rejects(putSkillMember('nope', DEPLOY, {}, { entry: entry(DEPLOY) }), { status: 404 });
  for (const id of ['plugin:acme-tools/sentry', 'skill:git:x', '', null]) {
    await assert.rejects(putSkillMember('general', id, {}, { entry: entry(id) }), { status: 400, message: 'invalid skill id' });
  }
  await assert.rejects(putSkillMember('general', DEPLOY, {}, {}), { status: 400, message: 'the skill catalog entry is required' });
  await assert.rejects(putSkillMember('general', DEPLOY, {}, { entry: entry(NOTES) }), { status: 400, message: 'the skill catalog entry is required' });
  await assert.rejects(putSkillMember('general', DEPLOY, { enabled: 'yes' }, { entry: entry(DEPLOY) }), { status: 400, message: 'enabled must be true or false' });
  await putSkillMember('general', DEPLOY, {}, { entry: entry(DEPLOY) });
  assert.deepEqual(disk('sets').sets.general, { name: 'General', members: [], skills: [{ skill: DEPLOY, enabled: true }] });
});

test('putSkillMember on a Team set: the state lives in teams[home].skills, the first write persists the record; plugin skills only', async () => {
  put('sets', {});
  await assert.rejects(putSkillMember(TEAM, DEPLOY, {}, { entry: entry(DEPLOY) }), { status: 400, message: 'a Team set write needs its home' });
  await assert.rejects(putSkillMember(TEAM, DEPLOY, {}, { team: { home: 'other/home' }, entry: entry(DEPLOY) }), { status: 404 });
  await assert.rejects(putSkillMember(TEAM, NOTES, {}, { team: { home: 'acme/platform' }, entry: entry(NOTES) }), { status: 400, message: 'Team set skills are plugin skills' });
  await putSkillMember(TEAM, DEPLOY, { enabled: false }, { team: { home: 'acme/platform' }, entry: entry(DEPLOY) });
  assert.deepEqual(disk('sets').teams['acme/platform'], { ...TEAM_REC, members: {}, skills: { [DEPLOY]: { enabled: false, consent: null } } });
  assert.equal(Object.hasOwn(disk('sets').sets, TEAM), false, 'never a user set');
  await setTeamSkillState('acme/platform', DEPLOY, { enabled: true, consent: 'h1' });
  await putSkillMember(TEAM, DEPLOY, { enabled: false }, { team: { home: 'acme/platform' }, entry: entry(DEPLOY) });
  assert.deepEqual(disk('sets').teams['acme/platform'].skills[DEPLOY], { enabled: false, consent: 'h1' }, 'the switch keeps consent');
});

test('deleteSkillMember: from a user set or General; the last one leaves no key; 404 when not there; Team sets refuse', async () => {
  put('sets', { sets: { billing: { ...BILLING, skills: [{ skill: DEPLOY, enabled: true }, { skill: NOTES, enabled: false }] } } });
  const writes = await recordWrites(() => deleteSkillMember('billing', DEPLOY));
  assert.deepEqual(writes.map((w) => [w.file, w.json.sets.billing.skills]), [['sets', [{ skill: NOTES, enabled: false }]]]);
  await deleteSkillMember('billing', NOTES);
  assert.deepEqual(disk('sets').sets.billing, BILLING);
  await assert.rejects(deleteSkillMember('billing', NOTES), { status: 404, message: `${NOTES} is not in this set` });
  await assert.rejects(deleteSkillMember('nope', NOTES), { status: 404 });
  await assert.rejects(deleteSkillMember(TEAM, DEPLOY), { status: 400, message: 'Team set skills are not removed by hand' });
  await assert.rejects(deleteSkillMember('billing', { toString() { throw new Error('x'); } }), { status: 400, message: 'invalid skill id' });
});

test('removeSkillEverywhere: every set and every home\'s Team state, one sets.json write; nothing to remove ⇒ no write', async () => {
  put('sets', {
    sets: { general: { name: 'General', members: [], skills: [{ skill: DEPLOY, enabled: true }] },
      billing: { ...BILLING, skills: [{ skill: DEPLOY, enabled: false }, { skill: NOTES, enabled: true }] },
      shop: { name: 'Shop', slug: 'shop', members: [] } },
    teams: { 'acme/platform': { ...TEAM_REC, members: {}, skills: { [DEPLOY]: { enabled: true, consent: 'h' } } },
      'acme/other': { id: 'team-acme-other-1111', slug: 'team-other', name: 'Team · acme/other', members: {}, skills: { [OTHER]: { enabled: true, consent: 'h' } } } },
  });
  const writes = await recordWrites(() => removeSkillEverywhere(DEPLOY));
  assert.deepEqual(writes.map((w) => w.file), ['sets']);
  const d = writes[0].json;
  assert.equal(Object.hasOwn(d.sets, 'general'), false, 'General held only it: implicit again');
  assert.deepEqual(d.sets.billing.skills, [{ skill: NOTES, enabled: true }]);
  assert.equal(Object.hasOwn(d.teams['acme/platform'], 'skills'), false);
  assert.deepEqual(d.teams['acme/other'].skills, { [OTHER]: { enabled: true, consent: 'h' } });
  assert.deepEqual(await recordWrites(() => removeSkillEverywhere(DEPLOY)), []);
});

test('setTeamSkillState: the first write persists the home\'s record; enabled and consent replace their keys; refusals', async () => {
  put('sets', {});
  await setTeamSkillState('acme/platform', DEPLOY, { enabled: true, consent: 'h1' });
  assert.deepEqual(disk('sets').teams['acme/platform'], { ...TEAM_REC, members: {}, skills: { [DEPLOY]: { enabled: true, consent: 'h1' } } });
  await setTeamSkillState('acme/platform', DEPLOY, { enabled: false });
  assert.deepEqual(disk('sets').teams['acme/platform'].skills[DEPLOY], { enabled: false, consent: 'h1' });
  await setTeamSkillState('acme/platform', DEPLOY, { consent: null, values: { x: 1 } });
  assert.deepEqual(disk('sets').teams['acme/platform'].skills[DEPLOY], { enabled: false, consent: null }, 'only enabled and consent are written');
  for (const [id, patch, message] of [[NOTES, {}, 'Team set skills are plugin skills'], ['plugin:acme-tools/sentry', {}, 'Team set skills are plugin skills'],
    [DEPLOY, { enabled: 1 }, 'enabled must be true or false'], [DEPLOY, { consent: 5 }, 'consent must be text or null'], [DEPLOY, null, 'patch must be an object']]) {
    await assert.rejects(setTeamSkillState('acme/platform', id, patch), { status: 400, message });
  }
  for (const home of [undefined, 7, { toString: () => 'acme/platform' }]) {
    await assert.rejects(setTeamSkillState(home, DEPLOY, { enabled: true }), { status: 400, message: 'a Team set write needs its home' });
  }
});

test('forgetTeamState: listed skill ids leave with the listed servers; no list forgets the whole home', async () => {
  const SENTRY = 'plugin:acme-tools/sentry';
  put('sets', { teams: { 'acme/platform': { ...TEAM_REC, members: { [SENTRY]: { enabled: true, values: {}, seeded: {}, consent: 'h' } },
    skills: { [DEPLOY]: { enabled: true, consent: 'h' }, [OTHER]: { enabled: false, consent: null } } } } });
  const writes = await recordWrites(() => forgetTeamState('acme/platform', [DEPLOY]));
  assert.deepEqual(writes.map((w) => w.file), ['sets'], 'a skill holds no secret and no test: only sets.json is written');
  assert.deepEqual(Object.keys(disk('sets').teams['acme/platform'].skills), [OTHER]);
  assert.ok(disk('sets').teams['acme/platform'].members[SENTRY], 'a server not listed stays');
  await forgetTeamState('acme/platform', [OTHER, SENTRY]);
  assert.deepEqual(disk('sets').teams['acme/platform'], { ...TEAM_REC, members: {} }, 'no skill left ⇒ no key');
  await setTeamSkillState('acme/platform', DEPLOY, { enabled: true, consent: 'h' });
  await forgetTeamState('acme/platform');
  assert.equal(Object.hasOwn(disk('sets').teams, 'acme/platform'), false);
});

test('duplicateSet carries skills (a user set\'s as they are; a Team set\'s derived ones with their local switch); deleteSet takes them along', async () => {
  const NEVER = 'skill:plugin:acme-tools/never';
  put('sets', {
    sets: { billing: { ...BILLING, skills: [{ skill: DEPLOY, enabled: false }, { skill: NOTES, enabled: true }] } },
    teams: { 'acme/platform': { ...TEAM_REC, members: {}, skills: { [DEPLOY]: { enabled: true, consent: 'h' }, [OTHER]: { enabled: true, consent: 'h', pending: true } } } },
  });
  const a = await duplicateSet('billing', 'Billing copy');
  assert.deepEqual(disk('sets').sets[a.id].skills, [{ skill: DEPLOY, enabled: false }, { skill: NOTES, enabled: true }]);
  const b = await duplicateSet(TEAM, 'Platform', { team: { home: 'acme/platform', members: [], skills: [DEPLOY, OTHER, NEVER, DEPLOY] } });
  assert.deepEqual(disk('sets').sets[b.id].skills, [{ skill: DEPLOY, enabled: true }, { skill: OTHER, enabled: false }, { skill: NEVER, enabled: false }],
    'a pending or never-consented skill is off in the copy; a repeat is copied once');
  const c = await duplicateSet(TEAM, 'Platform bare', { team: { home: 'acme/platform', members: [] } });
  assert.equal(Object.hasOwn(disk('sets').sets[c.id], 'skills'), false, 'no skills ⇒ no key');
  await deleteSet('billing');
  assert.equal(Object.hasOwn(disk('sets').sets, 'billing'), false);
  assert.deepEqual((await readMcpStore()).sets[a.id].skills.map((k) => k.skill), [DEPLOY, NOTES], 'the copy keeps its own');
});
