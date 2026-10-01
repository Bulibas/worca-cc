// test/plugin-mcp-update.test.mjs — a plugin update against the MCP store (MCP registry
// spec §4.6 "Plugin updated" + "Field migration"): the preview's delta and red lines,
// honoured-only counting, and what applying does. Real local git repo, offline.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { useTempHome } from './helpers/temp-home.mjs';
import { JIRA, SENTRY, writeMcpPlugin } from './helpers/mcp-plugin-fixture.mjs';
import { put, file } from './helpers/mcp-store-fixtures.mjs';
import { fetchCandidate } from '../src/core/plugin-repo.mjs';
import { updatePlugin } from '../src/core/plugin-store.mjs';
import { readPluginsLock, pluginCurrentDir } from '../src/core/plugins-lock.mjs';
import { readMcpStore } from '../src/core/mcp/store.mjs';
import { mcpServerDelta } from '../src/core/mcp/plugin-lifecycle.mjs';
import { validateMcpDefinition } from '../src/core/mcp/definitions.mjs';
import { renderUpdatePreview } from '../ui/public/plugins-view.mjs';

useTempHome(after);
const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), 'worca-cc-mcp-upd-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const repo = join(scratch, 'repo');
const git = (...a) => run('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a]);
async function commit(opts) {
  writeMcpPlugin(repo, { name: 'acme-tools', ...opts });
  await git('add', '-A');
  await git('commit', '-qm', 'c');
}
const CLI = fileURLToPath(new URL('../src/cli/worca-cc.mjs', import.meta.url));
const cli = async (...a) => (await run(process.execPath, [CLI, 'plugin', ...a], { cwd: scratch, env: { ...process.env, WORCA_MOCK: '1' } })).stdout;

const field = (key, over = {}) => ({ key, label: key[0].toUpperCase() + key.slice(1), ...over });
// Pinned jira: an optional `project` and an optional plain `email`.
const JIRA1 = { ...JIRA, fields: [...JIRA.fields, field('project'), field('email')] };
// Candidate jira: a new baseUrl default, `project` now required, `email` now secret.
const JIRA2 = {
  ...JIRA, env: { ...JIRA.env, JIRA_EMAIL: { field: 'email' } },
  fields: [
    { ...JIRA.fields[0], default: 'https://acme2.atlassian.net' }, JIRA.fields[1],
    field('project', { required: true }), field('email', { secret: true }),
  ],
};
const LEGACY = { type: 'stdio', command: 'legacy-mcp', fields: [], description: '' };
const TEAM_ID = 'team-acme-platform-9333';
const member = (server, values = {}) => ({ server, enabled: true, values });
const secret = (key) => ({ [key]: { value: `${key}-value-123`, updatedAt: '2026-09-29T00:00:00Z' } });
const ID = (n) => `plugin:acme-tools/${n}`;

test('update preview: honoured delta, red lines naming sets, and applying it', async () => {
  await run('git', ['init', '-q', '-b', 'main', repo]);
  await commit({ mcpServers: { jira: JIRA1, sentry: SENTRY, legacy: LEGACY } });
  const [consent, receipt] = (await cli('install', 'acme-tools', '--repo', repo, '--yes')).split('\ninstalled:\n');
  const jiraLine = /^ {2}MCP server: jira \(stdio\) — node <plugin-dir>\/mcp\/jira\.mjs$/m;
  assert.match(consent, jiraLine, 'the CLI install consent lists MCP servers before it asks');
  assert.match(receipt, jiraLine, 'the CLI receipt lists them too');
  put('sets', {
    sets: {
      general: { name: 'General', members: [member(ID('jira')), member(ID('legacy'))] },
      billing: { name: 'Billing', slug: 'billing', members: [member(ID('jira'), { baseUrl: 'https://b.example', project: 'BIL', email: 'a@b.example' })] },
      shop: { name: 'Shop', slug: 'shop', members: [member(ID('jira'), { baseUrl: 'https://s.example' })] },
    },
    teams: { 'acme/platform': { id: TEAM_ID, slug: 'team-platfor', name: 'Team · acme/platform',
      members: { [ID('jira')]: { enabled: true, values: {}, seeded: {}, consent: 'h' } } } },
  });
  put('secrets', { sets: { billing: { [ID('jira')]: secret('token') }, [TEAM_ID]: { [ID('jira')]: secret('token') } } });

  await commit({ mcpServers: { jira: JIRA2, sentry: { ...SENTRY, description: 'reworded' }, linear: LEGACY } });
  const { manifestDelta: d } = await fetchCandidate('acme-tools');
  assert.deepEqual([d.newMcpServers, d.removedMcpServers, d.changedMcpServers], [['linear'], ['legacy'], ['jira']],
    'a description change is not a red line');
  assert.deepEqual(d.mcpLines, [
    { red: false, text: 'new MCP server: linear' },
    { red: true, text: 'MCP SERVER REMOVED: legacy — leaves General with its values, secrets and test results' },
    { red: true, text: 'MCP SERVER CHANGED: jira — secrets held in Billing, Team · acme/platform — follows the new default in General, Team · acme/platform' },
    { red: true, text: 'jira: new required field Project — skipped in General, Shop, Team · acme/platform until filled' },
  ]);

  const doc = new JSDOM('<!doctype html><body></body>').window.document;
  const el = renderUpdatePreview({ preview: await fetchCandidate('acme-tools') }, { doc });   // the route's body
  const reds = [...el.querySelectorAll('.pl-delta-secret')].map((n) => n.textContent);
  assert.equal(reds.length, 3);
  assert.ok(reds[1].startsWith('MCP SERVER CHANGED: jira'));
  assert.deepEqual([...el.querySelectorAll('.pl-delta')].map((n) => n.textContent), ['new MCP server: linear']);
  assert.ok(el.querySelector('.pl-confirm-update'), 'the route body renders its Apply button');

  const upd = await cli('update', 'acme-tools', '--yes');
  assert.ok(d.mcpLines.every((l) => upd.includes(`\n  ${l.text}\n`)), `the CLI update consent prints the MCP lines:\n${upd}`);
  const s = await readMcpStore();
  assert.deepEqual(s.sets.general.members.map((m) => m.server), [ID('jira')], 'a dropped server leaves every set');
  assert.deepEqual({ ...s.sets.billing.members[0].values }, { baseUrl: 'https://b.example', project: 'BIL' },
    'field migration: a value whose secret flag flipped is dropped');
  assert.equal(s.secrets.billing[ID('jira')].token.value, 'token-value-123', 'a secret with an unchanged flag is kept');
  assert.equal(s.bases[ID('linear')], 'linear', 'a new server is named on apply');

  await commit({ range: '>=4 <5', mcpServers: { jira: JIRA2, sentry: SENTRY, linear: LEGACY } });
  const drop = (await fetchCandidate('acme-tools')).manifestDelta;
  assert.deepEqual([drop.newMcpServers, drop.removedMcpServers, drop.changedMcpServers], [[], ['jira', 'linear', 'sentry'], []],
    'a candidate below API 5 honours nothing, so every server reads as removed');
});

test('red lines: type, url, headers, command, args, env, the field set and a field\'s default, secret or required — never a label, description, oauth flag, key order or an empty list', () => {
  // Every row is a definition the host accepts, normalized as normalizeManifest hands it over:
  // the validator leaves an absent args/env/headers absent.
  const norm = (raw) => {
    const r = validateMcpDefinition(raw, { name: 's', source: 'plugin' });
    assert.deepEqual(r.errors, [], JSON.stringify(raw));
    return r.def;
  };
  const changed = (pin, cand) => mcpServerDelta({ s: norm(pin) }, { s: norm(cand) }).changedMcpServers;
  const [url, token] = JIRA.fields;
  const MAIL = { ...JIRA, env: { ...JIRA.env, JIRA_EMAIL: { field: 'email' } }, fields: [...JIRA.fields, field('email')] };
  const HTTP = { type: 'http', url: 'https://mcp.example.dev/mcp', fields: [], description: '' };
  const red = [
    [SENTRY, { ...SENTRY, type: 'sse' }], [SENTRY, { ...SENTRY, url: 'https://other.example/mcp' }],
    [SENTRY, { ...SENTRY, headers: { ...SENTRY.headers, 'X-Extra': 'x' } }],
    [JIRA, { ...JIRA, command: 'bun' }], [JIRA, { ...JIRA, args: ['./mcp/other.mjs'] }],
    [JIRA, { ...JIRA, env: { ...JIRA.env, JIRA_URL: { field: 'baseUrl', prefix: 'x' } } }],
    [JIRA, { ...JIRA, fields: [{ ...url, default: 'https://other.example' }, token] }],
    [MAIL, { ...MAIL, fields: [...JIRA.fields, field('email', { secret: true })] }],
    [JIRA, { ...JIRA, fields: [{ ...url, required: false }, token] }],
    [JIRA, { ...JIRA, fields: [...JIRA.fields, field('project')] }],   // a field added: every set has one more to fill in
  ];
  for (const [pin, cand] of red) assert.deepEqual(changed(pin, cand), ['s'], JSON.stringify(cand));
  const quiet = [
    [JIRA, { ...JIRA, description: 'reworded', env: { JIRA_TOKEN: JIRA.env.JIRA_TOKEN, JIRA_URL: JIRA.env.JIRA_URL },
      fields: [token, { ...url, label: 'Base URL' }] }],
    [LEGACY, { ...LEGACY, args: [], env: {} }],
    [HTTP, { ...HTTP, headers: {} }],
    [SENTRY, { ...SENTRY, headers: { 'X-Sentry-Org': SENTRY.headers['X-Sentry-Org'], Authorization: SENTRY.headers.Authorization },
      fields: [{ ...SENTRY.fields[0], oauth: false }, SENTRY.fields[1]] }],
  ];
  for (const [pin, cand] of quiet) assert.deepEqual(changed(pin, cand), [], JSON.stringify(cand));
});

test('a damaged MCP registry file refuses an update that removes or migrates servers, before anything changes', async () => {
  // The first test left a candidate below API 5 committed: applying it removes every server.
  const pinned = readPluginsLock()['acme-tools'].pinnedSha;
  const current = readlinkSync(pluginCurrentDir('acme-tools'));
  const damaged = `${readFileSync(file('sets'), 'utf8').trimEnd().slice(0, -1)}, }`;   // a trailing comma
  writeFileSync(file('sets'), damaged);
  await assert.rejects(() => updatePlugin('acme-tools'), /mcp\/sets\.json is damaged/);
  assert.equal(readPluginsLock()['acme-tools'].pinnedSha, pinned, 'still on the pinned version');
  assert.equal(readlinkSync(pluginCurrentDir('acme-tools')), current, 'current still points at it');
  assert.equal(readFileSync(file('sets'), 'utf8'), damaged, 'the damaged file is left for the user to fix');
});
