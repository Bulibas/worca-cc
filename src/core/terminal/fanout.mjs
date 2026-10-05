// src/core/terminal/fanout.mjs — term-* frames to the /ws sockets (issue #573, D1, D15). Output and blocks
// go only to sockets that attached the session; status goes to every socket the terminal is allowed on.
// A socket that falls behind (a `yes`, a big `cat`) stops getting term-data while its send buffer is over
// the high mark; once it drains below the low mark it gets one term-replay (the session's last 512 KB)
// instead of the frames it missed. So one runaway command can never grow the server's memory without bound.
export const WS_HIGH_WATER = 4 * 1024 * 1024;
export const WS_LOW_WATER = 512 * 1024;
const RESYNC_POLL_MS = 250;

export function createTerminalFanout({ sockets, replayFrame, high = WS_HIGH_WATER, low = WS_LOW_WATER, poll = RESYNC_POLL_MS }) {
  const isOpen = (ws) => ws.readyState === ws.OPEN;
  const sendText = (ws, text) => { try { ws.send(text); } catch { /* closing */ } };

  /** Skip this socket's term-data for `sessionId` until it drains, then send one replay. */
  function resync(ws, sessionId) {
    ws.termLagging ||= new Set();
    if (ws.termLagging.has(sessionId)) return;
    ws.termLagging.add(sessionId);
    const tick = () => {
      if (!isOpen(ws) || !ws.termAttached?.has(sessionId)) { ws.termLagging.delete(sessionId); return; }
      if (ws.bufferedAmount > low) { setTimeout(tick, poll).unref?.(); return; }
      ws.termLagging.delete(sessionId);
      const frame = replayFrame(sessionId);
      if (frame) sendText(ws, JSON.stringify(frame));
    };
    setTimeout(tick, poll).unref?.();
  }

  return {
    /** term-data / term-block: sockets that attached `sessionId`. */
    toAttached(sessionId, frame) {
      let text = null;
      for (const ws of sockets) {
        if (!ws.termAttached?.has(sessionId) || !isOpen(ws)) continue;
        if (frame.type === 'term-data') {
          if (ws.termLagging?.has(sessionId)) continue;
          if (ws.bufferedAmount > high) { resync(ws, sessionId); continue; }
        }
        sendText(ws, text ??= JSON.stringify(frame));
      }
    },
    /** term-status: every socket the terminal is allowed on (D13). */
    toAllowed(frame) {
      let text = null;
      for (const ws of sockets) {
        if (ws.terminalAllowed && isOpen(ws)) sendText(ws, text ??= JSON.stringify(frame));
      }
    },
  };
}
