// test/plugin-mcp-manifest.test.mjs — the manifest `mcpServers` block and the API-5 gate
// (MCP registry spec §4.1). Module reads + fs fixtures; the connector row reads a temp home's
// plugin lock. No MCP store.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { useTempHome } from './helpers/temp-home.mjs';
import {
  normalizeManifest, validatePluginDir, MCP_NEEDS_API_5, mcpBlockIgnored,
} from '../src/core/plugin-manifest.mjs';
import { writePluginsLock, pluginCurrentDir } from '../src/core/plugins-lock.mjs';
import { discoverChannels } from '../src/core/chat/channel-host.mjs';

useTempHome(after);

const scratch = mkdtempSync(join(tmpdir(), 'worca-cc-mcp-manifest-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
function mkPluginDir(files) {
  const root = join(scratch, `p${n++}`);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const JIRA = {
  type: 'stdio', command: 'node', args: ['./mcp/jira.mjs'],
  env: { JIRA_URL: { field: 'baseUrl' }, JIRA_TOKEN: { field: 'token' } },
  fields: [
    { key: 'baseUrl', label: 'Jira URL', required: true, default: 'https://acme.atlassian.net' },
    { key: 'token', label: 'API token', secret: true, required: true },
  ],
  description: 'Search and read Jira issues',
};
const manifest = (range, mcpServers) => ({
  name: 'acme-tools', ...(range === null ? {} : { engines: { 'worca-cc-api': range } }), mcpServers,
});
const errs = (v) => v.problems.filter((p) => p.level === 'error').map((p) => p.message);
const warns = (v) => v.problems.filter((p) => p.level === 'warn').map((p) => p.message);

test('connectors are handed apiVersion 5 unless their range pins an older API', () => {
  const lock = {};
  for (const [name, range] of [['open-chat', null], ['pinned-chat', '>=4 <5']]) {
    const cur = pluginCurrentDir(name);
    mkdirSync(join(cur, 'channel'), { recursive: true });
    writeFileSync(join(cur, 'channel', 'worker.mjs'), 'export function createChannelWorker() { return {}; }\n');
    writeFileSync(join(cur, 'worca-cc-plugin.json'), JSON.stringify({
      name, ...(range === null ? {} : { engines: { 'worca-cc-api': range } }),
      chatChannels: [{ id: 'main', displayName: 'Chat', platform: 'testchat', module: './channel/worker.mjs', configSchema: [] }],
    }));
    lock[name] = { repoUrl: 'https://example.test/chat.git', subdir: '', pinnedSha: 'f'.repeat(40), version: null, enabled: true };
  }
  writePluginsLock(lock);
  assert.deepEqual(Object.fromEntries(discoverChannels().map((c) => [c.plugin, c.apiVersion])), { 'open-chat': 5, 'pinned-chat': 4 });
});

test('mcpServers is honoured only when the plugin negotiates API 5', () => {
  for (const range of ['>=5 <6', '>=4', null]) {
    const r = normalizeManifest(manifest(range, { jira: JIRA }));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(Object.keys(r.manifest.mcpServers), ['jira'], `range ${range}`);
    assert.equal(r.manifest.mcpServers.jira.command, 'node');
    assert.deepEqual(r.manifest.mcpServers.jira.args, ['./mcp/jira.mjs'], './ paths stay relative in the def');
    assert.equal(Object.getPrototypeOf(r.manifest.mcpServers), null, 'null-prototype map');
    assert.deepEqual(r.warnings, [], 'mcpServers is a known top-level key');
  }
  for (const range of ['>=4 <5', '>=3 <4']) {
    const r = normalizeManifest(manifest(range, { jira: JIRA, 'Bad Name': { type: 'nope' } }));
    assert.equal(r.ok, true, 'an ignored block is never validated, so it can never break the plugin');
    assert.deepEqual(Object.keys(r.manifest.mcpServers), [], `range ${range}: stripped at load`);
  }
  assert.deepEqual(Object.keys(normalizeManifest({ name: 'p' }).manifest.mcpServers), []);
});

test('an honoured block goes through the registry validator; every error names the server', () => {
  const r = normalizeManifest(manifest('>=5 <6', { jira: JIRA, worca: JIRA, ok2: { ...JIRA, type: 'ftp' } }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /: mcpServers\.worca: /.test(e)), r.errors.join('\n'));
  assert.ok(r.errors.some((e) => /: mcpServers\.ok2: /.test(e)), r.errors.join('\n'));
  assert.ok(!r.errors.some((e) => /mcpServers\.jira/.test(e)));
  const arr = normalizeManifest(manifest('>=5 <6', [JIRA]));
  assert.equal(arr.ok, false);
  assert.match(arr.errors.join('\n'), /"mcpServers" must be an object/);
});

test('MCP_NEEDS_API_5 is one sentence naming the range; validate warns with it below 5', () => {
  assert.match(MCP_NEEDS_API_5, /plugin API 5/);
  assert.match(MCP_NEEDS_API_5, />=5 <6/);
  assert.doesNotMatch(MCP_NEEDS_API_5, /worca-cc /);
  const files = { 'mcp/jira.mjs': '// server\n' };
  const old = mkPluginDir({ ...files, 'worca-cc-plugin.json': JSON.stringify(manifest('>=4 <5', { jira: JIRA })) });
  const v = validatePluginDir(old);
  assert.equal(v.ok, true);
  assert.ok(warns(v).includes(`worca-cc-plugin.json: ${MCP_NEEDS_API_5}`), JSON.stringify(v.problems));
  const cur = mkPluginDir({ ...files, 'worca-cc-plugin.json': JSON.stringify(manifest('>=5 <6', { jira: JIRA })) });
  const v5 = validatePluginDir(cur, { strict: true });
  assert.deepEqual(v5.problems, [], 'a clean API-5 plugin validates strict');
  assert.equal(mcpBlockIgnored(manifest('>=4 <5', { jira: JIRA })), true);
  assert.equal(mcpBlockIgnored(manifest('>=4 <5', {})), false, 'an empty block ignores nothing');
  assert.equal(mcpBlockIgnored(manifest('>=5 <6', { jira: JIRA })), false);
  assert.equal(mcpBlockIgnored(null), false);
});

test('validate: ./ command and args must be contained files that exist', () => {
  const table = [
    [{ ...JIRA, args: ['./mcp/missing.mjs'] }, 'mcpServers "jira": ./mcp/missing.mjs not found'],
    [{ ...JIRA, args: ['./mcp/../../etc/x'] }, 'mcpServers "jira": ./mcp/../../etc/x must not contain ".."'],
    [{ ...JIRA, command: './bin/nope', args: [] }, 'mcpServers "jira": ./bin/nope not found'],
    [{ ...JIRA, command: './mcp', args: [] }, 'mcpServers "jira": ./mcp is not a file'],
  ];
  for (const [def, want] of table) {
    const dir = mkPluginDir({ 'mcp/jira.mjs': '//\n', 'worca-cc-plugin.json': JSON.stringify(manifest('>=5 <6', { jira: def })) });
    assert.deepEqual(errs(validatePluginDir(dir)), [want]);
  }
  const ok = mkPluginDir({
    'mcp/jira.mjs': '//\n',
    'worca-cc-plugin.json': JSON.stringify(manifest('>=5 <6', { jira: { ...JIRA, command: 'uv', args: ['run', '--directory', './', 'x'] } })),
  });
  assert.deepEqual(errs(validatePluginDir(ok)), [], '"./" alone is the plugin dir itself');
});
