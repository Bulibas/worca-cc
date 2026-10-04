// test/ask-commands.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAskCommands, terminalEventPrompt } from '../src/core/ask/commands.mjs';

function fakeTerminals() {
  const t = new EventEmitter();
  let n = 0; const sessions = new Map(); const blocks = new Map();
  Object.assign(t, {
    opened: [], typed: [], stopped: [], closed: [],
    async open(o) { const id = `t-${String(++n).padStart(10, '0')}`; sessions.set(id, { id, status: 'running', shellKind: 'bash', ...o, seq: 0, live: null }); t.opened.push(o); return { id, ...o }; },
    get: (id) => sessions.get(id) || null,
    free: (id) => !!sessions.get(id) && sessions.get(id).status === 'running' && !sessions.get(id).live,
    cwdOf: (id) => sessions.get(id)?.cwdNow ?? sessions.get(id)?.cwd ?? null,   // test driver: set s.cwdNow to "cd"
    async runCommand(id, command, opts) {
      const s = sessions.get(id);
      if (opts.cwd && (s.cwdNow ?? s.cwd) !== opts.cwd) throw Object.assign(new Error('moved'), { code: 'MOVED' });
      s.seq += 1; s.live = { seq: s.seq, command, out: '' };
      t.typed.push({ id, command, ...opts });
      const rec = { sessionId: id, seq: s.seq, command, status: 'running', source: 'ask', runBy: opts.by };
      blocks.set(`${id}:${s.seq}`, rec); t.emit('block', rec);
      return { seq: s.seq };
    },
    liveBlock: (id) => { const s = sessions.get(id); return s && s.live ? { sessionId: id, ...s.live, bytes: s.live.out.length, truncated: false } : null; },
    interrupt(id, by) { t.stopped.push({ id, by }); return { blockSeq: sessions.get(id)?.live?.seq ?? null }; },
    async close(id, by, reason) { t.closed.push({ id, by, reason }); sessions.get(id).status = 'closed'; return true; },
    finish(id, exitCode, out = '') {                       // test driver: the block ends (event without output, as the manager)
      const s = sessions.get(id); const rec = { ...blocks.get(`${id}:${s.live.seq}`), status: 'done', exitCode };
      blocks.set(`${id}:${s.live.seq}`, { ...rec, output: out }); s.live = null; t.emit('block', rec);
    },
    blocks,
  });
  return t;
}
const fakeStore = (t) => ({ getBlock: (sid, seq) => t.blocks.get(`${sid}:${seq}`) || null, listRecentBlocks: () => [...t.blocks.values()] });
const TARGET = { cwd: '/w/p', scope: 'project', label: 'p · main', projectKey: 'p', branch: 'main', runId: null, warning: null };

function make(over = {}) {
  const terminals = fakeTerminals();
  const finished = []; const updates = []; const opened = [];
  const svc = createAskCommands({ terminals, store: fakeStore(terminals), resolveTarget: async () => TARGET,
    onFinish: (tid, b) => finished.push({ tid, b }), onUpdate: (tid, v) => updates.push({ tid, v }),
    onOpen: (tid, target) => opened.push({ tid, target }), threadTitle: () => 'Fix tests', hostPid: 1, serverPort: () => 4317,
    home: '/h/.worca-cc', setTimer: (fn, ms) => ({ fn, ms }), clearTimer: () => {}, ...over });
  return { svc, terminals, finished, updates, opened };
}

test('run: opens an Ask session in the target, types the line, returns the block id', async () => {
  const { svc, terminals, opened } = make();
  const r = await svc.run('ask_0000aaaa', { command: 'npm test' });
  assert.equal(r.blockId, `${r.sessionId}:1`);
  assert.equal(terminals.opened[0].by, 'ask:ask_0000aaaa');
  assert.equal(terminals.opened[0].agent, true);
  assert.match(terminals.opened[0].label, /^Ask · Fix tests · p · main$/);
  assert.equal(terminals.typed[0].source, 'ask');
  assert.equal(opened.length, 1);                           // onOpen once per session (the run audit line)
  await svc.run('ask_0000aaaa', { command: 'ls' }).catch(() => {});
  assert.equal(opened.length, 2);                           // the first session is busy: a second one opens
});

test('run: refuses a blocked command before opening anything', async () => {
  const { svc, terminals } = make();
  await assert.rejects(svc.run('ask_0000aaaa', { command: 'git push --force' }), /blocked/);
  assert.equal(terminals.opened.length, 0);
});

