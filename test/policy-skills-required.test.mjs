// test/policy-skills-required.test.mjs — the `skills.required` policy field (skills registry spec §5, §7, F8):
// registry row, per-entry normalizer, cross-field rule, workspaceRuns refusal, the list-complete rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIELDS, fieldMeta, normalizePolicyDoc, normalizeEntry, validateValue, skillsListComplete, mcpListComplete } from '../src/core/policy/registry.mjs';
import { normalizeEditOps } from '../src/core/ask/policy-proposal.mjs';
import { PLUGIN_NAME_RE as MANIFEST_PLUGIN_NAME_RE } from '../src/core/plugin-manifest.mjs';

const DEPLOY = { plugin: 'acme', skill: 'deploy-checklist' };
const QA = { plugin: 'acme-qa', skill: 'qa-runbook' };
const docWith = (value, extra = {}) => ({ schema: 1, fields: {
  'plugins.required': { kind: 'soft', value: [{ name: 'acme' }, { name: 'acme-qa' }] },
  'skills.required': { kind: 'soft', value }, ...extra } });

test('skills.required sits after mcp.required: soft only, Plugins group, never under workspaceRuns', () => {
  const keys = FIELDS.map((f) => f.key);
  assert.equal(keys[keys.indexOf('mcp.required') + 1], 'skills.required');
  const m = fieldMeta('skills.required');
  assert.deepEqual([m.group, m.label, m.type, m.kinds, m.workspaceRuns], ['plugins', 'Required skills', 'skills', ['soft'], false]);
  assert.equal(m.help, 'Each developer turns them on with consent; they join the Team set. Never automatic.');
});

test('valid entries normalise to { plugin, skill } (other keys dropped) and survive a second pass unchanged', () => {
  const { doc, warnings } = normalizePolicyDoc(docWith([{ ...DEPLOY, note: 'x' }, { skill: QA.skill, plugin: QA.plugin }]));
  assert.deepEqual(warnings, []);
  assert.deepEqual(doc.fields['skills.required'].value, [DEPLOY, QA]);
  assert.deepEqual(normalizePolicyDoc(doc).doc.fields['skills.required'], doc.fields['skills.required'], 'idempotent');
});

test('each bad entry is dropped with its own warning; the valid ones stay (not the whole field)', () => {
  const bad = [
    [{ name: 'release-notes' }, 'skills.required: entry 2: an entry is { "plugin", "skill" } — plugin skills only — entry dropped'],
    [{ plugin: 'Acme', skill: 'x' }, 'skills.required: Acme/x: plugin "Acme" is not a valid plugin name — entry dropped'],
    [{ plugin: 'acme--x', skill: 'x' }, 'skills.required: acme--x/x: plugin "acme--x" is not a valid plugin name — entry dropped'],
    [{ plugin: 'acme', skill: 'Deploy' }, 'skills.required: acme/Deploy: skill "Deploy" is not a valid skill name — entry dropped'],
    [{ plugin: 'acme', skill: 'a'.repeat(65) }, `skills.required: acme/${'a'.repeat(65)}: skill "${'a'.repeat(65)}" is not a valid skill name — entry dropped`],
    [{ plugin: 'acme', skill: 7 }, 'skills.required: acme/7: skill "7" is not a valid skill name — entry dropped'],
    [{ ...DEPLOY }, 'skills.required: acme/deploy-checklist: listed twice — entry dropped'],
    [{ plugin: 'acme-qa', skill: 'deploy-checklist' }, 'skills.required: acme-qa/deploy-checklist: a skill named deploy-checklist is already listed (from acme) — one name per Team set — entry dropped'],
    ['nope', 'skills.required: entry 10: must be an object — entry dropped'],
  ];
  const { doc, warnings } = normalizePolicyDoc(docWith([DEPLOY, ...bad.map(([e]) => e), QA]));
  assert.deepEqual(doc.fields['skills.required'].value, [DEPLOY, QA]);
  assert.deepEqual(warnings, bad.map(([, w]) => w));
});

test('plugin names follow the plugin manifest rule (≤ 64); skill names the Agent Skills rule (≤ 64)', () => {
  const meta = fieldMeta('skills.required');
  for (const p of ['acme', 'acme-qa', 'a', 'a1-b2', 'acme--x', 'acme-', '-acme', 'Acme', '1acme', 'a_b', 'a'.repeat(64), 'a'.repeat(65)]) {
    const want = MANIFEST_PLUGIN_NAME_RE.test(p) && p.length <= 64;
    assert.equal(validateValue(meta, [{ plugin: p, skill: 'x' }]) === null, want, p);
  }
  for (const s of ['x', 'deploy-checklist', '1st', 'a'.repeat(64), 'a'.repeat(65), 'Deploy', 'a--b', '-a', 'a_b', '', 'synced', 'anthropic-skills']) {
    const want = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length <= 64 && !['synced', 'anthropic-skills'].includes(s);
    assert.equal(validateValue(meta, [{ plugin: 'acme', skill: s }]) === null, want, s);
  }
});

