// test/ask-api-away-cards.test.mjs
// The Away mode card over the cards route (ui/server.mjs, WORCA_MOCK): Apply writes the stored settings
// with the same writers and key as POST /api/settings / PATCH /api/config; Keep as is (declined) writes
// nothing; a card whose project is unknown fails. HOME is pinned to a temp dir: settings.json lives
// under HOME, never WORCA_HOME, so a user-level Apply must never reach the developer's real file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { useTempHome } from './helpers/temp-home.mjs';
import { gitDir } from './helpers/git-dir.mjs';
import { checkRows } from './helpers/rows.mjs';
import { _resetForTests as closeDbForTests } from '../src/core/db.mjs';

useTempHome(after);

let homeDir; let osHome; let prevHome; let prevOs; let mod; let store; let srv; let base; let validateAwayChange; let project;
const JSONH = { 'Content-Type': 'application/json' };
const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: JSONH, body: JSON.stringify(body) });
const get = async (p) => (await fetch(`${base}${p}`)).json();
const snapshot = async (id) => get(`/api/ask/threads/${id}`);
async function waitFor(pred, ms = 10000) {
  const t0 = Date.now();
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

before(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'worca-cc-askaway-'));
  osHome = await mkdtemp(join(tmpdir(), 'worca-cc-askaway-os-'));   // settings.json lives under the OS home
  prevHome = process.env.WORCA_HOME;
  prevOs = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.WORCA_HOME = homeDir;
  process.env.HOME = osHome; process.env.USERPROFILE = osHome;
  process.env.WORCA_MOCK = '1';
  assert.equal(process.env.HOME, osHome, 'HOME is the temp dir before anything writes settings');
  mod = await import('../ui/server.mjs');
  store = await import('../src/core/ask/store.mjs');
  ({ validateAwayChange } = await import('../src/core/ask/away-deps.mjs'));
  const { addProject } = await import('../src/core/projects.mjs');
  project = (await addProject({ name: 'awaycard', path: gitDir('awaycard') })).find((p) => p.name === 'awaycard');
  srv = mod.server;
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});

after(async () => {
  for (const [, job] of mod._testing.askJobs) { try { job.turn?.stop?.(); } catch { /* reap */ } }
  if (srv) {
    await Promise.race([
      new Promise((r) => { srv.close(r); srv.closeAllConnections?.(); }),
      new Promise((r) => { const t = setTimeout(r, 500); t.unref?.(); }),
    ]);
  }
  if (prevHome === undefined) delete process.env.WORCA_HOME; else process.env.WORCA_HOME = prevHome;
  for (const k of ['HOME', 'USERPROFILE']) { if (prevOs[k] === undefined) delete process.env[k]; else process.env[k] = prevOs[k]; }
  delete process.env.WORCA_MOCK;
  closeDbForTests();
  for (const d of [homeDir, osHome]) await rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => {});
});

/** A thread with one assistant message holding a proposed Away mode card. */
async function seedCard(card) {
  const thread = (await (await post('/api/ask/threads', {})).json()).thread;
  await post(`/api/ask/threads/${thread.id}/messages`, { text: 'hello', model: 'claude-opus-5-5', effort: 'high' });
  await waitFor(async () => (await snapshot(thread.id)).messages.some((m) => m.role === 'assistant' && m.status === 'done'));
  const cardId = `card_${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}`;
  store.appendMessage(thread.id, { role: 'assistant', text: '', status: 'done', blocks: [{ kind: 'card', id: cardId, state: 'proposed', card }] });
  return { threadId: thread.id, cardId };
}
const realCard = async (input) => { const r = await validateAwayChange(input); assert.equal(r.ok, true, JSON.stringify(r)); return r.card; };

test('declined, or applied with an unknown project: the card does not apply and nothing is written', async () => {
  await checkRows([
    { name: 'Keep as is (declined) leaves the settings untouched', run: async () => {
      const { threadId, cardId } = await seedCard(await realCard({ level: 'user', set: { graceMinutes: 12 } }));
      const r = await post(`/api/ask/threads/${threadId}/cards/${cardId}`, { state: 'declined' });
      assert.equal(r.status, 200, await r.clone().text());
      assert.equal((await r.json()).block.state, 'declined');
      assert.equal((await get('/api/away-mode')).user.graceMinutes, undefined);
    } },
    { name: 'a project card with an unknown project fails, and nothing is written', run: async () => {
      const before = await get('/api/away-mode');
      const { threadId, cardId } = await seedCard({ type: 'away', level: 'project', projectKey: 'nope-00000000', projectName: null, set: { enabled: true }, unset: [], changes: [], summary: 'Which runs: All runs', before: [], after: [], note: '' });
      const j = await (await post(`/api/ask/threads/${threadId}/cards/${cardId}`, { state: 'applied' })).json();
      assert.equal(j.block.state, 'failed');
      assert.match(j.block.error, /unknown project "nope-00000000"/);
      assert.deepEqual((await get('/api/away-mode')).user, before.user);
    } },
  ]);
});

test('a user-level card applied writes the user layer; GET /api/away-mode shows it', async () => {
  const { threadId, cardId } = await seedCard(await realCard({ level: 'user', set: { enabled: true }, unset: [] }));
  const r = await post(`/api/ask/threads/${threadId}/cards/${cardId}`, { state: 'applied' });
  assert.equal(r.status, 200, await r.clone().text());
  const j = await r.json();
  assert.equal(j.block.state, 'applied');
  assert.match(j.block.card.result.detail, /^(Right now|No away hours)/);
  assert.equal((await get('/api/away-mode')).config.enabled, true);
});

test('a project-level card writes under the key the reader uses', async () => {
  const { threadId, cardId } = await seedCard(await realCard({ level: 'project', projectKey: project.key, set: { graceMinutes: 45 } }));
  const j = await (await post(`/api/ask/threads/${threadId}/cards/${cardId}`, { state: 'applied' })).json();
  assert.equal(j.block.state, 'applied', JSON.stringify(j.block));
  const a = await get(`/api/away-mode?projectDir=${encodeURIComponent(project.path)}`);
  assert.equal(a.sources.graceMinutes, 'project');
  assert.equal(a.config.graceMinutes, 45);
});
