// test/policy-mcp-local.test.mjs — mcpRequirements (MCP registry spec §11.3) and the effective table's
// "Yours" for mcp.required, computed from r.home in policyPayload and in `worca policy show`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useTempHome } from './helpers/temp-home.mjs';
import { projectKey } from '../src/core/store.mjs';
import { writeTeamPolicyPrefs } from '../src/core/config.mjs';
import { cachedPolicyHomes } from '../src/core/policy/cache.mjs';
import { resolveProjectPolicy } from '../src/core/policy/sync.mjs';
import { policyPayload } from '../src/core/policy/scope.mjs';
import { mcpRequirements, withMcpLocal } from '../src/core/policy/local.mjs';
import { entryHash, teamAction } from '../src/core/mcp/team.mjs';
import { putMember } from '../src/core/mcp/store.mjs';
import { loadCatalog } from '../src/core/mcp/catalog.mjs';

const home = useTempHome(after);
const dir = mkdtempSync(join(tmpdir(), 'platform-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'worca-cc.mjs');
const HOME = 'acme/platform';
const GH = `policy:${HOME}/github`;
// `node --version`: the background Test after Install runs it and records a failure — no network, no npx.
const GITHUB = { name: 'github', type: 'stdio', command: 'node', args: ['--version'],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: { field: 'token' } }, fields: [{ key: 'token', label: 'Token', secret: true, required: true }] };
const DOC = { schema: 1, fields: {
  'plugins.required': { kind: 'soft', value: [{ name: 'acme-tools' }] },
  'mcp.required': { kind: 'soft', value: [GITHUB, { plugin: 'acme-tools', server: 'sentry' }, { name: 'linear', type: 'http', url: 'https://mcp.linear.app/mcp', fields: [] }] },
}, workspaceRuns: {}, catalogs: { guardrailSets: [], models: [] } };

before(async () => {
  writeTeamPolicyPrefs(projectKey(dir), { present: true, hasOrigin: true, docKnown: true, slug: HOME, headSha: '8c1d2e0', delegateTo: null, checkedAt: new Date().toISOString(), doc: DOC });
  const cached = cachedPolicyHomes()[0];
  const { setId } = await teamAction('install', HOME, GH, { expectHash: entryHash(cached.doc.fields['mcp.required'].value[0]) });
  const def = (await loadCatalog()).find((c) => c.id === GH).def;
  await putMember(setId, GH, { secrets: { token: 'ghp_abcdefghijklmnopqrstuvwxyz0123' } }, { team: { home: HOME }, def });
});

test('mcpRequirements: one row per entry of every home, with its state here; none without entries', async () => {
  const rows = await mcpRequirements(cachedPolicyHomes());
  assert.deepEqual(rows.map((r) => [r.home, r.name, r.state, r.working]), [
    [HOME, 'github', 'ok', true], [HOME, 'sentry', 'needs-plugin', false], [HOME, 'linear', 'not-installed', false]]);
  assert.equal(rows[0].sha, '8c1d2e0');
  assert.deepEqual(await mcpRequirements([{ slug: 'x/y', doc: { fields: {} } }]), []);
  assert.deepEqual(await withMcpLocal({}, { slug: 'x/y', sha: null, doc: { fields: {} } }), {}, 'a home without entries adds no "Yours"');
  // A fault inside the registry pipeline (here: an entry no normalizer produced) is logged and yields no rows, never an error.
  assert.deepEqual(await mcpRequirements([{ slug: 'x/y', sha: null, doc: { fields: { 'mcp.required': { kind: 'soft', value: [null] } } } }]), []);
});

test('effective table: "Yours" = the Team set\'s working members, from r.home; the effective note counts the rest', async () => {
  const r = await resolveProjectPolicy(dir, { discover: false });
  const p = await policyPayload({ kind: 'project', id: projectKey(dir), name: 'platform', path: dir }, r, { workspaceRun: false, projectDir: dir });
  assert.deepEqual(p.local['mcp.required'].value.map((e) => e.name), ['github']);
  const row = p.rows.find((x) => x.key === 'mcp.required');
  assert.equal(row.local.display, 'github (stdio: node --version)');
  assert.equal(row.note, '2 missing');
  const { effectiveRows } = await import('../src/core/policy/effective.mjs');
  const all = r.doc.fields['mcp.required'].value;
  const noteOf = (local) => effectiveRows({ doc: r.doc, workspaceRun: false, local }).find((x) => x.key === 'mcp.required').note;
  assert.equal(noteOf({ 'mcp.required': { value: all, set: true } }), null, 'nothing missing: no note');
  assert.equal(noteOf({}), null, 'no "Yours" (a registry fault, the workspace summary): no note, no throw');
});

test('worca policy show prints the same "yours" and note', async () => {
  const out = await new Promise((res) => {
    const child = spawn(process.execPath, [CLI, 'policy', 'show', '--project', dir], { env: { ...process.env, WORCA_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let s = ''; child.stdout.on('data', (d) => { s += d; }); child.on('exit', () => res(s));
  });
  assert.match(out, /Required MCP servers\s+team github \(stdio: node --version\), sentry \(acme-tools\), linear \(http: https:\/\/mcp\.linear\.app\/mcp\) \(soft\) · yours github \(stdio: node --version\) → .* \[team\] — 2 missing/);
});