test('validateValue names the first bad entry; normalizeEntry keeps the kind rule', () => {
  const meta = fieldMeta('skills.required');
  assert.equal(validateValue(meta, [DEPLOY, QA]), null);
  assert.equal(validateValue(meta, 'x'), 'must be a list of { plugin, skill } entries');
  assert.equal(validateValue(meta, [{ plugin: 'acme', skill: 'Bad' }]), 'acme/Bad: skill "Bad" is not a valid skill name');
  assert.equal(validateValue(meta, [{ plugin: 'acme', skill: 'synced' }]), 'acme/synced: skill "synced" is a reserved name', '§2b-9: it can never mount');
  assert.match(normalizeEntry('skills.required', { kind: 'default', value: [] }).warning, /kind "default" is not allowed/);
  assert.deepEqual(normalizeEntry('skills.required', { kind: 'soft', value: [DEPLOY, { plugin: 'acme' }] }).dropped,
    ['skills.required: acme/undefined: skill "undefined" is not a valid skill name — entry dropped']);
});

test('cross-field: a skill\'s plugin must be in the same doc\'s plugins.required', () => {
  const { doc, warnings } = normalizePolicyDoc(docWith([DEPLOY, { plugin: 'other', skill: 'x' }, QA]));
  assert.deepEqual(doc.fields['skills.required'].value, [DEPLOY, QA]);
  assert.deepEqual(warnings, ['skills.required: other/x: plugin other is not in plugins.required — entry dropped']);
  const none = normalizePolicyDoc({ schema: 1, fields: { 'skills.required': { kind: 'soft', value: [DEPLOY] } } });
  assert.deepEqual(none.doc.fields['skills.required'].value, []);
  assert.deepEqual(none.warnings, ['skills.required: acme/deploy-checklist: plugin acme is not in plugins.required — entry dropped']);
});

test('refused under workspaceRuns: the normalizer drops it, the Ask edit op refuses it', () => {
  const { doc, warnings } = normalizePolicyDoc({ ...docWith([DEPLOY]), workspaceRuns: { 'skills.required': { kind: 'soft', value: [DEPLOY] } } });
  assert.equal(doc.workspaceRuns['skills.required'], undefined);
  assert.deepEqual(warnings, ['workspaceRuns.skills.required: not allowed for workspace runs — dropped']);
  assert.deepEqual(normalizeEditOps({ set: [{ key: 'skills.required', value: [DEPLOY], forWorkspaceRuns: true }] }, doc).errors,
    ['skills.required cannot be set for workspace runs — a workspace run uses its policy home\'s Team set']);
  assert.deepEqual(normalizeEditOps({ set: [{ key: 'skills.required', value: [DEPLOY, { plugin: 'acme', skill: 'Bad' }] }] }, doc).errors,
    ['skills.required: acme/Bad: skill "Bad" is not a valid skill name — entry dropped']);
});

test('skillsListComplete: false while any skills.required entry (or the field) was dropped; the MCP rule is its own', () => {
  assert.equal(skillsListComplete([]), true);
  assert.equal(skillsListComplete(), true);
  assert.equal(skillsListComplete(['skills.required: acme/x: listed twice — entry dropped']), false);
  assert.equal(skillsListComplete(['skills.required: other/x: plugin other is not in plugins.required — entry dropped']), false);
  assert.equal(skillsListComplete(['unknown field skills.required']), false, 'an older build that cannot read the field');
  assert.equal(skillsListComplete(['skills.required: kind must be one of default | soft | hard']), false, 'the whole field dropped');
  assert.equal(skillsListComplete(['fields: not an object — ignored']), false, 'the whole fields block unreadable');
  assert.ok(normalizePolicyDoc({ schema: 1, fields: [] }).warnings.includes('fields: not an object — ignored'), 'the warning text this rule reads');
  assert.equal(skillsListComplete(['skills.required: hard constraints are not enforced by this version — treated as soft']), true);
  assert.equal(skillsListComplete(['workspaceRuns.skills.required: not allowed for workspace runs — dropped']), true);
  assert.equal(skillsListComplete(['mcp.required: x: listed twice — entry dropped', 7, null]), true);
  assert.equal(mcpListComplete(['skills.required: acme/x: listed twice — entry dropped']), true, 'a skill warning never blocks MCP forget');
  const hard = normalizePolicyDoc(docWith([DEPLOY, { plugin: 'acme', skill: 'Bad' }], {}));
  assert.equal(skillsListComplete(hard.warnings), false);
});

