// test/bundled-mcp-plugins.test.mjs
// The MCP plugins in the builtin marketplace (worca-cc-marketplace.json): each validates strictly at
// API 5, consent shows exactly what runs, and each server materializes as docs/mcp-servers.md
// "Bundled servers" says — secrets only through env, a blank optional field leaves no flag behind.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useTempHome } from './helpers/temp-home.mjs';
import { normalizeManifest, validatePluginDir } from '../src/core/plugin-manifest.mjs';
import { buildInstallInventory } from '../src/core/plugin-store.mjs';
import { materializeCopy } from '../src/core/mcp/registry.mjs';
import { checkRows } from './helpers/rows.mjs';

useTempHome(after);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MARKET = JSON.parse(readFileSync(join(ROOT, 'worca-cc-marketplace.json'), 'utf8'));
const DOCS = readFileSync(join(ROOT, 'docs', 'mcp-servers.md'), 'utf8');
const CTX = { env: {}, platform: 'linux', execPath: '/usr/bin/node', worcaRoot: '/opt/worca' };
const WIN = { platform: 'win32', execPath: 'C:\\node\\node.exe', worcaRoot: 'C:\\worca' };
const sec = (value) => ({ value, updatedAt: '2026-09-30T00:00:00Z' });

/** The plugin's manifest, read the way the catalog reads it. */
function bundled(plugin) {
  const dir = join(ROOT, 'plugins', plugin);
  const r = normalizeManifest(JSON.parse(readFileSync(join(dir, 'worca-cc-plugin.json'), 'utf8')), { dir });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return { dir, manifest: r.manifest };
}
/** One General copy of a bundled server (copy name = server name), as the resolver builds it. */
function mat(plugin, name, { values = {}, secrets = {}, ctx = {} } = {}) {
  const { dir, manifest } = bundled(plugin);
  const entry = { id: `plugin:${plugin}/${name}`, source: 'plugin', plugin, name, dir, code: 'abc1234',
    pluginEnabled: true, base: name, provisional: false, def: manifest.mcpServers[name] };
  return materializeCopy({ entry, values, secrets, copy: name, name }, { ...CTX, ...ctx });
}
/** The server's own command line: the launcher argv after `--`. */
const childArgv = (server) => server.args.slice(server.args.indexOf('--') + 1);
/** The consent rows the Plugins view shows before install. */
const consent = (plugin) => buildInstallInventory(join(ROOT, 'plugins', plugin)).mcpServers;
/** Listed in the builtin marketplace, strict-valid at API 5 with exactly these servers, and in the docs table. */
function assertShipped(plugin, serverNames) {
  assert.ok(MARKET.plugins.includes(`plugins/${plugin}`), `${plugin} is listed in worca-cc-marketplace.json`);
  const { dir, manifest } = bundled(plugin);
  assert.equal(manifest.engines.worcaApi, '>=5 <6');
  assert.deepEqual(Object.keys(manifest.mcpServers).sort(), [...serverNames].sort());
  const v = validatePluginDir(dir, { strict: true });
  assert.equal(v.ok, true, JSON.stringify(v.problems));
  assert.match(DOCS, new RegExp(`^\\| \`${plugin}\` \\|`, 'm'), `docs/mcp-servers.md has a row for ${plugin}`);
}

test('every plugin the builtin marketplace lists validates strictly', () => {
  for (const rel of MARKET.plugins) {
    const v = validatePluginDir(join(ROOT, rel), { strict: true });
    assert.equal(v.ok, true, `${rel}: ${JSON.stringify(v.problems)}`);
  }
});

test('http MCP plugins (cloudflare, atlassian): no secret no copy; the token rides an env ref in the auth header', async () => {
  await checkRows([
    { name: 'cloudflare-mcp: the whole Cloudflare API behind a bearer API token, and the docs with no credentials', run: async () => {
      assertShipped('cloudflare-mcp', ['cloudflare', 'cloudflare-docs']);
      assert.deepEqual(consent('cloudflare-mcp'), [
        { name: 'cloudflare', type: 'http', url: 'https://mcp.cloudflare.com/mcp' },
        { name: 'cloudflare-docs', type: 'http', url: 'https://docs.mcp.cloudflare.com/mcp' },
      ]);
      assert.deepEqual(mat('cloudflare-mcp', 'cloudflare'), { reason: 'missing:token' }, 'no token, no copy');
      const r = mat('cloudflare-mcp', 'cloudflare', { secrets: { token: sec('cf-api-token-0123456789') } });
      const [ref] = Object.keys(r.env);
      assert.deepEqual(r.server, { type: 'http', url: 'https://mcp.cloudflare.com/mcp', headers: { Authorization: `Bearer \${${ref}}` } });
      assert.deepEqual(r.env, { [ref]: 'cf-api-token-0123456789' });
      assert.deepEqual(mat('cloudflare-mcp', 'cloudflare-docs').server, { type: 'http', url: 'https://docs.mcp.cloudflare.com/mcp' });
    } },
    { name: 'atlassian-mcp: the Rovo MCP server with Basic API-token credentials (base64 padding survives)', run: async () => {
      assertShipped('atlassian-mcp', ['atlassian']);
      assert.deepEqual(consent('atlassian-mcp'), [{ name: 'atlassian', type: 'http', url: 'https://mcp.atlassian.com/v2/mcp' }]);
      assert.deepEqual(mat('atlassian-mcp', 'atlassian'), { reason: 'missing:credentials' });
      const basic = Buffer.from('dev@example.com:ATATT3xFfGF0-token').toString('base64');
      assert.ok(basic.endsWith('='), 'the fixture exercises = padding');
      const r = mat('atlassian-mcp', 'atlassian', { secrets: { credentials: sec(basic) } });
      const [ref] = Object.keys(r.env);
      assert.deepEqual(r.server, { type: 'http', url: 'https://mcp.atlassian.com/v2/mcp', headers: { Authorization: `Basic \${${ref}}` } });
      assert.deepEqual(r.env, { [ref]: basic });
    } },
  ]);
});

