// test/policy-mcp-required.test.mjs — the `mcp.required` policy field (MCP registry spec §11.1):
// registry row, per-entry normalizer, cross-field rule, workspaceRuns refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fieldMeta, FIELDS, normalizePolicyDoc, normalizeEntry, validateValue } from '../src/core/policy/registry.mjs';

const GITHUB = { name: 'github', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_HOST: { field: 'host' }, GITHUB_PERSONAL_ACCESS_TOKEN: { field: 'token' } },
  fields: [{ key: 'host', label: 'Host', required: true }, { key: 'token', label: 'Token', secret: true, required: true }],
  values: { host: 'github.acme.io' } };
const SENTRY = { plugin: 'acme-tools', server: 'sentry', values: { org: 'acme' } };
const docWith = (value, extra = {}) => ({ schema: 1, fields: {
  'plugins.required': { kind: 'soft', value: [{ name: 'acme-tools' }] },
  'mcp.required': { kind: 'soft', value }, ...extra } });

test('mcp.required sits after plugins.required: soft only, Plugins group, never under workspaceRuns', () => {
  const keys = FIELDS.map((f) => f.key);
  assert.equal(keys[keys.indexOf('plugins.required') + 1], 'mcp.required');
  const m = fieldMeta('mcp.required');
  assert.deepEqual([m.group, m.label, m.type, m.kinds, m.workspaceRuns], ['plugins', 'Required MCP servers', 'mcpServers', ['soft'], false]);
  assert.equal(m.help, 'Each developer turns them on with consent; they join the Team set. Never automatic.');
});

test('valid entries normalise (defaults filled, empty values dropped) and survive a second pass unchanged', () => {
  const { doc, warnings } = normalizePolicyDoc(docWith([GITHUB, { ...SENTRY, values: {} }]));
  assert.deepEqual(warnings, []);
  const [gh, se] = doc.fields['mcp.required'].value;
  assert.deepEqual(se, { plugin: 'acme-tools', server: 'sentry' });
  assert.equal(gh.name, 'github');
  assert.deepEqual(gh.fields[1], { key: 'token', label: 'Token', secret: true, oauth: false, required: true });
  assert.deepEqual(gh.values, { host: 'github.acme.io' });
  assert.equal(gh.description, '');
  assert.deepEqual(normalizePolicyDoc(doc).doc.fields['mcp.required'], doc.fields['mcp.required'], 'idempotent');
});

test('each bad entry is dropped with its own warning; the valid ones stay (not the whole field)', () => {
  // P1's validator words its own errors; this table pins the label, the place and "— entry dropped".
  const bad = [
    [{ ...GITHUB, name: 'rel', command: './run.sh' }, /^mcp\.required: rel: .+ — entry dropped$/],
    [{ ...GITHUB, name: 'dollar', values: { host: '${HOME}' } }, /^mcp\.required: dollar: values\.host: .+ — entry dropped$/],
    [{ ...GITHUB, name: 'seedsecret', values: { token: 'x' } }, /^mcp\.required: seedsecret: values\.token: a secret field — each developer sets it — entry dropped$/],
    [{ ...GITHUB, name: 'nofield', values: { nope: 'x' } }, /^mcp\.required: nofield: values\.nope: no such field — entry dropped$/],
    [{ plugin: 'acme-tools', server: 'Sentry' }, /^mcp\.required: acme-tools\/Sentry: server "Sentry" is not a valid server name — entry dropped$/],
    [{ plugin: 'acme-tools', server: 'jira', values: { org: 'ghp_abcdefghijklmnopqrstuvwxyz0123' } }, /^mcp\.required: acme-tools\/jira: values\.org: .+ — entry dropped$/],
    [{ ...GITHUB }, /^mcp\.required: github: listed twice — entry dropped$/],
    ['nope', /^mcp\.required: entry 10: must be an object — entry dropped$/],
    // Valid JSON whose `toString` is no function: shown as JSON (String() of it would throw out of normalizePolicyDoc).
    [{ plugin: 'acme-tools', server: { toString: 0 } }, /^mcp\.required: acme-tools\/\{"toString":0\}: server "\{"toString":0\}" is not a valid server name — entry dropped$/],
  ];
  const { doc, warnings } = normalizePolicyDoc(docWith([GITHUB, SENTRY, ...bad.map(([e]) => e)]));
  assert.deepEqual(doc.fields['mcp.required'].value.map((e) => e.name || `${e.plugin}/${e.server}`), ['github', 'acme-tools/sentry']);
  assert.equal(warnings.length, bad.length);
  bad.forEach(([, re], i) => assert.match(warnings[i], re));
});