// ---- display, the effective table and run deviations (Task 2) ---------------------------------
import { fmtValue, effectiveRows, skillDeviations } from '../src/core/policy/effective.mjs';
import { describeEntry } from '../src/core/ask/policy-proposal.mjs';

test('fmtValue / describeEntry: "deploy-checklist (acme)", never [object Object]', () => {
  const meta = fieldMeta('skills.required');
  assert.equal(fmtValue(meta, [DEPLOY, QA]), 'deploy-checklist (acme), qa-runbook (acme-qa)');
  assert.equal(fmtValue(meta, []), '(none)');
  assert.equal(describeEntry('skills.required', { kind: 'soft', value: [DEPLOY] }), 'soft deploy-checklist (acme)');
});

test('effective table: the team list applies; "N missing" when fewer run here (Yours)', () => {
  const { doc } = normalizePolicyDoc(docWith([DEPLOY, QA]));
  const row = (local) => effectiveRows({ doc, local }).find((r) => r.key === 'skills.required');
  const r = row({ 'skills.required': { value: [DEPLOY], set: true } });
  assert.equal(r.effective.display, 'deploy-checklist (acme), qa-runbook (acme-qa)');
  assert.equal(r.local.display, 'deploy-checklist (acme)');
  assert.equal(r.note, '1 missing');
  assert.equal(row({ 'skills.required': { value: [DEPLOY, QA], set: true } }).note, null);
  assert.equal(row({}).note, null, 'no rows here: nothing to compare');
  assert.equal(effectiveRows({ doc, workspaceRun: true }).find((x) => x.key === 'skills.required').shown, true,
    'a workspace run reads the fields block (workspaceRuns never carries it)');
});

// The Team set "team-acme" holds the policy's skills; resolver output shape: skills registry spec §4.2.
const TEAM = { id: 'team-acme-platform-9333', name: 'Team · acme/platform', group: 'team' };
const fieldsOf = (value) => ({ 'skills.required': { kind: 'soft', value } });
const ID = (e) => `skill:plugin:${e.plugin}/${e.skill}`;
const skip = (e, reason, setId = TEAM.id) => ({ setId, setName: 'x', skillId: ID(e), name: e.skill, reason });
const mount = (e, setId = TEAM.id) => ({ id: ID(e), name: e.skill, setId });

test('skillDeviations: one code per required skill that does not mount from the Team set', () => {
  const reqs = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((s) => ({ plugin: 'acme', skill: s }));
  const [a, b, c, d, e, f, g, hh] = reqs;
  const resolved = {
    sets: [{ id: 'billing', group: 'set' }, TEAM],
    mounted: [mount(a), mount(b, 'billing')],
    skipped: [skip(c, 'needs-consent'), skip(d, 'off'), skip(e, 'opted-out'), skip(f, 'invalid-skill'), skip(g, 'missing-skill'), skip(hh, 'off', 'billing')],
  };
  assert.deepEqual(skillDeviations(fieldsOf(reqs), resolved, (s) => `why:${s.reason}`), [
    { code: 'skill-missing:acme/b', level: 'warn', text: 'Required skill acme/b is not installed.' },
    { code: 'skill-off:acme/c', level: 'warn', text: 'Required skill acme/c is off.' },
    { code: 'skill-off:acme/d', level: 'warn', text: 'Required skill acme/d is off.' },
    { code: 'skill-opted-out:acme/e', level: 'warn', text: 'Required skill acme/e is opted out of this run.' },
    { code: 'skill-skipped:acme/f', level: 'warn', text: 'Required skill acme/f is skipped in this run (why:invalid-skill).' },
    { code: 'skill-missing:acme/g', level: 'warn', text: 'Required skill acme/g is not installed.' },
    { code: 'skill-missing:acme/h', level: 'warn', text: 'Required skill acme/h is not installed.' },
  ], 'a mount or skip in another set never counts for the Team set');
  assert.deepEqual(skillDeviations(fieldsOf([a]), { sets: [], mounted: [mount(a)], skipped: [] }),
    [{ code: 'skill-missing:acme/a', level: 'warn', text: 'Required skill acme/a is not installed.' }], 'no Team set in play: nothing mounts from it');
  assert.deepEqual(skillDeviations({}, resolved), [], 'no skills.required: nothing');
  assert.deepEqual(skillDeviations(fieldsOf([f]), resolved), [{ code: 'skill-skipped:acme/f', level: 'warn', text: 'Required skill acme/f is skipped in this run (invalid-skill).' }], 'describe defaults to the reason');
  assert.deepEqual(skillDeviations(fieldsOf([a]), null), [{ code: 'skill-missing:acme/a', level: 'warn', text: 'Required skill acme/a is not installed.' }]);
});
