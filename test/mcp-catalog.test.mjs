// test/mcp-catalog.test.mjs — the MCP catalog and base reconciliation (MCP registry spec
// §4.1 plugin paths, §4.4 bases + provisional names, §4.6 disabled plugins).
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useTempHome } from './helpers/temp-home.mjs';
import { JIRA, SENTRY, writeMcpPlugin } from './helpers/mcp-plugin-fixture.mjs';
import { put } from './helpers/mcp-store-fixtures.mjs';
import { linkPlugin, setPluginEnabled, uninstallPlugin } from '../src/core/plugin-store.mjs';
import { pluginDir, readPluginsLock, writePluginsLock } from '../src/core/plugins-lock.mjs';
import { worcaHome } from '../src/core/projects.mjs';
import { readMcpStore } from '../src/core/mcp/store.mjs';
import { loadCatalog, reconcileMcpStore } from '../src/core/mcp/catalog.mjs';

const home = useTempHome(after);
const scratch = mkdtempSync(join(tmpdir(), 'worca-cc-mcp-cat-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const serversFile = () => join(worcaHome(), 'mcp', 'servers.json');
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'worca-cc.mjs');

let bootMaintenance;
before(async () => { ({ bootMaintenance } = await import('../ui/server.mjs')); });

async function reset() {
  for (const name of Object.keys(readPluginsLock())) await uninstallPlugin(name, { purge: true });
  rmSync(join(worcaHome(), 'mcp'), { recursive: true, force: true });
}

/** An installed (non-linked) plugin: lock entry + current -> versions/<sha7>. */
function installFixture(name, sha, opts = {}) {
  const vdir = join(pluginDir(name), 'versions', sha.slice(0, 7));
  writeMcpPlugin(vdir, { name, ...opts });
  symlinkSync(join('versions', sha.slice(0, 7)), join(pluginDir(name), 'current'));
  writePluginsLock({ ...readPluginsLock(), [name]: { repo: '/x', subdir: '', pinnedSha: sha, version: '1', enabled: true } });
  return vdir;
}

test('catalog: plugin (installed, linked, disabled), manual and policy entries, sorted, with dir and code', async () => {
  await reset();
  const sha = 'abcdef0123456789abcdef0123456789abcdef01';
  const vdir = installFixture('acme-tools', sha, { mcpServers: { sentry: SENTRY, jira: JIRA } });
  const wdir = writeMcpPlugin(join(scratch, 'dev'), { name: 'dev-tools' });
  await linkPlugin('dev-tools', wdir);
  setPluginEnabled('dev-tools', false);
  await linkPlugin('old-tools', writeMcpPlugin(join(scratch, 'old'), { name: 'old-tools', range: '>=4 <5' }));
  put('servers', {
    manual: { 'postgres-ro': { ...JIRA, command: '/usr/bin/pg', args: [] } },
    policy: { 'acme/platform/github': { def: SENTRY, hash: 'h', installedAt: '2026-09-29T00:00:00Z' } },
    bases: { 'plugin:acme-tools/jira': 'jira' },
  });
  const cat = await loadCatalog();
  assert.deepEqual(cat.map((e) => e.id), [
    'manual:postgres-ro', 'plugin:acme-tools/jira', 'plugin:acme-tools/sentry', 'plugin:dev-tools/jira', 'policy:acme/platform/github',
  ], 'an API-4 plugin contributes nothing');
  const byId = Object.fromEntries(cat.map((e) => [e.id, e]));
  assert.deepEqual({ ...byId['plugin:acme-tools/jira'], def: undefined }, {
    id: 'plugin:acme-tools/jira', source: 'plugin', plugin: 'acme-tools', name: 'jira', def: undefined,
    dir: realpathSync(vdir), code: 'abcdef0', pluginEnabled: true, base: 'jira', provisional: false,
  });
  assert.equal(byId['plugin:acme-tools/jira'].def.args[0], './mcp/jira.mjs');
  assert.equal(byId['plugin:dev-tools/jira'].dir, realpathSync(wdir), 'linked: the working dir');
  assert.equal(byId['plugin:dev-tools/jira'].code, 'linked');
  assert.equal(byId['plugin:dev-tools/jira'].pluginEnabled, false, 'disabled plugins stay in the catalog');
  assert.equal(byId['plugin:dev-tools/jira'].provisional, true);
  assert.equal(byId['plugin:dev-tools/jira'].base, 'dev-tools-jira', 'provisional names never take a persisted base');
  assert.deepEqual([byId['manual:postgres-ro'].source, byId['manual:postgres-ro'].dir, byId['manual:postgres-ro'].code], ['manual', null, null]);
  assert.deepEqual([byId['policy:acme/platform/github'].home, byId['policy:acme/platform/github'].name], ['acme/platform', 'github']);
  assert.equal(existsSync(serversFile()) && JSON.parse(readFileSync(serversFile(), 'utf8')).bases['plugin:dev-tools/jira'], undefined,
    'a read never writes');
});

test('a linked plugin whose working dir is gone serves nothing and breaks nothing', async () => {
  await reset();
  const dir = writeMcpPlugin(join(scratch, 'gone'), { name: 'gone-tools' });
  await linkPlugin('gone-tools', dir);
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual((await loadCatalog()).map((e) => e.id), []);
});

test('hand-edited manual and policy definitions are re-checked on read: invalid ones are left out, valid ones normalized', async () => {
  await reset();
  put('servers', {
    manual: { nofields: { type: 'stdio', command: 'srv' }, dollar: { type: 'stdio', command: '${HOME}/bin/srv' } },
    policy: { 'acme/platform/gone': null, nohome: { def: SENTRY, hash: 'h', installedAt: '2026-09-29T00:00:00Z' } },
  });
  const cat = await loadCatalog();
  assert.deepEqual(cat.map((e) => e.id), ['manual:nofields'], 'what fails §4.1 never reaches the resolver');
  assert.deepEqual(cat[0].def.fields, [], 'normalized: fields default to []');
});

test('reconcile persists missing bases only; an API bump and a linked edit get one and keep it', async () => {
  await reset();
  installFixture('inst-tools', 'fedcba9876543210fedcba9876543210fedcba98', { range: '>=4', mcpServers: { wiki: JIRA } });   // installed on an API-4 host
  const dir = writeMcpPlugin(join(scratch, 'bump'), { name: 'bump-tools', range: '>=4' });   // ">=4" now negotiates 5
  await linkPlugin('bump-tools', dir);
  rmSync(join(worcaHome(), 'mcp'), { recursive: true, force: true });   // as if it arrived on an API-4 host
  await reconcileMcpStore();
  assert.deepEqual({ ...(await readMcpStore()).bases }, { 'plugin:bump-tools/jira': 'jira', 'plugin:inst-tools/wiki': 'wiki' });
  writeMcpPlugin(dir, { name: 'bump-tools', range: '>=4', mcpServers: { jira: JIRA, sentry: SENTRY } });   // the author edits
  await reconcileMcpStore();
  assert.deepEqual({ ...(await readMcpStore()).bases },
    { 'plugin:bump-tools/jira': 'jira', 'plugin:bump-tools/sentry': 'sentry', 'plugin:inst-tools/wiki': 'wiki' });
  writeMcpPlugin(dir, { name: 'bump-tools', range: '>=4', mcpServers: { sentry: SENTRY } });   // a server leaves
  await reconcileMcpStore();
  assert.equal((await readMcpStore()).bases['plugin:bump-tools/jira'], 'jira', 'a base is never reassigned');
});

test('reconcile writes nothing when every id has a base, and nothing under a newer store', async () => {
  await reset();
  await reconcileMcpStore();
  assert.equal(existsSync(serversFile()), false, 'empty catalog: no write');
  await linkPlugin('acme-tools', writeMcpPlugin(join(scratch, 'n'), { name: 'acme-tools' }));
  mkdirSync(dirname(serversFile()), { recursive: true });
  writeFileSync(serversFile(), JSON.stringify({ schema: 2, bases: {} }));
  await reconcileMcpStore();
  assert.equal(JSON.parse(readFileSync(serversFile(), 'utf8')).schema, 2, 'a newer file is never written');
});

test('boot maintenance reconciles the MCP store', async () => {
  await reset();
  const dir = writeMcpPlugin(join(scratch, 'boot'), { name: 'acme-tools' });
  await linkPlugin('acme-tools', dir);
  writeMcpPlugin(dir, { name: 'acme-tools', mcpServers: { jira: JIRA, sentry: SENTRY } });   // edited after the link
  await bootMaintenance();
  assert.equal((await readMcpStore()).bases['plugin:acme-tools/sentry'], 'sentry');
});

/** `worca plugin <args>` in a child process on this test's home. */
const cliRun = (...args) => new Promise((res) => {
  const c = spawn(process.execPath, [CLI, 'plugin', ...args], { env: { ...process.env, WORCA_HOME: home, WORCA_MOCK: '1' }, cwd: scratch });
  let stdout = '';
  let stderr = '';
  c.stdout.on('data', (d) => { stdout += d; });
  c.stderr.on('data', (d) => { stderr += d; });
  c.on('close', (code) => res({ code, stdout, stderr }));
});

test('every `worca plugin` command reconciles first; `plugin list` counts MCP servers', async () => {
  await reset();
  const dir = writeMcpPlugin(join(scratch, 'cli'), { name: 'acme-tools' });
  await linkPlugin('acme-tools', dir);
  writeMcpPlugin(dir, { name: 'acme-tools', mcpServers: { jira: JIRA, sentry: SENTRY } });   // edited after the link
  const r = await cliRun('list');
  assert.equal(r.code, 0, r.stderr);
  assert.equal((await readMcpStore()).bases['plugin:acme-tools/sentry'], 'sentry');
  assert.match(r.stdout, /^acme-tools\tlinked\tenabled, linked\t2 MCP servers$/m);
});

test('a reconcile that cannot write never fails a `worca plugin` command or the server start', async () => {
  await reset();
  const dir = writeMcpPlugin(join(scratch, 'dmg'), { name: 'acme-tools' });
  await linkPlugin('acme-tools', dir);
  writeMcpPlugin(dir, { name: 'acme-tools', mcpServers: { jira: JIRA, sentry: SENTRY } });   // sentry still lacks a base
  mkdirSync(dirname(serversFile()), { recursive: true });
  writeFileSync(join(dirname(serversFile()), 'secrets.json'), '{"schema":1,"sets":{},}');   // damaged: every locked write refuses
  const r = await cliRun('list');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /warning: MCP registry reconcile skipped: MCP registry file mcp\/secrets\.json is damaged/);
  await bootMaintenance();   // logs the failure and carries on
  assert.equal((await readMcpStore()).bases['plugin:acme-tools/sentry'], undefined, 'nothing was written');
});
