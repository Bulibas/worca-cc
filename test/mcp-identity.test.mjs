// test/mcp-identity.test.mjs — MCP registry identity (design §4.2, §4.4): base names, set ids, set slugs,
// Team set records, copy names and secret env names, checked against the §5.8 worked example.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignBaseNames, newSetId, slugFor, teamRecord, teamRecordsFor, copyName, secretEnvName } from '../src/core/mcp/identity.mjs';
import { sha256Hex } from '../src/core/mcp/definitions.mjs';

const plain = (v) => JSON.parse(JSON.stringify(v));
const hex4 = (s) => sha256Hex(s).slice(0, 4);

test('bases: declared name, then <plugin>-<name> / <home segment>-<name>, arrival order manual → plugin → policy by id', () => {
  const ids = ['policy:acme/platform/sentry', 'plugin:b-tools/sentry', 'policy:acme/platform/linear', 'plugin:acme-tools/sentry', 'manual:linear'];
  assert.deepEqual(plain(assignBaseNames({}, ids)), {
    'manual:linear': 'linear',
    'plugin:acme-tools/sentry': 'sentry',
    'plugin:b-tools/sentry': 'b-tools-sentry',
    'policy:acme/platform/linear': 'platform-linear',
    'policy:acme/platform/sentry': 'platform-sentry',
  });
  assert.deepEqual(plain(assignBaseNames({}, ['policy:acme/my_platform/github', 'policy:x/my-platform/github'])),
    { 'policy:acme/my_platform/github': 'github', 'policy:x/my-platform/github': 'my-platform-github' });
  assert.deepEqual(plain(assignBaseNames({ g: 'github' }, ['policy:acme/my_platform/github'])), { 'policy:acme/my_platform/github': 'my-platform-github' });
});

test('bases: only ids without one; a base is never reassigned; hash fallbacks', { timeout: 5000 }, () => {
  const bases = { 'plugin:gone/sentry': 'sentry', 'manual:jira': 'jira' };
  assert.deepEqual(plain(assignBaseNames(bases, ['manual:jira', 'plugin:acme-tools/sentry'])), { 'plugin:acme-tools/sentry': 'acme-tools-sentry' });
  const id = 'plugin:a-very-long-plugin-name/sentry'; // <plugin>-<name> is over 20 chars
  assert.equal(assignBaseNames(bases, [id])[id], `sentry-${hex4(id)}`);
  const held = { ...bases, x: `sentry-${hex4(id)}` };
  assert.equal(assignBaseNames(held, [id])[id], `sentry-${hex4(`${id}\u00001`)}`);
  const long = 'plugin:p/abcdefghijklmnopqrs'; // 19-char name, taken: cut to 15
  assert.equal(assignBaseNames({ y: 'abcdefghijklmnopqrs', z: 'p-abcdefghijklmnopqrs' }, [long])[long], `abcdefghijklmno-${hex4(long)}`);
  const alt = 'plugin:acme-tools/sentry'; // step 2's name is held too: never shared
  assert.equal(assignBaseNames({ a: 'sentry', b: 'acme-tools-sentry' }, [alt])[alt], `sentry-${hex4(alt)}`);
  assert.deepEqual(plain(assignBaseNames({}, [alt, alt])), { [alt]: 'sentry' }); // an id listed twice is one arrival
});

test('set ids: normalized name, s- for a leading non-letter or reserved id, -2… never taken or retired', () => {
  assert.equal(newSetId('Billing', { taken: [], retired: [] }), 'billing');
  assert.equal(newSetId('Billing & Shop!', { taken: [], retired: [] }), 'billing-shop');
  assert.equal(newSetId('Billing', { taken: ['billing'], retired: ['billing-2'] }), 'billing-3');
  assert.equal(newSetId('2024 Q1', { taken: [], retired: [] }), 's-2024-q1');
  assert.equal(newSetId('Team Alpha', { taken: [], retired: [] }), 's-team-alpha');
  assert.equal(newSetId('Team', { taken: [], retired: [] }), 's-team'); // `team` would become team-2, a Team set id
  assert.equal(newSetId('Team', { taken: ['s-team'], retired: ['s-team-2'] }), 's-team-3');
  assert.equal(newSetId(`2${'x'.repeat(39)}`, { taken: [], retired: [] }), `s-2${'x'.repeat(29)}`); // prefixed, then cut to 32
  assert.equal(newSetId('General!', { taken: [], retired: [] }), 's-general');
  const long = 'x'.repeat(40);
  assert.equal(newSetId(long, { taken: [], retired: [] }), 'x'.repeat(32));
  assert.equal(newSetId(long, { taken: ['x'.repeat(32)], retired: [] }), `${'x'.repeat(30)}-2`);
  const first = newSetId('日本', { taken: [], retired: [] }); // nothing survives normalization
  const second = newSetId('中文', { taken: [first], retired: [] });
  assert.deepEqual([first, second], ['s-', 's--2']);
  for (const id of [first, second]) assert.match(id, /^[a-z][a-z0-9-]{0,31}$/);
  assert.equal(slugFor({ setId: second, source: second }, [first]), 's--2');
});

