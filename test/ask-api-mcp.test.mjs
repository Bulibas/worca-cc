// test/ask-api-mcp.test.mjs — MCP registry §9 end to end over WORCA_MOCK: POST /api/ask/mcp-preview, the message
// route (the turn carries the resolve, the prompt its section), the per-chat choices, a card-event turn.
// Seeds the registry through the store API (src/core/mcp/store.mjs) — never by writing its files.
// Boot idiom: test/ask-api-memory-mount.test.mjs (temp home BEFORE the dynamic import).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTempHome } from './helpers/temp-home.mjs';
import { withGw } from './helpers/with-env.mjs';
import { checkRows } from './helpers/rows.mjs';

useTempHome(after);

let homeDir, prevHome, srv, base, mod;
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

before(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'worca-cc-askmcp-'));
  prevHome = process.env.WORCA_HOME;
  process.env.WORCA_HOME = homeDir;
  process.env.WORCA_MOCK = '1';
  mod = await import('../ui/server.mjs');
  srv = mod.server;
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  // General: one manual http server with no fields (every Ask turn gets it, spec D12) and one whose required
  // token is not set (skipped `missing:token`, §5.7).
  const { addManualServer, putMember } = await import('../src/core/mcp/store.mjs');
  const def = await addManualServer('docs', { type: 'http', url: 'https://docs.example.com/mcp', fields: [], description: 'Team docs' });
  await putMember('general', 'manual:docs', { enabled: true, values: {} }, { def });
  const tickets = await addManualServer('tickets', { type: 'http', url: 'https://tickets.example.com/mcp', fields: [{ key: 'token', label: 'API token', secret: true, required: true }] });
  await putMember('general', 'manual:tickets', { enabled: true, values: {} }, { def: tickets });
});

after(async () => {
  for (const [, job] of mod._testing.askJobs) { try { job.turn?.stop?.(); } catch { /* reap */ } }
  if (srv) await Promise.race([
    new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); }),
    new Promise((r) => { const t = setTimeout(r, 500); t.unref?.(); }),
  ]);
  if (prevHome === undefined) delete process.env.WORCA_HOME; else process.env.WORCA_HOME = prevHome;
  delete process.env.WORCA_MOCK;
  await rm(homeDir, { recursive: true, force: true });
});

test('POST /api/ask/mcp-preview validates every field before resolving', async () => {
  for (const [body, status] of [
    [{ context: 'x' }, 400], [{ context: { projectKey: 'Bad Key' } }, 400], [{ threadId: '../x' }, 400], [{ threadId: 'ask_ffffffff' }, 404],
    [{ mcpOff: { sets: ['Bad Id'] } }, 400], [{ model: 5 }, 400], [{ model: 'm'.repeat(201) }, 400],
  ]) assert.equal((await preview(body)).status, status, JSON.stringify(body));
});