test('firebase-mcp: firebase-tools over stdio; blank optional fields leave no flag behind', () => {
  assertShipped('firebase-mcp', ['firebase']);
  assert.deepEqual(consent('firebase-mcp'), [
    { name: 'firebase', type: 'stdio', command: 'npx -y firebase-tools@latest mcp --dir={dir} --only={only}' },
  ]);
  const bare = mat('firebase-mcp', 'firebase');
  assert.deepEqual(childArgv(bare.server), ['npx', '-y', 'firebase-tools@latest', 'mcp'], 'blank fields = firebase login, no flags');
  assert.equal(bare.server.env, undefined);
  assert.deepEqual(bare.env, {});
  const full = mat('firebase-mcp', 'firebase', { values: { dir: '/work/app', only: 'firestore,auth' },
    secrets: { serviceAccount: sec('/keys/app-sa.json') } });
  assert.deepEqual(childArgv(full.server), ['npx', '-y', 'firebase-tools@latest', 'mcp', '--dir=/work/app', '--only=firestore,auth']);
  const [ref] = Object.keys(full.env);
  assert.deepEqual(full.server.env, { MCPCHILD_GOOGLE_APPLICATION_CREDENTIALS: `\${${ref}}` });
  assert.deepEqual(full.env, { [ref]: '/keys/app-sa.json' });
  assert.ok(!full.server.args.includes('/keys/app-sa.json'), 'the key file path is a secret: env only, never argv');
});

test('firebase-mcp on Windows: npx runs through its .cmd shim; no npx on PATH skips the copy', () => {
  const shim = mat('firebase-mcp', 'firebase', { values: { only: 'firestore' },
    ctx: { ...WIN, resolveCommand: () => ({ kind: 'shim', path: 'C:\\Program Files\\nodejs\\npx.cmd' }) } });
  assert.ok(shim.server.args.includes('--win-shim'));
  assert.deepEqual(childArgv(shim.server), ['C:\\Program Files\\nodejs\\npx.cmd', '-y', 'firebase-tools@latest', 'mcp', '--only=firestore']);
  assert.deepEqual(mat('firebase-mcp', 'firebase', { ctx: { ...WIN, resolveCommand: () => null } }), { reason: 'command-not-found' });
});

test('stdio token MCP plugins (railway, notion): the token reaches the child only through env, never argv', async () => {
  await checkRows([
    { name: 'railway-mcp: the Railway CLI local server; blank token = railway login, a token only through env', run: async () => {
      assertShipped('railway-mcp', ['railway']);
      assert.deepEqual(consent('railway-mcp'), [{ name: 'railway', type: 'stdio', command: 'railway mcp local' }]);
      const login = mat('railway-mcp', 'railway');
      assert.deepEqual(childArgv(login.server), ['railway', 'mcp', 'local']);
      assert.equal(login.server.env, undefined);
      const tok = mat('railway-mcp', 'railway', { secrets: { token: sec('rw-account-token-0123') } });
      const [ref] = Object.keys(tok.env);
      assert.deepEqual(tok.server.env, { MCPCHILD_RAILWAY_API_TOKEN: `\${${ref}}` });
      assert.ok(!tok.server.args.includes('rw-account-token-0123'));
      assert.deepEqual(mat('railway-mcp', 'railway', { ctx: { ...WIN, resolveCommand: () => null } }), { reason: 'command-not-found' });
    } },
    { name: 'notion-mcp: the open-source Notion server over stdio with an integration secret', run: async () => {
      assertShipped('notion-mcp', ['notion']);
      assert.deepEqual(consent('notion-mcp'), [{ name: 'notion', type: 'stdio', command: 'npx -y @notionhq/notion-mcp-server' }]);
      assert.deepEqual(mat('notion-mcp', 'notion'), { reason: 'missing:token' });
      const r = mat('notion-mcp', 'notion', { secrets: { token: sec('ntn_0123456789abcdefghij') } });
      assert.deepEqual(childArgv(r.server), ['npx', '-y', '@notionhq/notion-mcp-server']);
      const [ref] = Object.keys(r.env);
      assert.deepEqual(r.server.env, { MCPCHILD_NOTION_TOKEN: `\${${ref}}` });
      assert.deepEqual(r.env, { [ref]: 'ntn_0123456789abcdefghij' });
    } },
  ]);
});