test('set slugs: cut to 12 without a trailing -, reserved w, hash forms on a clash', () => {
  assert.equal(slugFor({ setId: 'billing', source: 'billing' }, []), 'billing');
  assert.equal(slugFor({ setId: 'customer-support-eu', source: 'customer-support-eu' }, []), 'customer-sup');
  assert.equal(slugFor({ setId: 'abcdefghijk-x', source: 'abcdefghijk-x' }, []), 'abcdefghijk');
  assert.equal(slugFor({ setId: 'w', source: 'w' }, []), `w-${hex4('w')}`);
  assert.equal(slugFor({ setId: 'billing-2', source: 'billing-2' }, ['billing-2']), `billing-${hex4('billing-2')}`);
  assert.equal(slugFor({ setId: 'billing-2', source: 'billing-2' }, ['billing-2', `billing-${hex4('billing-2')}`]), `billing-${hex4('billing-2\u00001')}`);
});

test('Team records: team-<home normalized, 22>-<hex4>, slug from the last home segment, name clipped to 40', () => {
  assert.deepEqual(teamRecord('acme/platform', { takenSlugs: [] }), { id: 'team-acme-platform-9333', slug: 'team-platfor', name: 'Team · acme/platform' });
  const other = teamRecord('other/platform', { takenSlugs: ['team-platfor'] });
  assert.equal(other.slug, `team-pl-${hex4(other.id)}`);
  const retry = teamRecord('other/platform', { takenSlugs: ['team-platfor', other.slug] });
  assert.equal(retry.slug, `team-pl-${hex4(other.id + '\0' + 1)}`); // a retry hashes the set id, never the source
  const home = 'a-very-long-organisation/and-an-even-longer-repository';
  const r = teamRecord(home, { takenSlugs: [] });
  assert.equal(r.id, `team-${'a-very-long-organisati'}-${hex4(home)}`);
  assert.ok(r.id.length <= 32);
  assert.equal(r.name, `Team · ${home}`.slice(0, 40));
  const odd = teamRecord('Acme.Corp/Platform.API', { takenSlugs: [] });
  assert.match(odd.id, /^team-[a-z0-9-]+-[0-9a-f]{4}$/);
  assert.ok(odd.id.length <= 32);
  assert.equal(odd.slug, 'team-platfor');
  const bare = teamRecord('gitlab.example.com/_/_', { takenSlugs: ['team'] }); // the last segment normalizes to nothing
  assert.equal(bare.slug, `team-${hex4(bare.id)}`);
});

test('teamRecordsFor: two unpersisted homes ending /platform get distinct slugs, ascending; persisted homes are left out', () => {
  const recs = teamRecordsFor({}, ['z/platform', 'a/platform', 'a/platform'], []);
  assert.deepEqual(Object.keys(recs), ['a/platform', 'z/platform']);
  assert.equal(recs['a/platform'].slug, 'team-platfor');
  assert.deepEqual(recs['z/platform'], teamRecord('z/platform', { takenSlugs: ['team-platfor'] }));
  assert.deepEqual(Object.keys(teamRecordsFor({ 'a/platform': recs['a/platform'] }, ['a/platform'], ['team-platfor'])), []);
});

test('copy names (D15) and one §5.8 secret env name', () => {
  assert.equal(copyName('jira', null), 'jira');
  assert.equal(copyName('jira', undefined), 'jira'); // General's record has no slug key
  assert.equal(copyName('sentry', 'billing'), 'sentry_billing');
  assert.equal(secretEnvName('sentry_billing', 'token'), 'MCPSECRET_2EB4507A');
});