test('validateValue names the first bad entry; normalizeEntry keeps the kind rule', () => {
  const meta = fieldMeta('mcp.required');
  assert.equal(validateValue(meta, [GITHUB, SENTRY]), null);
  assert.equal(validateValue(meta, 'x'), 'must be a list of MCP server entries');
  assert.match(validateValue(meta, [{ plugin: 'acme-tools', server: 'Sentry' }]), /^acme-tools\/Sentry: server "Sentry"/);
  assert.match(normalizeEntry('mcp.required', { kind: 'default', value: [] }).warning, /kind "default" is not allowed/);
  assert.equal(validateValue(meta, [{ plugin: 'acme-tools', server: 'jira', values: { 'bad-key': 'x' } }]), 'acme-tools/jira: values.bad-key: no such field', 'a plugin reference\'s value key looks like a field key');
});

test('cross-field: a plugin reference needs its plugin in the same doc\'s plugins.required', () => {
  const raw = docWith([GITHUB, SENTRY, { plugin: 'other', server: 'x' }]);
  const { doc, warnings } = normalizePolicyDoc(raw);
  assert.deepEqual(doc.fields['mcp.required'].value.map((e) => e.name || e.server), ['github', 'sentry']);
  assert.deepEqual(warnings, ['mcp.required: other/x: plugin other is not in plugins.required — entry dropped']);
  const none = normalizePolicyDoc({ schema: 1, fields: { 'mcp.required': { kind: 'soft', value: [SENTRY] } } });
  assert.deepEqual(none.doc.fields['mcp.required'].value, []);
  assert.equal(none.warnings.length, 1);
});

test('workspaceRuns: mcp.required is dropped with a warning', () => {
  const { doc, warnings } = normalizePolicyDoc({ schema: 1, fields: {}, workspaceRuns: { 'mcp.required': { kind: 'soft', value: [GITHUB] } } });
  assert.deepEqual(doc.workspaceRuns, {});
  assert.deepEqual(warnings, ['workspaceRuns.mcp.required: not allowed for workspace runs — dropped']);
});

test('mcpListComplete: false while an entry or the field was dropped; a hard kind read as soft keeps every entry', async () => {
  const { mcpListComplete } = await import('../src/core/policy/registry.mjs');
  assert.equal(mcpListComplete(normalizePolicyDoc(docWith([GITHUB])).warnings), true);
  assert.equal(mcpListComplete(normalizePolicyDoc(docWith([GITHUB, { plugin: 'acme-tools', server: 'Bad' }])).warnings), false);
  assert.equal(mcpListComplete(normalizePolicyDoc(docWith('x')).warnings), false, 'the whole field dropped');
  assert.equal(mcpListComplete(['unknown field mcp.required']), false, 'an older Worca dropped the field');
  const hard = normalizePolicyDoc({ schema: 1, fields: { 'plugins.required': { kind: 'soft', value: [{ name: 'acme-tools' }] }, 'mcp.required': { kind: 'hard', value: [GITHUB] } } });
  assert.equal(hard.doc.fields['mcp.required'].value.length, 1);
  assert.equal(mcpListComplete(hard.warnings), true, 'a hand-edited hard kind keeps every entry: forget and retire still work');
  const hardBad = normalizePolicyDoc({ schema: 1, fields: { 'plugins.required': { kind: 'soft', value: [{ name: 'acme-tools' }] }, 'mcp.required': { kind: 'hard', value: [GITHUB, { plugin: 'acme-tools', server: 'Bad' }] } } });
  assert.equal(mcpListComplete(hardBad.warnings), false, 'a hard kind never hides an entry this build dropped');
});

