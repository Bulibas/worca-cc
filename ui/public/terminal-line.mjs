// ui/public/terminal-line.mjs — line editing for a terminal running over pipes (issue #573, D10).
// Without a tty the shell neither echoes nor edits, so the pane does: local echo, Backspace, Ctrl+U,
// Enter sends the line, Ctrl+C asks for Stop. Escape sequences (arrows) are dropped: no history here.
// A pasted CRLF is one line end, not two.
const ESCAPES = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|O.|.)/g;

export function createLineEditor() {
  let buf = [];
  let lastCR = false;
  return {
    feed(data) {
      let echo = '';
      let send = '';
      let interrupt = false;
      for (const ch of String(data).replace(ESCAPES, '')) {
        const crlf = lastCR && ch === '\n';
        lastCR = ch === '\r';
        if (crlf) continue;
        if (ch === '\r' || ch === '\n') { echo += '\r\n'; send += `${buf.join('')}\n`; buf = []; }
        else if (ch === '\x7f' || ch === '\b') { if (buf.length) { buf.pop(); echo += '\b \b'; } }
        else if (ch === '\x15') { echo += '\b \b'.repeat(buf.length); buf = []; }
        else if (ch === '\x03') { interrupt = true; buf = []; echo += '^C\r\n'; }
        else if (ch >= ' ') { buf.push(ch); echo += ch; }
      }
      return { echo, send, interrupt };
    },
    get pending() { return buf.join(''); },
  };
}
