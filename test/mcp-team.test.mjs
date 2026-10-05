// test/mcp-team.test.mjs — the Team set's pure core (MCP registry spec §11.2, §11.3):
// consent hash, seeded values, the checklist state of every mcp.required entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePolicyDoc } from '../src/core/policy/registry.mjs';
import { sha256Hex } from '../src/core/mcp/definitions.mjs';
import { consentHash, entryHash, seedValues, teamRows } from '../src/core/mcp/team.mjs';
import { hostContext } from '../src/core/mcp/registry.mjs';

const HOME = 'acme/platform';
const GITHUB = { name: 'github', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_HOST: { field: 'host' }, GITHUB_PERSONAL_ACCESS_TOKEN: { field: 'token' } },
  fields: [{ key: 'host', label: 'Host', required: true }, { key: 'token', label: 'Token', secret: true, required: true }],
  values: { host: 'github.acme.io' } };
const DATADOG = { name: 'datadog', type: 'http', url: 'https://mcp.datadoghq.com/mcp', fields: [] };
const LINEAR = { name: 'linear', type: 'http', url: 'https://mcp.linear.app/mcp', fields: [] };
const policy = (value) => normalizePolicyDoc({ schema: 1, fields: {
  'plugins.required': { kind: 'soft', value: [{ name: 'acme-tools' }, { name: 'acme-jira' }] },
  'mcp.required': { kind: 'soft', value } } }).doc;
const entries = (doc) => doc.fields['mcp.required'].value;

test('consent hash: sha256 of canonical { entry, values }; key order and default keys never change it', () => {
  assert.equal(consentHash({ server: 'sentry', plugin: 'acme-tools' }, { org: 'acme', env: 'prod' }),
    sha256Hex('{"entry":{"plugin":"acme-tools","server":"sentry"},"values":{"env":"prod","org":"acme"}}'));
  const a = entries(policy([GITHUB]))[0];
  const reordered = { values: { host: 'github.acme.io' }, fields: [{ required: true, label: 'Host', key: 'host', secret: false }, { key: 'token', required: true, secret: true, label: 'Token', oauth: false }],
    env: GITHUB.env, description: '', args: GITHUB.args, command: 'npx', type: 'stdio', name: 'github' };
  const b = entries(policy([reordered]))[0];
  assert.equal(entryHash(a), entryHash(b), 'an editor round trip that adds or drops default keys raises no Update');
  const bare = { name: 'x', type: 'http', url: 'https://x.example/mcp' };
  assert.equal(entryHash(entries(policy([{ ...bare, headers: {} }]))[0]), entryHash(entries(policy([bare]))[0]), 'an empty map or list is no change');
  assert.equal(entryHash(entries(policy([{ plugin: 'acme-tools', server: 'sentry', values: {} }]))[0]), consentHash({ plugin: 'acme-tools', server: 'sentry' }, {}));
  const changed = [
    { ...GITHUB, command: 'bunx' },                                // the definition
    { ...GITHUB, values: { host: 'github.other.io' } },           // the policy's values
  ];
  for (const e of changed) assert.notEqual(entryHash(entries(policy([e]))[0]), entryHash(a));
  assert.notEqual(entryHash({ plugin: 'acme-tools', server: 'sentry', values: { org: 'x' } }), entryHash({ plugin: 'acme-tools', server: 'sentry' }));
});

test('seeded values: absent or still the seed → follows the policy; changed by the user → kept', () => {
  const cases = [
    // [values, seeded, policy values] → [values, seeded]
    [{}, {}, { host: 'a' }, { host: 'a' }, { host: 'a' }],
    [{ host: 'a' }, { host: 'a' }, { host: 'b' }, { host: 'b' }, { host: 'b' }],
    [{ host: 'mine' }, { host: 'a' }, { host: 'b' }, { host: 'mine' }, { host: 'b' }],
    [{ host: 'mine' }, {}, { host: 'b' }, { host: 'mine' }, { host: 'b' }],
    [{ other: 'x' }, {}, {}, { other: 'x' }, {}],
  ];
  for (const [values, seeded, pv, wantValues, wantSeeded] of cases) {
    assert.deepEqual(seedValues({ values, seeded }, pv), { values: wantValues, seeded: wantSeeded }, JSON.stringify([values, seeded, pv]));
  }
});