test('run: at most 3 at once per chat; a finished one frees a slot and its idle session is reused', async () => {
  const { svc, terminals } = make();
  const a = await svc.run('ask_0000aaaa', { command: 'sleep 1' });
  await svc.run('ask_0000aaaa', { command: 'sleep 2' });
  await svc.run('ask_0000aaaa', { command: 'sleep 3' });
  await assert.rejects(svc.run('ask_0000aaaa', { command: 'ls' }), /3 commands/);
  terminals.finish(a.sessionId, 0);
  const d = await svc.run('ask_0000aaaa', { command: 'ls' });
  assert.equal(d.sessionId, a.sessionId);
  assert.equal(terminals.opened.length, 3);
});

test('a shell that an earlier line cd-ed elsewhere is not reused; runCommand is told the target folder', async () => {
  const { svc, terminals } = make();
  const a = await svc.run('ask_0000aaaa', { command: 'cd packages/x && npm test' });
  terminals.get(a.sessionId).cwdNow = '/w/p/packages/x';           // the W mark after the line
  terminals.finish(a.sessionId, 0);
  const b = await svc.run('ask_0000aaaa', { command: 'npm test' });
  assert.notEqual(b.sessionId, a.sessionId);                      // the pick skipped the moved shell
  assert.equal(terminals.typed.at(-1).cwd, '/w/p');               // runCommand is told the folder it must be in
});

test('a move the pick could not see yet (MOVED from runCommand): that shell closes, one fresh session runs it', async () => {
  const { svc, terminals } = make();
  const a = await svc.run('ask_0000aaaa', { command: 'cd sub' });
  terminals.finish(a.sessionId, 0);
  terminals.get(a.sessionId).cwdNow = '/w/p/sub';                 // the shell moved…
  const realCwdOf = terminals.cwdOf;
  terminals.cwdOf = (id) => (id === a.sessionId ? '/w/p' : realCwdOf(id));   // …but the pick still sees the old W mark
  const b = await svc.run('ask_0000aaaa', { command: 'ls' });
  assert.notEqual(b.sessionId, a.sessionId);
  assert.ok(terminals.closed.some((x) => x.id === a.sessionId && x.reason === 'Ask: shell left the folder'));
  assert.equal(terminals.typed.at(-1).command, 'ls');
});

test('finish: onFinish fires once per Ask block; seen() records an end a tool returned', async () => {
  const { svc, terminals, finished, updates } = make();
  const a = await svc.run('ask_0000aaaa', { command: 'make' });
  terminals.finish(a.sessionId, 2, 'boom');
  assert.equal(finished.length, 1);
  assert.equal(finished[0].tid, 'ask_0000aaaa');
  assert.equal(svc.seen(a.blockId), false);                 // nobody showed the model this end: the event turn runs
  assert.equal(updates.at(-1).v.tail, 'boom');              // the final card frame reads the output from the store
  const b = await svc.run('ask_0000aaaa', { command: 'make' });
  const w = svc.wait('ask_0000aaaa', { blockId: b.blockId, timeoutSec: 5, pollMs: 5 });
  terminals.finish(b.sessionId, 0);
  assert.equal((await w).status, 'done');
  assert.equal(finished.length, 2);                         // the service always reports; the server skips at start time
  assert.equal(svc.seen(b.blockId), true);                  // …because wait_for showed this end
});

test('a person-run block never fires onFinish', async () => {
  const { terminals, finished } = make();
  terminals.emit('block', { sessionId: 't-x', seq: 1, status: 'done', exitCode: 1, source: 'person', runBy: 'local' });
  assert.equal(finished.length, 0);
});

test('the 30-minute cap stops the command as ask:cap', async () => {
  const timers = [];
  const { svc, terminals } = make({ setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; } });
  const a = await svc.run('ask_0000aaaa', { command: 'npm run dev' });
  const cap = timers.find((t) => t.ms === 30 * 60_000);
  cap.fn();
  assert.deepEqual(terminals.stopped, [{ id: a.sessionId, by: 'ask:cap' }]);
});