test('the preview equals the turn\'s resolution: General\'s copy in both, the prompt section present, no secret or env in the preview', async () => {
  const p = await (await preview({})).json();
  assert.deepEqual(Object.keys(p).sort(), ['copies', 'newer', 'sets', 'skills', 'skipped', 'skippedTools', 'started'], 'P4\'s preview fields, minus message/deviations, plus the skills block (skills registry §4.4)');
  assert.equal(p.newer, false);
  assert.deepEqual(p.skippedTools, []);
  assert.deepEqual(p.copies.map((c) => c.name), ['docs']);
  assert.equal(p.started, 1);
  assert.deepEqual(p.skipped.map((s) => [s.copy, s.reason, s.why]), [['tickets', 'missing:token', 'API token not set']]);
  await idle();
  const { thread } = await (await post('/api/ask/threads', {})).json();
  const r = await post(`/api/ask/threads/${thread.id}/messages`, { text: 'hi', ...MODEL, context: { view: 'new', pinned: false } });
  assert.equal(r.status, 202, await r.text());
  const turn = await turnOf(thread.id);
  assert.deepEqual(turn.mcp.copies, p.copies, 'the same targets in play and resolver as the preview');
  assert.deepEqual(turn.mcp.skipped.map((s) => s.reason), p.skipped.map((s) => s.reason));
  assert.match(turn.systemPrompt, /\n## MCP servers\n/);
  assert.match(turn.systemPrompt, /\n- docs — Team docs · set General\n/);
  assert.equal(typeof turn.deps.mcpJoinNotice, 'function', 'the turn-end notice is wired');
});

test('mcpOff precedence: a PATCH applies from the next turn and the preview; a body mcpOff overrides the stored one and decides that very turn', async () => {
  await checkRows([
    { name: 'per-chat choices: a { mcpOff } PATCH applies from the next turn and the preview (threadId); a body mcpOff overrides the stored one', run: async () => {
      await idle();
      const { thread } = await (await post('/api/ask/threads', {})).json();
      assert.equal((await patch(`/api/ask/threads/${thread.id}`, { mcpOff: { sets: ['general'] } })).status, 200);
      const off = await (await preview({ threadId: thread.id })).json();
      assert.equal(off.started, 0);
      assert.deepEqual(off.skipped.map((s) => [s.copy, s.reason]), [['docs', 'chat-off'], ['tickets', 'chat-off']]);
      assert.equal((await (await preview({ threadId: thread.id, mcpOff: null })).json()).started, 1, 'a thread-less choice set overrides');
      const r = await post(`/api/ask/threads/${thread.id}/messages`, { text: 'hi', ...MODEL, context: { view: 'new', pinned: false } });
      assert.equal(r.status, 202);
      const turn = await turnOf(thread.id);
      assert.equal(turn.mcp, null, 'no copies this turn');
      assert.ok(!turn.systemPrompt.includes('## MCP servers'), 'the prompt is byte-identical to a chat without servers');
    } },
    { name: 'a message body mcpOff decides that very turn, over the stored choices (the thread row is read before the write)', run: async () => {
      await idle();
      const { thread } = await (await post('/api/ask/threads', {})).json();
      assert.equal((await patch(`/api/ask/threads/${thread.id}`, { mcpOff: { sets: ['general'] } })).status, 200);
      const r = await post(`/api/ask/threads/${thread.id}/messages`, { text: 'hi', ...MODEL, context: { view: 'new', pinned: false }, mcpOff: null });
      assert.equal(r.status, 202, await r.text());
      const turn = await turnOf(thread.id);
      assert.deepEqual(turn.mcp && turn.mcp.copies.map((c) => c.name), ['docs'], 'the body choices (all on), not the stored ones (General off)');
    } },
  ]);
});

test('the composer model sets the §5.6 tool-name limit: a translated model skips the never-tested copy', async () => {
  // withGw (P4): HOME sandboxed to a global model catalog holding the bridge-translated `gw-gpt` (limit 64).
  const p = await withGw(async () => (await preview({ model: 'gw-gpt' })).json());
  assert.equal(p.started, 0);
  assert.deepEqual(p.skipped.map((s) => [s.copy, s.reason]), [['docs', 'untested'], ['tickets', 'missing:token']]);
  assert.equal((await (await preview({})).json()).started, 1, 'a first-party model keeps the 128 limit');
});

test('server wiring: a card-event turn recomputes from stored context/choices; the thread\'s open worktrees feed the join notice and the preview', async () => {
  await checkRows([
    { name: 'a card-event turn recomputes from the stored context and choices', run: async () => {
      await idle();
      const { appendMessage } = await import('../src/core/ask/store.mjs');
      const { thread } = await (await post('/api/ask/threads', {})).json();
      appendMessage(thread.id, { role: 'user', text: 'hi' });
      appendMessage(thread.id, { role: 'assistant', text: 'ok', status: 'done', blocks: [{ kind: 'card', id: 'card_0000abcd', state: 'proposed', card: { type: 'model', summary: 'Add a model' } }] });
      assert.equal((await patch(`/api/ask/threads/${thread.id}`, { mcpOff: { members: ['general|manual:docs'] } })).status, 200);
      const r = await post(`/api/ask/threads/${thread.id}/cards/card_0000abcd`, { state: 'declined' });
      assert.equal(r.status, 200, await r.text());
      const turn = await turnOf(thread.id);
      assert.equal(turn.mcp, null, 'the stored choice switched the only copy off');
      assert.equal((await patch(`/api/ask/threads/${thread.id}`, { mcpOff: null })).status, 200);
      await idle();
      appendMessage(thread.id, { role: 'assistant', text: 'ok', status: 'done', blocks: [{ kind: 'card', id: 'card_0000abce', state: 'proposed', card: { type: 'model', summary: 'Another' } }] });
      assert.equal((await post(`/api/ask/threads/${thread.id}/cards/card_0000abce`, { state: 'declined' })).status, 200);
      for (let i = 0; i < 500 && mod._testing.askJobs.get(thread.id)?.turn === turn; i++) await new Promise((res) => setTimeout(res, 10));
      assert.deepEqual(mod._testing.askJobs.get(thread.id).turn.mcp.copies.map((c) => c.name), ['docs'], 'recomputed, not the first turn\'s result');
    } },
    { name: 'the server wiring reads the thread\'s open worktrees: the turn-end join notice and the preview (threadId)', run: async () => {
      await idle();
      const { addProject } = await import('../src/core/projects.mjs');
      const { gitDir } = await import('./helpers/git-dir.mjs');
      const shop = (await addProject({ name: 'shop', path: gitDir('askmcp-shop') })).find((p) => p.name === 'shop');
      const { addManualServer, createSet, putMember, setProjectAssignment } = await import('../src/core/mcp/store.mjs');
      const def = await addManualServer('tracker', { type: 'http', url: 'https://tracker.example.com/mcp', fields: [] });
      const set = await createSet('Shop');
      await putMember(set.id, 'manual:tracker', { enabled: true, values: {} }, { def });
      await setProjectAssignment(shop.key, { sets: [set.id], includeGeneral: true });
      const { thread } = await (await post('/api/ask/threads', {})).json();
      const r = await post(`/api/ask/threads/${thread.id}/messages`, { text: 'hi', ...MODEL, context: { view: 'settings', pinned: false } });
      assert.equal(r.status, 202, await r.text());
      const turn = await turnOf(thread.id);
      assert.ok(!turn.mcp.copies.some((c) => c.name === 'tracker_shop'), 'precondition: shop is not in play at turn start');
      // the model opens a worktree on shop during the turn (open_worktree → openAskWorktree)
      const { openAskWorktree } = await import('../src/core/ask/worktrees.mjs');
      await openAskWorktree({ threadId: thread.id, projectKey: shop.key, ref: 'HEAD' });
      assert.equal(await turn.deps.mcpJoinNotice(), "shop's MCP servers (tracker_shop) join from the next message");
      assert.equal((await patch(`/api/ask/threads/${thread.id}`, { mcpOff: { sets: [set.id] } })).status, 200);
      assert.equal(await turn.deps.mcpJoinNotice(), null, 'the stored choices at turn end: a set switched off in this chat joins nothing');
      assert.equal((await patch(`/api/ask/threads/${thread.id}`, { mcpOff: null })).status, 200);
      const p = await (await preview({ threadId: thread.id })).json();
      assert.ok(p.copies.some((c) => c.name === 'tracker_shop'), 'the preview adds the thread\'s open worktrees');
    } },
  ]);
});
