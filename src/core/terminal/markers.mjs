// src/core/terminal/markers.mjs — read worca's shell-integration markers out of a terminal stream
// (issue #573). The rc snippets (rc/worca.bash, rc/zshrc.zsh) print OSC 133 marks that carry this
// session's nonce: A = prompt, C;<base64 command> = a command starts, D;<exit> = it ended,
// W;<base64 folder> = the shell's folder. What arrives between C and D is the command's output.
// A mark without the session's nonce is not ours (a `cat` of a file holding one, another tool's own
// shell integration): it stays in the output as text, so output can never forge a block or an audit row.
// The raw stream still goes to xterm unchanged: xterm ignores these OSCs.
const ESC = '\x1b';
const BEL = '\x07';
const OSC = `${ESC}]`;
const CAN = '\x18';
const SUB = '\x1a';
const MAX_PENDING = 8192;   // an unterminated OSC longer than this is not one of ours: flush it as text
// …unless it opens with this session's nonce: a C mark carries the whole command line in base64, and a
// long one (a pasted script) arrives over many chunks. Still bounded, so a runaway OSC cannot grow memory.
const MAX_MARK_PENDING = 1024 * 1024;

export function decodeB64(b64) {
  return Buffer.from(String(b64 || ''), 'base64').toString('utf8');
}

/** One OSC body (between `ESC ]` and its terminator) → a mark, or null when it is not ours. */
export function parseMark(body, nonce) {
  if (!nonce || !body.startsWith('133;')) return null;
  const [, kind, n, ...rest] = body.split(';');
  if (n !== nonce) return null;
  const arg = rest.join(';');
  if (kind === 'A' && !rest.length) return { type: 'prompt' };
  if (kind === 'C') return { type: 'start', command: decodeB64(arg) };
  if (kind === 'D') {
    if (!rest.length || arg === '') return { type: 'end', exitCode: null };
    return /^-?\d+$/.test(arg) ? { type: 'end', exitCode: Number(arg) } : null;
  }
  if (kind === 'W' && arg) return { type: 'cwd', cwd: decodeB64(arg) };
  return null;
}

/**
 * The OSC terminator (BEL or ESC \) at or after `from`, or null if the chunk ends first. As in xterm, an
 * ESC that does not start ST, or a CAN/SUB, cuts the OSC off (`aborted`): parsing goes on from there, so
 * a cut-off OSC in a command's output (a program killed mid-title, `printf '\e]'`) cannot swallow the
 * shell's next real mark and lose the command's exit code.
 */
function oscEnd(s, from) {
  for (let k = from; k < s.length; k++) {
    const c = s[k];
    if (c === BEL) return { bodyEnd: k, next: k + 1 };
    if (c === CAN || c === SUB) return { next: k, aborted: true };
    if (c === ESC) {
      if (k + 1 >= s.length) return null;
      if (s[k + 1] === '\\') return { bodyEnd: k, next: k + 2 };
      return { next: k, aborted: true };
    }
  }
  return null;
}

export class MarkerParser {
  constructor({ nonce } = {}) {
    this.nonce = nonce || null;
    this.pending = '';      // an OSC (or a lone ESC) cut by a chunk boundary
    this.scanned = 0;       // how much of `pending` was already searched for a terminator
    this.inCommand = false;
    this.seen = false;      // any of our marks yet: the shell has worca's integration
  }

  /** Feed one chunk of terminal output; returns the events it completes, in order. */
  push(chunk) {
    const events = [];
    const s = this.pending + String(chunk);
    // A held OSC starts at 0; its terminator search resumes where the last one stopped (one char back: a
    // final ESC there may be completed by this chunk's `\`), so a long mark is not rescanned per chunk.
    const resume = this.scanned;
    this.pending = '';
    this.scanned = 0;
    let text = '';
    let i = 0;
    while (i < s.length) {
      const j = s.indexOf(OSC, i);
      if (j < 0) {
        const cut = s.endsWith(ESC) ? 1 : 0;              // a final ESC may open the next chunk's OSC
        text += s.slice(i, s.length - cut);
        if (cut) this.pending = ESC;
        break;
      }
      text += s.slice(i, j);
      const end = oscEnd(s, j === 0 ? Math.max(2, resume - 1) : j + 2);
      if (!end) {
        const rest = s.slice(j);
        if (rest.length > (this.#ownMark(rest) ? MAX_MARK_PENDING : MAX_PENDING)) text += rest;
        else { this.pending = rest; this.scanned = rest.length; }
        break;
      }
      if (end.aborted) {                     // not a complete OSC: keep it as text, parse on from the ESC/CAN
        text += s.slice(j, end.next);
        i = end.next;
        continue;
      }
      const mark = parseMark(s.slice(j + 2, end.bodyEnd), this.nonce);
      if (mark) {
        this.#output(text, events);
        text = '';
        this.#apply(mark, events);
      } else {
        text += s.slice(j, end.next);
      }
      i = end.next;
    }
    this.#output(text, events);
    return events;
  }

  /** An unterminated OSC that opens like one of this session's marks: `ESC ] 133 ; <kind> ; <nonce> ;`. */
  #ownMark(rest) {
    if (!this.nonce || !rest.startsWith(`${OSC}133;`)) return false;
    const [, , n] = rest.slice(2, 2 + 16 + this.nonce.length).split(';');
    return n === this.nonce;
  }

  #output(text, events) {
    if (text && this.inCommand) events.push({ type: 'output', text });
  }

  #apply(mark, events) {
    this.seen = true;
    if (mark.type === 'start') {
      if (this.inCommand) events.push({ type: 'end', exitCode: null });   // D never came
      this.inCommand = true;
      events.push(mark);
      return;
    }
    if (mark.type === 'end') {
      if (!this.inCommand) return;                                        // the first prompt's D
      this.inCommand = false;
      events.push(mark);
      return;
    }
    events.push(mark);
  }
}

/** Plain text of a block's output: OSC, CSI and two-byte escapes removed. */
export function stripAnsi(s) {
  return String(s || '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '');
}