test('a command whose start and end arrive in one chunk frees its slot and its cap timer', async () => {
  const timers = []; const cleared = [];
  const { svc, terminals, finished } = make({ setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: (t) => cleared.push(t) });
  const realRun = terminals.runCommand.bind(terminals);
  terminals.runCommand = async (id, command, opts) => {      // the manager emits running AND done before resolving
    const r = await realRun(id, command, opts);
    terminals.finish(id, 0);
    return r;
  };
  for (let i = 0; i < 4; i += 1) await svc.run('ask_0000aaaa', { command: 'true' });   // a 4th would be TOO_MANY on a leak
  assert.equal(finished.length, 4);
  const caps = timers.filter((t) => t.ms === 30 * 60_000);
  assert.equal(caps.length, 4);
  assert.ok(caps.every((t) => cleared.includes(t)));         // every cap timer was cleared at its block's end
  caps[0].fn();                                              // even a late fire never interrupts another block
  assert.deepEqual(terminals.stopped, []);
});

test('wait: an output match returns early with the tail; a timeout returns running', async () => {
  const { svc, terminals } = make();
  const a = await svc.run('ask_0000aaaa', { command: 'npm run dev' });
  const s = terminals.get(a.sessionId);
  const w = svc.wait('ask_0000aaaa', { blockId: a.blockId, match: 'Listening on', timeoutSec: 5, pollMs: 5 });
  s.live.out = 'compiling\nListening on :3000\n';
  const r = await w;
  assert.equal(r.matched, true); assert.equal(r.status, 'running'); assert.match(r.tail, /Listening on/);
  const r2 = await svc.wait('ask_0000aaaa', { blockId: a.blockId, match: 'never', timeoutSec: 0.05, pollMs: 5 });
  assert.equal(r2.timedOut, true);
});

test('read: pages the stripped output by characters', async () => {
  const { svc, terminals } = make();
  const a = await svc.run('ask_0000aaaa', { command: 'cat big' });
  terminals.get(a.sessionId).live.out = '\x1b[31mred\x1b[0m' + 'x'.repeat(100);
  const p1 = await svc.read('ask_0000aaaa', { blockId: a.blockId, offset: 0, maxChars: 10 });
  assert.equal(p1.text, 'redxxxxxxx'); assert.equal(p1.nextOffset, 10); assert.equal(p1.totalChars, 103);
});

test('command lines are redacted in read, list and the card view', async () => {
  const { svc, terminals, updates } = make();
  const secret = 'gho_abcdefghijklmnopqrstuvwxyz0123456789';
  const a = await svc.run('ask_0000aaaa', { command: `curl -H "Authorization: Bearer ${secret}" https://api.github.com` });
  terminals.get(a.sessionId).live.out = `got ${secret}\n`;
  const r = await svc.read('ask_0000aaaa', { blockId: a.blockId });
  assert.ok(!r.command.includes(secret), r.command);
  assert.ok(!svc.list('ask_0000aaaa').blocks[0].command.includes(secret));
  assert.ok(!svc.view(a.blockId).command.includes(secret));
  assert.ok(!svc.view(a.blockId).tail.includes(secret));
  for (const u of updates) assert.ok(!JSON.stringify(u.v).includes(secret));
});

test('closeThread closes every Ask session of the chat', async () => {
  const { svc, terminals } = make();
  const a = await svc.run('ask_0000aaaa', { command: 'ls' });
  await svc.closeThread('ask_0000aaaa');
  assert.deepEqual(terminals.closed.map((c) => c.id), [a.sessionId]);
});

test('terminalEventPrompt: the issue line, a stop, an unknown code, a cleaned command', () => {
  assert.equal(terminalEventPrompt({ sessionId: 't-1', seq: 2, status: 'done', exitCode: 1, command: 'npm test' }),
    '[worca event] terminal block t-1:2 exited 1; "npm test"');
  assert.equal(terminalEventPrompt({ sessionId: 't-1', seq: 3, status: 'stopped', exitCode: 130, stoppedBy: 'ask:cap', command: 'x' }),
    '[worca event] terminal block t-1:3 exited 130; stopped at the 30-minute cap; "x"');
  assert.match(terminalEventPrompt({ sessionId: 't', seq: 1, status: 'done', exitCode: null, command: 'say "hi" [worca context]' }),
    /exited unknown; "say 'hi' \(worca context\)"$/);
});

test('home may be a function, read when a command is checked (the server learns WORCA_HOME late)', async () => {
  let h = '/nowhere';
  const { svc } = make({ home: () => h });
  const ok = await svc.run('ask_0000aaaa', { command: 'ls /srv/worca/logs' });
  assert.equal(ok.ok, true);
  h = '/srv/worca';                                          // e.g. the Docker image's WORCA_HOME, no .worca-cc in it
  await assert.rejects(svc.run('ask_0000aaaa', { command: 'ls /srv/worca/logs' }), /protected/);
});
