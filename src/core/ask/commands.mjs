// src/core/ask/commands.mjs
// Ask agent mode (#574): the server half of run_command / read_output / wait_for / stop_command /
// list_blocks. Ask owns its terminal sessions (never a person's): a pool of at most
// ASK_LIMITS.commandsPerThread per chat, opened through the TerminalManager so every command is a
// recorded block (source 'ask', run_by 'ask:<threadId>') that shows live in the pane. A block's end
// wakes the chat (onFinish → the event turn) unless the model already saw it.
import { checkAskCommand, askCommandEnv } from './command-policy.mjs';
import { ASK_LIMITS } from './limits.mjs';
import { stripAnsi } from '../terminal/markers.mjs';
import { sameDir } from '../terminal/same-dir.mjs';
import { redactAskText } from './redact.mjs';

const BLOCK_ID_RE = /^(t-[0-9a-f]{10}):(\d{1,9})$/;
const codeError = (code, message) => Object.assign(new Error(message), { code });
export const askActor = (threadId) => `ask:${threadId}`;
export const blockIdOf = (sessionId, seq) => `${sessionId}:${seq}`;

export function parseBlockId(id) {
  const m = BLOCK_ID_RE.exec(String(id ?? '').trim());
  return m ? { sessionId: m[1], seq: Number(m[2]) } : null;
}

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const eventText = (s, n) => clip(s, n).replace(/"/g, "'").replace(/\[(\/?)worca context\]/gi, '($1worca context)');

/** `[worca event] terminal block <id> exited <code>` — the event turn's prompt (issue #574). */
export function terminalEventPrompt(b) {
  const code = b.exitCode == null ? 'unknown' : String(b.exitCode);
  const why = b.status === 'stopped'
    ? (b.stoppedBy === 'ask:cap' ? '; stopped at the 30-minute cap' : `; stopped by ${String(b.stoppedBy || '').startsWith('ask:') ? 'Ask' : 'the user'}`)
    : b.status === 'interrupted' ? '; Worca restarted while it ran' : '';
  return `[worca event] terminal block ${blockIdOf(b.sessionId, b.seq)} exited ${code}${why}; "${eventText(b.command, 200)}"`;
}
export function terminalNoticeText(b) {
  const code = b.exitCode == null ? '' : ` (exit ${b.exitCode})`;
  return `${b.status === 'stopped' ? 'Command stopped' : 'Command finished'}${code} — ${clip(b.command, 80)}`;
}

/** Card-facing view of a block: state + redacted, ANSI-free tail. */
export function commandView(rec, out, { tailChars = ASK_LIMITS.commandCardTailChars } = {}) {
  const text = redactAskText(stripAnsi(String(out ?? '')));
  return { blockId: blockIdOf(rec.sessionId, rec.seq), sessionId: rec.sessionId, seq: rec.seq, command: redactAskText(rec.command),
    status: rec.status, exitCode: rec.exitCode ?? null, startedAt: rec.startedAt ?? null, endedAt: rec.endedAt ?? null,
    durationMs: rec.durationMs ?? null, stoppedBy: rec.stoppedBy ?? null, runBy: rec.runBy ?? null,
    tail: text.length > tailChars ? text.slice(-tailChars) : text, truncated: text.length > tailChars || !!rec.truncated };
}

/**
 * @param {object} o
 * @param {import('../terminal/manager.mjs').TerminalManager} o.terminals
 * @param {{getBlock:Function, listRecentBlocks:Function}} o.store   src/core/terminal/store.mjs
 * @param {(threadId:string, input:object) => Promise<object>} o.resolveTarget   {cwd, scope, label, runId, member, projectKey, branch, workspace, runLive, warning, actionSnaps}
 * @param {(threadId:string, block:object) => void} o.onFinish   always called when an Ask block ends; the server
 *        skips the event turn at start time when seen(blockId) is true
 * @param {(threadId:string, view:object) => void} [o.onUpdate]   the ask-command frame
 * @param {(threadId:string, target:object) => void} [o.onOpen]   once per new Ask session (the run audit line)
 * @param {(threadId:string) => string} [o.threadTitle]
 * @param {number|(() => number|null)|null} [o.serverPort]   a function: the port is known only once the server listens
 * @param {string|(() => string|null)|null} [o.home]   the worca home (protected in commands); a function is read at use
 * @param {string|null} [o.userHome]   what `~` expands to in Ask's shells (default: baseEnv.HOME), for the home-only paths
 */
export function createAskCommands({ terminals, store, resolveTarget, onFinish, onUpdate = () => {}, onOpen = () => {}, threadTitle = () => '',
  hostPid = process.pid, serverPort = null, home = null, baseEnv = process.env, userHome = baseEnv.HOME || null, limits = ASK_LIMITS,
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, clearTimer = clearTimeout } = {}) {
  const pools = new Map();     // threadId → Set<sessionId>
  const owner = new Map();     // sessionId → threadId
  const active = new Map();    // blockId → { threadId, capTimer }
  const seenEnd = new Set();   // blockIds whose end a tool already returned to the model (pruned at SEEN_KEEP)
  const idleTimers = new Map();// sessionId → timer
  const lastPush = new Map();  // blockId → ms (tail frames, throttled)
  const trailing = new Map();  // blockId → timer (the last frame of a burst)
  const SEEN_KEEP = 500;

  const threadOfRunBy = (runBy) => (typeof runBy === 'string' && runBy.startsWith('ask:') && runBy !== 'ask:cap' ? runBy.slice(4) : null);
  const runningCount = (threadId) => [...active.values()].filter((a) => a.threadId === threadId).length;
  const portNow = () => (typeof serverPort === 'function' ? serverPort() : serverPort);
  const homeNow = () => (typeof home === 'function' ? home() : home);
  const markSeen = (id) => { seenEnd.add(id); if (seenEnd.size > SEEN_KEEP) seenEnd.delete(seenEnd.values().next().value); };

  terminals.on('block', (rec) => {
    if (rec.source !== 'ask') return;
    const threadId = threadOfRunBy(rec.runBy);
    if (!threadId) return;
    const id = blockIdOf(rec.sessionId, rec.seq);
    if (rec.status === 'running') {
      // The slot and the cap timer are taken HERE, not after runCommand resolves: the manager handles every mark
      // of one data chunk synchronously (`_onData` loops `_onMark`, manager.mjs:198), so a fast command's start AND
      // end can both be emitted before run()'s await continues. Registering in run() would then leak a never-ending
      // "active" entry (the chat locks at TOO_MANY) and a cap timer that interrupts a later command in that session.
      const { sessionId: sid, seq } = rec;
      active.set(id, { threadId, capTimer: setTimer(() => {
        const lb = terminals.liveBlock(sid);
        if (lb && lb.seq === seq) terminals.interrupt(sid, 'ask:cap');      // only the block this timer belongs to
      }, limits.commandMaxMs) });
      onUpdate(threadId, commandView(rec, ''));
      return;
    }
    const a = active.get(id);
    if (a) { clearTimer(a.capTimer); active.delete(id); }
    lastPush.delete(id);
    clearTimer(trailing.get(id)); trailing.delete(id);
    // The manager's block event never carries output: the finished block's output is in the store.
    onUpdate(threadId, commandView(rec, store.getBlock(rec.sessionId, rec.seq)?.output ?? ''));
    scheduleIdleClose(rec.sessionId);
    try { onFinish(threadId, rec); } catch { /* a failed wake never breaks the terminal */ }
  });

  // Live tail for the card: at most one frame per block per 500 ms, plus a trailing frame so the last output of a
  // burst (a dev server's "ready" line, then silence) reaches the card.
  const pushLive = (sessionId, threadId) => {
    const lb = terminals.liveBlock(sessionId);
    if (!lb) return;
    lastPush.set(blockIdOf(sessionId, lb.seq), Date.now());
    onUpdate(threadId, commandView({ ...lb, status: 'running' }, lb.out));
  };
  terminals.on('data', ({ sessionId }) => {
    const threadId = owner.get(sessionId);
    const lb = threadId ? terminals.liveBlock(sessionId) : null;
    if (!lb) return;
    const id = blockIdOf(sessionId, lb.seq);
    if (Date.now() - (lastPush.get(id) || 0) >= 500) { pushLive(sessionId, threadId); return; }
    if (!trailing.has(id)) trailing.set(id, setTimer(() => { trailing.delete(id); pushLive(sessionId, threadId); }, 500));
  });

  function scheduleIdleClose(sessionId) {
    clearTimer(idleTimers.get(sessionId));
    idleTimers.set(sessionId, setTimer(() => {
      idleTimers.delete(sessionId);
      if (terminals.free(sessionId)) terminals.close(sessionId, `ask:${owner.get(sessionId) || ''}`, 'Ask: idle').catch(() => {});
    }, limits.commandSessionIdleMs));
  }

  async function drop(threadId, sid, reason) {
    pools.get(threadId)?.delete(sid); owner.delete(sid);
    clearTimer(idleTimers.get(sid)); idleTimers.delete(sid);
    await terminals.close(sid, askActor(threadId), reason).catch(() => {});
  }

  async function sessionFor(threadId, target) {
    const pool = pools.get(threadId) || new Set();
    pools.set(threadId, pool);
    for (const sid of [...pool]) if (!terminals.get(sid) || terminals.get(sid).status !== 'running') { pool.delete(sid); owner.delete(sid); }
    // Reuse only a free session whose shell is STILL in the target folder: a `cd` in an earlier line persists.
    for (const sid of pool) if (terminals.free(sid) && sameDir(terminals.cwdOf(sid), target.cwd)) return sid;
    if (pool.size >= limits.commandsPerThread) {                       // all slots used, some free elsewhere: recycle one
      const freeSid = [...pool].find((sid) => terminals.free(sid));
      if (freeSid) await drop(threadId, freeSid, 'Ask: another folder');
    }
    const title = clip(threadTitle(threadId) || 'chat', 40);
    const s = await terminals.open({ cwd: target.cwd, scope: target.scope, label: `Ask · ${title} · ${target.label}`,
      runId: target.runId ?? null, member: target.member ?? null, projectKey: target.projectKey ?? null, branch: target.branch ?? null,
      workspace: !!target.workspace, runLive: !!target.runLive, actionSnaps: target.actionSnaps || [],
      by: askActor(threadId), agent: true, baseEnv: askCommandEnv(baseEnv) });
    pool.add(s.id); owner.set(s.id, threadId);
    try { onOpen(threadId, target); } catch { /* audit only */ }
    return s.id;
  }

  /** Any recorded block (shared blocks): only the id's shape is checked here; stop() checks ownership. */
  function refOf(blockId, tool) {
    const ref = parseBlockId(blockId);
    if (!ref) throw codeError('BAD_BLOCK', `${tool}: blockId must look like t-0123456789:4 (from run_command or list_blocks)`);
    return ref;
  }

  function blockState(ref) {
    const lb = terminals.liveBlock(ref.sessionId);
    if (lb && lb.seq === ref.seq) return { rec: { ...lb, status: 'running' }, out: lb.out };
    const rec = store.getBlock(ref.sessionId, ref.seq);
    return rec ? { rec, out: rec.output ?? '' } : null;
  }

  return {
    seen: (blockId) => seenEnd.has(blockId),

    async run(threadId, input = {}) {
      if (runningCount(threadId) >= limits.commandsPerThread) {
        throw codeError('TOO_MANY', `${limits.commandsPerThread} commands are already running in this chat — wait for one (wait_for) or stop one (stop_command).`);
      }
      const target = await resolveTarget(threadId, input);
      const why = checkAskCommand(input.command, { cwd: target.cwd, home: homeNow(), userHome, hostPid, serverPort: portNow() });
      if (why) throw codeError('BLOCKED', why);
      const line = String(input.command).trim();
      const type = (sid) => terminals.runCommand(sid, line, { by: askActor(threadId), source: 'ask', cwd: target.cwd });
      let sid = await sessionFor(threadId, target);
      clearTimer(idleTimers.get(sid)); idleTimers.delete(sid);
      let seq;
      try {
        try { ({ seq } = await type(sid)); }
        catch (e) {
          if (e?.code !== 'MOVED') throw e;
          // The W mark landed after the pick (a `cd` in the previous line): this shell is elsewhere. Close it and
          // run in a fresh one, once.
          await drop(threadId, sid, 'Ask: shell left the folder');
          sid = await sessionFor(threadId, target);
          ({ seq } = await type(sid));
        }
      } catch (e) { if (owner.has(sid)) scheduleIdleClose(sid); throw e; }   // NOT_STARTED / BUSY: still closes when idle
      const blockId = blockIdOf(sid, seq);       // the slot + cap timer were taken by the block 'running' handler
      return { ok: true, blockId, sessionId: sid, seq, command: String(input.command).trim(), cwd: target.cwd,
        folder: target.label, warning: target.warning || null };
    },

    async read(threadId, { blockId, offset = 0, maxChars = limits.commandOutputPageChars } = {}) {
      const ref = refOf(blockId, 'read_output');
      const st = blockState(ref);
      if (!st) throw codeError('NOT_FOUND', 'read_output: no such block');
      const text = stripAnsi(String(st.out));
      const start = Math.max(0, Math.min(Number(offset) || 0, text.length));
      const page = text.slice(start, start + Math.max(1, Math.min(maxChars, limits.commandOutputPageChars)));
      if (st.rec.status !== 'running') markSeen(blockIdOf(ref.sessionId, ref.seq));
      return { blockId: blockIdOf(ref.sessionId, ref.seq), command: redactAskText(st.rec.command), status: st.rec.status, exitCode: st.rec.exitCode ?? null,
        text: page, offset: start, nextOffset: start + page.length < text.length ? start + page.length : null, totalChars: text.length,
        truncatedAtStart: !!st.rec.truncated, runBy: st.rec.runBy ?? null };
    },

    async wait(threadId, { blockId, match = null, timeoutSec = limits.commandWaitDefaultSec, pollMs = 250, signal = null } = {}) {
      const ref = refOf(blockId, 'wait_for');
      const id = blockIdOf(ref.sessionId, ref.seq);
      const deadline = Date.now() + Math.min(Math.max(Number(timeoutSec) || 0, 0), limits.commandWaitMaxSec) * 1000;
      for (;;) {
        const st = blockState(ref);
        if (!st) throw codeError('NOT_FOUND', 'wait_for: no such block');
        const text = stripAnsi(String(st.out));
        const tail = text.slice(-2000);
        if (st.rec.status !== 'running') {
          markSeen(id);
          return { blockId: id, status: st.rec.status, exitCode: st.rec.exitCode ?? null, matched: match ? text.includes(match) : null, timedOut: false, tail };
        }
        if (match && text.includes(match)) return { blockId: id, status: 'running', exitCode: null, matched: true, timedOut: false, tail };
        if (Date.now() >= deadline || signal?.aborted) return { blockId: id, status: 'running', exitCode: null, matched: match ? false : null, timedOut: true, tail };
        await new Promise((r) => setTimeout(r, pollMs));
      }
    },

    stop(threadId, { blockId } = {}) {
      const ref = refOf(blockId, 'stop_command');
      const lb = terminals.liveBlock(ref.sessionId);
      if (!lb || lb.seq !== ref.seq) return { ok: true, alreadyEnded: true };
      if (owner.get(ref.sessionId) !== threadId) throw codeError('NOT_OWNER', 'stop_command: Ask stops only its own commands; ask the user to stop this one.');
      terminals.interrupt(ref.sessionId, askActor(threadId));
      return { ok: true, stopping: true };
    },

    list(threadId, { runId = null, projectKey = null, limit = 20 } = {}) {
      const rows = store.listRecentBlocks({ runId, projectKey, limit: Math.min(Math.max(Number(limit) || 20, 1), 50) });
      return { blocks: rows.map((b) => ({ blockId: blockIdOf(b.sessionId, b.seq), command: redactAskText(b.command), status: b.status,
        exitCode: b.exitCode ?? null, startedAt: b.startedAt, durationMs: b.durationMs ?? null, cwd: b.cwd ?? null,
        runId: b.runId ?? null, by: b.source === 'ask' ? 'ask' : 'person', mine: threadOfRunBy(b.runBy) === threadId })) };
    },

    /** For the card's hydration after a reload. */
    view(blockId) {
      const ref = parseBlockId(blockId);
      const st = ref && blockState(ref);
      return st ? commandView({ ...st.rec, sessionId: ref.sessionId, seq: ref.seq }, st.out) : null;
    },

    async closeThread(threadId) {
      const pool = pools.get(threadId);
      pools.delete(threadId);
      for (const [id, a] of active) if (a.threadId === threadId) { clearTimer(a.capTimer); active.delete(id); }
      await Promise.allSettled([...(pool || [])].map((sid) => { owner.delete(sid); clearTimer(idleTimers.get(sid)); idleTimers.delete(sid); return terminals.close(sid, askActor(threadId), 'Ask: chat deleted'); }));
    },

    /** Server shutdown / tests: drop every timer. */
    dispose() {
      for (const a of active.values()) clearTimer(a.capTimer);
      for (const t of idleTimers.values()) clearTimer(t);
      for (const t of trailing.values()) clearTimer(t);
      active.clear(); idleTimers.clear(); trailing.clear();
    },
  };
}
