// src/shared/speech.mjs
// Ask Worca voice mode (docs/speech.md): pure helpers shared by the browser
// (served from /src/shared) and the server (the STT connection test sends a
// silent WAV). No DOM, no Node APIs, no module state.

const FENCE_RE = /^\s*(```|~~~)/;
const URL_RE = /\bhttps?:\/\/[^\s)>\]]*[^\s)>\].,;:!?'"]/gi;
const ABBREV_RE = /(^|\s)(e\.g|i\.e|etc|vs|mr|mrs|ms|dr|st|no|approx)\.$/i;
const SENTENCE_END_RE = /[.!?…]+["')\]]*\s+/g;
const INLINE_CODE_MAX = 32;

/** One line fragment of markdown → plain speakable text (inline syntax only). */
export function speakableInline(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(URL_RE, ' ')
    .replace(/`([^`]+)`/g, (_, c) => (c.length <= INLINE_CODE_MAX ? c : ' '))
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/[*`#>|]+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A whole markdown line → { text, breakAfter }; breakAfter ends the sentence at the line end. */
function lineToSpeech(line) {
  const t = line.trim();
  if (!t) return { text: '', breakAfter: true };
  if (t.startsWith('|') || /^(-{3,}|\*{3,}|_{3,})$/.test(t)) return { text: '', breakAfter: true };
  const heading = t.match(/^#{1,6}\s+(.*)$/);
  if (heading) return { text: speakableInline(heading[1]), breakAfter: true };
  const isItem = /^([-*+]|\d+[.)])\s+/.test(t);
  const body = t.replace(/^>\s?/, '').replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '');
  return { text: speakableInline(body), breakAfter: isItem };
}

/**
 * Streaming sentence chunker. push(rawSoFar, final?) takes the WHOLE accumulated
 * markdown each time and returns the sentences completed since the last call.
 * Invariants: nothing is spoken twice; a fence's or table's content is never
 * spoken; a partial line that could still become a fence/table waits.
 */
export function createSpeechChunker({ maxChars = 280 } = {}) {
  let seen = '';
  let inFence = false;
  let midLine = false;
  let pending = '';
  let out = [];

  const emit = (s) => { const t = s.trim(); if (t && /[\p{L}\p{N}]/u.test(t)) out.push(t); };

  function splitPending(final) {
    SENTENCE_END_RE.lastIndex = 0;
    let last = 0;
    let m;
    while ((m = SENTENCE_END_RE.exec(pending))) {
      const end = m.index + m[0].length;
      if (ABBREV_RE.test(pending.slice(last, end).trim())) continue;
      emit(pending.slice(last, end));
      last = end;
    }
    pending = pending.slice(last);
    while (pending.length > maxChars) {
      const head = pending.slice(0, maxChars);
      const cut = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '));
      const at = cut > maxChars / 3 ? cut + 1 : Math.max(head.lastIndexOf(' '), 1);
      emit(pending.slice(0, at));
      pending = pending.slice(at).trimStart();
    }
    if (final) { emit(pending); pending = ''; }
  }

  function take(piece, lineEnded) {
    if (!midLine && FENCE_RE.test(piece)) { inFence = !inFence; midLine = !lineEnded; return; }
    if (inFence) { midLine = !lineEnded; return; }
    const { text, breakAfter } = midLine ? { text: speakableInline(piece), breakAfter: false } : lineToSpeech(piece);
    const tail = lineEnded || /\s$/.test(piece) ? ' ' : '';
    if (text) pending += (pending && !/\s$/.test(pending) ? ' ' : '') + text + tail;
    splitPending(false);
    if (lineEnded && breakAfter && pending.trim()) {
      const p = pending.trim();
      emit(/[.!?…:]$/.test(p) ? p : `${p}.`);
      pending = '';
    }
    midLine = !lineEnded;
  }

  function realign(raw) {
    seen = raw;
    pending = '';
    inFence = raw.split('\n').filter((l) => FENCE_RE.test(l)).length % 2 === 1;
    midLine = raw.length > 0 && !raw.endsWith('\n');
  }

  function push(raw, final = false) {
    out = [];
    const text = String(raw ?? '');
    if (!text.startsWith(seen)) {
      if (seen.startsWith(text)) { if (final) splitPending(true); return out; }   // replay rewind: wait until it catches up
      realign(text);                               // diverged (adoption heal): skip ahead
      return out;
    }
    let rest = text.slice(seen.length);
    while (rest) {
      const nl = rest.indexOf('\n');
      if (nl < 0 && !final) {
        if (inFence) break;
        if (!midLine && /^\s*([`~|]|$)/.test(rest)) break;   // could still open a fence/table
        let cut = -1;
        SENTENCE_END_RE.lastIndex = 0;
        for (let m; (m = SENTENCE_END_RE.exec(rest));) cut = m.index + m[0].length;
        if (cut < 0) break;
        take(rest.slice(0, cut), false);
        seen += rest.slice(0, cut);
        rest = rest.slice(cut);
        break;
      }
      const line = nl < 0 ? rest : rest.slice(0, nl);
      take(line, true);
      seen += nl < 0 ? rest : rest.slice(0, nl + 1);
      rest = nl < 0 ? '' : rest.slice(nl + 1);
    }
    if (final) splitPending(true);
    return out;
  }

  return { push };
}

/** Whole-document convenience (tests, and any non-streaming use). */
export function speakableText(md) {
  return createSpeechChunker().push(String(md ?? ''), true).join(' ');
}

/** Float32 mono samples in [-1, 1] → 16-bit PCM WAV bytes. */
export function encodeWav(samples, sampleRate = 16000) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, Number(samples[i]) || 0));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

/** whisper.cpp / Whisper non-speech markers ("[BLANK_AUDIO]", "(silence)", "[ Music ]") → ''. */
export function cleanTranscript(t) {
  return String(t ?? '').replace(/\[[^\]]*\]|\((?:silence|music|noise|inaudible)[^)]*\)/gi, ' ').replace(/\s+/g, ' ').trim();
}