// Appendix B's Team set: github (on, token not set), sentry (plugin, never consented), datadog (consented to an older
// definition), linear (not installed; the user's manual `linear` holds the base), jira (plugin missing), plus two more.
test('checklist states: one row per entry, the first state that applies', () => {
  const doc = policy([GITHUB, { plugin: 'acme-tools', server: 'sentry' }, DATADOG, LINEAR, { plugin: 'acme-jira', server: 'jira' },
    { name: 'off', type: 'http', url: 'https://off.example.com/mcp', fields: [] },
    { name: 'good', type: 'stdio', command: 'good', fields: [{ key: 'key', label: 'API key', secret: true, required: true }] },
    { plugin: 'acme-tools', server: 'logs' }]);
  const [gh, sentry, , , , off, good, logs] = entries(doc);
  const cat = (id, def, extra = {}) => ({ id, def, base: id.slice(id.lastIndexOf('/') + 1), provisional: false, pluginEnabled: true, ...extra });
  const oldDd = { ...entries(policy([{ ...DATADOG, url: 'https://old.datadoghq.com/mcp' }]))[0] };
  const catalog = [
    cat('manual:linear', { type: 'http', url: 'https://mine.example/mcp', fields: [], description: '' }, { base: 'linear' }),
    cat('plugin:acme-tools/logs', { type: 'http', url: 'https://logs.example/mcp', fields: [], description: '' }),
    cat('plugin:acme-tools/sentry', { type: 'http', url: 'https://mcp.sentry.dev/mcp', fields: [], description: '' }),
    cat(`policy:${HOME}/datadog`, { type: 'http', url: 'https://old.datadoghq.com/mcp', fields: [], description: '' }),
    cat(`policy:${HOME}/github`, { ...gh, name: undefined, values: undefined }),
    cat(`policy:${HOME}/good`, { ...good, name: undefined }),
    cat(`policy:${HOME}/off`, { ...off, name: undefined }),
  ];
  const on = (e) => ({ enabled: true, values: {}, seeded: {}, consent: entryHash(e) });
  const members = {
    [`policy:${HOME}/github`]: { ...on(gh), values: { host: 'github.acme.io' }, seeded: { host: 'github.acme.io' } },
    [`policy:${HOME}/datadog`]: { ...on(oldDd), seeded: { site: 'eu' } },
    [`policy:${HOME}/off`]: { ...on(off), enabled: false },
    [`policy:${HOME}/good`]: on(good),
    'plugin:acme-tools/logs': on(logs),
  };
  const snapshot = { sets: {}, tests: {}, bases: { 'manual:linear': 'linear' }, teams: { [HOME]: { id: 'team-acme-platform-9333', slug: 'team-platfor', name: 'Team · acme/platform', members } },
    secrets: { 'team-acme-platform-9333': { [`policy:${HOME}/good`]: { key: { value: { $env: 'MCP_GOOD_KEY' }, updatedAt: 'x' } } } } };
  const rows = teamRows({ slug: HOME, sha: '8c1d2e0', doc }, { ...hostContext(), catalog, snapshot, pluginStates: { 'acme-tools': 'ok', 'acme-jira': 'missing' }, env: { MCP_GOOD_KEY: 'k' } });
  assert.deepEqual(rows.map((r) => [r.name, r.state, r.working]), [
    ['github', 'skipped', false], ['sentry', 'never-consented', false], ['datadog', 'changed', true], ['linear', 'not-installed', false],
    ['jira', 'needs-plugin', false], ['off', 'off', false], ['good', 'ok', true], ['logs', 'ok', true]]);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.deepEqual([byName.github.field, byName.github.problem], ['Token', 'Token not set']);
  assert.equal(byName.linear.base, 'platform-linear', 'the consent modal notes the name it will run under');
  assert.equal(byName.linear.serverId, `policy:${HOME}/linear`);
  assert.deepEqual(byName.datadog.before, { def: catalog[3].def, values: { site: 'eu' } });
  assert.deepEqual(byName.datadog.running, { name: 'datadog', ...catalog[3].def }, '"Yours" shows the consented copy');
  assert.deepEqual(byName.logs.running, { plugin: 'acme-tools', server: 'logs' });
  assert.deepEqual([byName.sentry.setId, byName.sentry.setName, byName.sentry.hash], ['team-acme-platform-9333', 'Team · acme/platform', entryHash(sentry)]);
  // A disabled plugin keeps its member (state kept) but the row points at the plugin; an unset $env secret is missing.
  const again = teamRows({ slug: HOME, sha: null, doc }, { ...hostContext(), catalog, snapshot, pluginStates: { 'acme-tools': 'disabled', 'acme-jira': 'missing' }, env: {} });
  assert.deepEqual(again.filter((r) => ['logs', 'good'].includes(r.name)).map((r) => [r.name, r.state]), [['good', 'skipped'], ['logs', 'needs-plugin']]);
});

test('a consented member the resolver skips for any §5.7 problem is not working: the row says why', () => {
  const doc = policy([{ name: 'dd', type: 'http', url: [{ field: 'site' }], fields: [{ key: 'site', label: 'Site', required: true }], values: { site: 'http://evil.example/mcp' } }]);
  const [dd] = entries(doc);
  const { name, values, ...def } = dd;   // eslint-disable-line no-unused-vars
  const catalog = [{ id: `policy:${HOME}/dd`, source: 'policy', home: HOME, name: 'dd', def, base: 'dd', provisional: false, pluginEnabled: true }];
  const snapshot = { sets: {}, tests: {}, secrets: {}, bases: {}, teams: { [HOME]: { id: 'team-acme-platform-9333', slug: 'team-platfor', name: 'Team · acme/platform',
    members: { [`policy:${HOME}/dd`]: { enabled: true, values: { ...values }, seeded: { ...values }, consent: entryHash(dd) } } } } };
  const [row] = teamRows({ slug: HOME, sha: null, doc }, { catalog, snapshot, pluginStates: {}, env: {} });
  assert.deepEqual([row.state, row.working], ['skipped', false]);
  assert.match(row.problem, /not https/);
});
