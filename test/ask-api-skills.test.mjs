// test/ask-api-skills.test.mjs — skills registry §4.4/§7 end to end over WORCA_MOCK: POST /api/ask/mcp-preview's
// `skills` block, the message route (the turn carries the resolve, the prompt its skills line, the prompt never starts
// with `/`), the per-chat choices with a skill key, the worktree join notice, the per-message mount removed after the
// turn. Seeds a library skill through the P1 import API and General through the P2 store API — never by writing files.
// Boot idiom: test/ask-api-mcp.test.mjs (temp home BEFORE the dynamic import).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { useTempHome } from './helpers/temp-home.mjs';
import { checkRows } from './helpers/rows.mjs';

useTempHome(after);

let homeDir, prevHome, prevManaged, prevConfigDir, shopDir, srv, base, mod;
const JSONH = { 'Content-Type': 'application/json' };
const MODEL = { model: 'claude-opus-5-5', effort: 'high' };
const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: JSONH, body: JSON.stringify(body) });
const patch = (p, body) => fetch(`${base}${p}`, { method: 'PATCH', headers: JSONH, body: JSON.stringify(body) });
const preview = (body) => post('/api/ask/mcp-preview', { context: { view: 'new', pinned: false }, model: MODEL.model, ...body });
const idle = async () => {
  for (let i = 0; i < 500 && [...mod._testing.askJobs.values()].some((j) => j.status === 'running'); i++) await new Promise((r) => setTimeout(r, 10));
};
const turnOf = async (threadId) => {
  for (let i = 0; i < 500 && !mod._testing.askJobs.get(threadId)?.turn; i++) await new Promise((r) => setTimeout(r, 10));
  return mod._testing.askJobs.get(threadId).turn;
};
const LINE = (names) => `\nSkills from your sets this turn: ${names}\n`;

/** One library skill (P1 stageImport + commitImport), returned as its catalog entry (P1 loadSkillCatalog). */
async function librarySkill(name) {
  const { stageImport } = await import('../src/core/skills-registry/import.mjs');
  const { commitImport } = await import('../src/core/skills-registry/library.mjs');
  const { loadSkillCatalog } = await import('../src/core/skills-registry/catalog.mjs');
  const st = await stageImport({ kind: 'paste', name, content: `---\nname: ${name}\ndescription: ${name} help\n---\nFollow these steps.\n` }, {});
  await commitImport(st.dir, name);
  return (await loadSkillCatalog()).find((e) => e.id === `skill:library:${name}`);
}

before(async () => {
  homeDir = mkdtempSync(join(tmpdir(), 'worca-cc-askskills-'));
  prevHome = process.env.WORCA_HOME;
  process.env.WORCA_HOME = homeDir;
  process.env.WORCA_MOCK = '1';
  // Hermetic host facts: never this machine's managed Claude Code settings (P3 skillHostFacts override).
  prevManaged = process.env.WORCA_CLAUDE_MANAGED_SETTINGS;
  process.env.WORCA_CLAUDE_MANAGED_SETTINGS = join(homeDir, 'no-managed-settings.json');
  // …nor this machine's Claude Code config: skillHostFacts reads $CLAUDE_CONFIG_DIR/settings.json when it is set, and its
  // enabled plugin names would rename the set plugins (`general` → `general-set`).
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(homeDir, 'claude-config');
  mod = await import('../ui/server.mjs');
  srv = mod.server;
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  const { putSkillMember } = await import('../src/core/mcp/store.mjs');
  const entry = await librarySkill('release-notes');
  await putSkillMember('general', entry.id, { enabled: true }, { entry });
});

after(async () => {
  for (const [, job] of mod._testing.askJobs) { try { job.turn?.stop?.(); } catch { /* reap */ } }
  if (srv) await Promise.race([
    new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); }),
    new Promise((r) => { const t = setTimeout(r, 500); t.unref?.(); }),
  ]);
  if (prevHome === undefined) delete process.env.WORCA_HOME; else process.env.WORCA_HOME = prevHome;
  delete process.env.WORCA_MOCK;
  if (prevManaged === undefined) delete process.env.WORCA_CLAUDE_MANAGED_SETTINGS; else process.env.WORCA_CLAUDE_MANAGED_SETTINGS = prevManaged;
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
  rmSync(homeDir, { recursive: true, force: true });
  if (shopDir) rmSync(shopDir, { recursive: true, force: true });
});