// ---- display and the Ask policy card (Task 2) ------------------------------------------------
import { fmtValue } from '../src/core/policy/effective.mjs';
import { createPolicyChangeValidator, normalizeEditOps, describeEntry } from '../src/core/ask/policy-proposal.mjs';

const normalized = () => normalizePolicyDoc(docWith([GITHUB, SENTRY])).doc;

test('fmtValue / describeEntry: one line per entry, never [object Object]', () => {
  const meta = fieldMeta('mcp.required');
  const doc = normalized();
  assert.equal(fmtValue(meta, doc.fields['mcp.required'].value), 'github (stdio: npx -y @modelcontextprotocol/server-github), sentry (acme-tools)');
  const http = normalizePolicyDoc(docWith([{ name: 'dd', type: 'http', url: ['https://mcp.dd.dev/', { field: 'site' }], fields: [{ key: 'site', label: 'Site', required: true }] }])).doc;
  assert.equal(fmtValue(meta, http.fields['mcp.required'].value), 'dd (http: https://mcp.dd.dev/{site})');
  assert.equal(fmtValue(meta, []), '(none)');
  assert.equal(describeEntry('mcp.required', doc.fields['mcp.required']), 'soft github (stdio: npx -y @modelcontextprotocol/server-github), sentry (acme-tools)');
});

test('normalizeEditOps refuses mcp.required for workspace runs and names every dropped entry', () => {
  const doc = normalized();
  assert.deepEqual(normalizeEditOps({ set: [{ key: 'mcp.required', value: [GITHUB], forWorkspaceRuns: true }] }, doc).errors,
    ['mcp.required cannot be set for workspace runs — a workspace run uses its policy home\'s Team set']);
  assert.deepEqual(normalizeEditOps({ set: [{ key: 'mcp.required', value: [GITHUB, { plugin: 'acme-tools', server: 'Bad' }] }] }, doc).errors,
    ['mcp.required: acme-tools/Bad: server "Bad" is not a valid server name — entry dropped']);
  // Any entry warning refuses its op, never drops it silently (an attribute warning too).
  assert.deepEqual(normalizeEditOps({ set: [{ key: 'cost.pipelineLimitUsd', kind: 'soft', value: 25, onBreach: 'explode' }] }, doc).errors,
    ['cost.pipelineLimitUsd: onBreach must be pause | warn (ignored)']);
});

test('an Ask policy-proposal edit of mcp.required validates; the cross-field rule runs again after applyEditOps', async () => {
  const doc = normalized();
  const validate = createPolicyChangeValidator({
    listProjects: async () => [{ key: 'gw-00000001', name: 'gateway', path: '/p/gateway' }],
    readWorkspace: async () => null, projectKeyOf: () => 'gw-00000001', projectStatus: async () => ({}),
    scopePolicy: async () => ({ r: { ok: true, home: 'acme/gateway', homeDir: '/p/gateway', sha: 'abc1234', doc }, canPublish: true }),
  });
  const ok = await validate({ kind: 'edit', projectKey: 'gw-00000001', set: [{ key: 'mcp.required', value: [SENTRY] }] });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.card.changes[0].label, 'Required MCP servers');
  assert.equal(ok.card.changes[0].afterValue, 'sentry (acme-tools)');
  // Unsetting plugins.required leaves sentry's plugin reference dangling: refused, never published half-applied.
  const bad = await validate({ kind: 'edit', projectKey: 'gw-00000001', unset: ['plugins.required'] });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors, ['mcp.required: acme-tools/sentry: plugin acme-tools is not in plugins.required — entry dropped']);
});
