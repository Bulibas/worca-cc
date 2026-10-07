// test/ask-skills.test.mjs — Ask Worca's side of the skills registry (spec §4.4) over injected readers: one skills
// resolve per turn or preview (General ∪ the targets in play, the chat's choices, cap 12, Team input from the policy
// cache), the host gate. The resolver itself is faked: its own rules are tested with it (P3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAskSkills, ASK_SKILL_CAP } from '../src/core/ask/mcp.mjs';

const PROJECTS = [
  { key: 'billing-00000001', name: 'billing', path: '/p/billing' },
  { key: 'shop-00000002', name: 'shop', path: '/p/shop' },
];
const WS = { id: 'wks-checkout-0000abcd', name: 'checkout', projectKeys: ['billing-00000001', 'shop-00000002'], policyProject: '/p/billing' };
const readers = (worktrees = []) => ({
  listProjects: async () => PROJECTS,
  readWorkspace: async (id) => (id === WS.id ? WS : null),
  listWorktrees: (threadId) => (threadId === 'ask_00000001' ? worktrees : []),
});
const mounted = (setId, setName, pluginName, name, projects = []) => ({
  id: `skill:library:${name}`, name, qualifiedName: `${pluginName}:${name}`, pluginName, setId, setName, setSlug: setId === 'general' ? null : setId,
  dir: `/lib/${name}`, projects, description: `${name} help`, plugin: null,
});
const SKILLS = () => ({
  mounted: [mounted('billing', 'Billing', 'billing', 'deploy-checklist', ['billing-00000001']), mounted('general', 'General', 'general', 'graphify')],
  plugins: [{ setId: 'billing', setName: 'Billing', pluginName: 'billing', renamedPlugin: false, skills: ['deploy-checklist'] },
    { setId: 'general', setName: 'General', pluginName: 'general', renamedPlugin: false, skills: ['graphify'] }],
  skipped: [{ setId: 'billing', setName: 'Billing', skillId: 'skill:library:db-migrations', name: 'db-migrations', reason: 'off' }],
  sets: [{ id: 'general', name: 'General', group: 'general', routes: [], skills: 1, started: 1 },
    { id: 'billing', name: 'Billing', group: 'set', routes: [{ project: 'billing-00000001', route: 'pinned' }], skills: 2, started: 1 }],
});
test('resolveAskSkills: surface ask, cap 12, the chat\'s choices, Team skills input per target from the policy cache (ws:<id> for a workspace)', async () => {
  const calls = []; const teamCalls = [];
  const deps = { ...readers([{ projectKey: 'shop-00000002' }]),
    cachedSkillTeamFor: async (target) => { teamCalls.push(target); return target.projectKey === 'billing-00000001' ? { home: 'acme/platform', required: [{ plugin: 'acme', skill: 'deploy-checklist' }] } : null; },
    resolveSkillRegistry: async (opts) => { calls.push(opts); return SKILLS(); } };
  const off = { sets: ['shop'], members: ['billing|skill:library:db-migrations'] };   // a set switched off reaches the resolver too
  const { targets, result } = await resolveAskSkills({ ctx: { pinned: true, projectKey: 'billing-00000001' }, threadId: 'ask_00000001', off }, deps);
  assert.deepEqual(targets.map((t) => [t.key, t.route]), [['billing-00000001', 'pinned'], ['shop-00000002', 'worktree']]);
  assert.deepEqual(result, { ...SKILLS(), blocked: null });
  const o = calls[0];
  assert.equal(o.surface, 'ask');
  assert.equal(o.skillCap, 12); assert.equal(ASK_SKILL_CAP, 12);
  assert.deepEqual(o.off, off);
  assert.deepEqual(o.targets, targets);
  assert.deepEqual(teamCalls, [{ projectKey: 'billing-00000001' }, { projectKey: 'shop-00000002' }]);
  assert.deepEqual({ ...o.teams }, { 'billing-00000001': { home: 'acme/platform', required: [{ plugin: 'acme', skill: 'deploy-checklist' }] }, 'shop-00000002': null });
  await resolveAskSkills({ ctx: { pinned: true, workspaceId: WS.id } }, deps);
  assert.deepEqual(teamCalls.at(-1), { workspaceId: WS.id });
  assert.deepEqual(Object.keys(calls[1].teams), [`ws:${WS.id}`]);
  await resolveAskSkills({ ctx: {} }, deps);
  assert.deepEqual(calls[2].off, { sets: [], members: [] }, 'no choices ⇒ nothing off');
});

test('resolveAskSkills: the resolver\'s host gate passes through — a blocked layer keeps its rows listed; a result without one reads null', async () => {
  const deps = { ...readers(), cachedSkillTeamFor: async () => null, resolveSkillRegistry: async () => ({ ...SKILLS(), blocked: 'sideload-disabled' }) };
  const { result } = await resolveAskSkills({ ctx: {} }, deps);
  assert.equal(result.blocked, 'sideload-disabled');
  assert.equal(result.mounted.length, 2);
  assert.equal((await resolveAskSkills({ ctx: {} }, { ...deps, resolveSkillRegistry: async () => SKILLS() })).result.blocked, null);
});

test('resolveAskSkills over the real P3 resolver: this host\'s managed settings mark the layer blocked, the rows still resolve', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'worca-ask-skills-'));
  const prev = process.env.WORCA_CLAUDE_MANAGED_SETTINGS;
  t.after(() => { if (prev === undefined) delete process.env.WORCA_CLAUDE_MANAGED_SETTINGS; else process.env.WORCA_CLAUDE_MANAGED_SETTINGS = prev; rmSync(dir, { recursive: true, force: true }); });
  process.env.WORCA_CLAUDE_MANAGED_SETTINGS = join(dir, 'managed-settings.json');
  const deps = { ...readers(), cachedSkillTeamFor: async () => null };
  assert.equal((await resolveAskSkills({ ctx: {} }, deps)).result.blocked, null, 'no managed file: not blocked');
  writeFileSync(process.env.WORCA_CLAUDE_MANAGED_SETTINGS, JSON.stringify({ disableSideloadFlags: true }));
  const { result } = await resolveAskSkills({ ctx: {} }, deps);
  assert.equal(result.blocked, 'sideload-disabled');
  assert.equal(result.newer, false);
  assert.deepEqual(result.sets.map((s) => s.id), ['general'], 'the rows still resolve');
});

test('resolveAskSkills never throws: a failing reader or resolver reads as no skills', async (t) => {
  const warn = console.warn; const lines = []; console.warn = (l) => lines.push(l); t.after(() => { console.warn = warn; });
  const out = await resolveAskSkills({ ctx: {} }, { ...readers(), cachedSkillTeamFor: async () => null,
    resolveSkillRegistry: async () => { throw new Error('library unreadable'); } });
  assert.deepEqual(out, { targets: [], result: { mounted: [], plugins: [], skipped: [], sets: [], blocked: null } });
  assert.match(lines[0], /skills resolve failed \(library unreadable\)/);
});