test('the preview and the turn agree: General\'s skill mounted in both, the prompt\'s skills line, the turn prompt starts [worca context]', async () => {
  const p = await (await preview({})).json();
  assert.deepEqual(p.skills.mounted.map((m) => m.qualifiedName), ['general:release-notes']);
  assert.equal(p.skills.started, 1);
  assert.deepEqual(p.skills.layer, { blocked: null, text: null });
  assert.ok(p.skills.mounted.every((m) => !Object.hasOwn(m, 'dir')), 'no host path in the preview');
  const general = p.sets.find((s) => s.id === 'general');
  assert.equal(general.skills, 1);
  assert.equal(general.startedSkills, 1);
  await idle();
  const { thread } = await (await post('/api/ask/threads', {})).json();
  const r = await post(`/api/ask/threads/${thread.id}/messages`, { text: '/clear', ...MODEL, context: { view: 'new', pinned: false } });
  assert.equal(r.status, 202, await r.text());
  const turn = await turnOf(thread.id);
  assert.deepEqual(turn.skills.mounted.map((m) => m.qualifiedName), p.skills.mounted.map((m) => m.qualifiedName), 'the same targets in play and resolver as the preview');
  assert.ok(turn.prompt.startsWith('[worca context]'), 'a message that starts with / never reaches the CLI as a slash command');
  await idle();
  assert.ok(turn.systemPrompt.includes(LINE('general:release-notes')), 'the turn appended the line for what it mounted');
  const mount = join(homeDir, '.worca-cc', 'ask', thread.id, 'skills', turn.assistantMessageId);
  // run()'s finally removes the mount after ask-done (which settles the job): wait for it, bounded.
  for (let i = 0; i < 500 && existsSync(mount); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(turn.skillMount.base, mount, 'the turn mounted under its thread, per message');
  assert.ok(turn.skillMount.pluginDirs.length > 0 && turn.skillMount.pluginDirs.every((p) => dirname(p) === mount), 'one plugin folder per set, right under the base');
  assert.equal(existsSync(mount), false, 'the per-message mount is gone after the turn');
});

test('mcpOff with a skill key: the PATCH stores it, the preview reads chat-off with the qualified name, the next turn mounts nothing and its prompt has no skills section', async () => {
  await checkRows([
    { name: 'a { mcpOff } PATCH with a skill key switches that skill off from the next turn and the preview', run: async () => {
      await idle();
      const { thread } = await (await post('/api/ask/threads', {})).json();
      const res = await patch(`/api/ask/threads/${thread.id}`, { mcpOff: { members: ['general|skill:library:release-notes'] } });
      assert.equal(res.status, 200, await res.text());
      const off = await (await preview({ threadId: thread.id })).json();
      assert.equal(off.skills.started, 0);
      assert.deepEqual(off.skills.skipped.map((s) => [s.qualifiedName, s.reason, s.problem]), [['general:release-notes', 'chat-off', false]]);
      const r = await post(`/api/ask/threads/${thread.id}/messages`, { text: 'hi', ...MODEL, context: { view: 'new', pinned: false } });
      assert.equal(r.status, 202);
      const turn = await turnOf(thread.id);
      assert.equal(turn.skills, null);
      assert.ok(!turn.systemPrompt.includes('## Skills from your sets'), 'byte-identical to a chat without skills');
    } },
    { name: 'a message\'s own mcpOff with a skill key wins over the stored choices for that turn', run: async () => {
      await idle();
      const { thread } = await (await post('/api/ask/threads', {})).json();
      const r = await post(`/api/ask/threads/${thread.id}/messages`, { text: 'hi', ...MODEL, context: { view: 'new', pinned: false }, mcpOff: { members: ['general|skill:library:release-notes'] } });
      assert.equal(r.status, 202, await r.text());
      assert.equal((await turnOf(thread.id)).skills, null);
    } },
    { name: 'a malformed skill key is refused with 400 on the PATCH and the message route', run: async () => {
      await idle();
      const { thread } = await (await post('/api/ask/threads', {})).json();
      assert.equal((await patch(`/api/ask/threads/${thread.id}`, { mcpOff: { members: ['general|skill:bogus'] } })).status, 400);
      assert.equal((await post(`/api/ask/threads/${thread.id}/messages`, { text: 'hi', ...MODEL, mcpOff: { members: ['general|skill:bogus'] } })).status, 400);
    } },
  ]);
});

test('server wiring: a worktree opened mid-turn names the skills its project\'s sets bring from the next message', async () => {
  await idle();
  const { addProject } = await import('../src/core/projects.mjs');
  const { gitDir } = await import('./helpers/git-dir.mjs');
  shopDir = gitDir('askskills-shop');
  const shop = (await addProject({ name: 'shop', path: shopDir })).find((x) => x.name === 'shop');
  const { createSet, putSkillMember, setProjectAssignment } = await import('../src/core/mcp/store.mjs');
  const set = await createSet('Shop');
  const entry = await librarySkill('stock-check');
  await putSkillMember(set.id, entry.id, { enabled: true }, { entry });
  await setProjectAssignment(shop.key, { sets: [set.id], includeGeneral: true });
  const { thread } = await (await post('/api/ask/threads', {})).json();
  const r = await post(`/api/ask/threads/${thread.id}/messages`, { text: 'hi', ...MODEL, context: { view: 'settings', pinned: false } });
  assert.equal(r.status, 202, await r.text());
  const turn = await turnOf(thread.id);
  assert.ok(!turn.skills.mounted.some((m) => m.name === 'stock-check'), 'precondition: shop is not in play at turn start');
  const { openAskWorktree } = await import('../src/core/ask/worktrees.mjs');
  await openAskWorktree({ threadId: thread.id, projectKey: shop.key, ref: 'HEAD' });
  assert.equal(await turn.deps.mcpJoinNotice(), "shop's skills (shop:stock-check) join from the next message");
});
