// test/speech-text.test.mjs
// Voice mode's pure helpers: markdown → speakable prose, streaming sentence
// chunking (fences/tables skipped, rewind/divergence never re-speaks), WAV
// encoding, and transcript cleanup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speakableText, createSpeechChunker, encodeWav, cleanTranscript } from '../src/shared/speech.mjs';

test('speakableText strips code, tables, urls, images and markdown syntax', () => {
  const md = [
    '# Result',
    'The run **passed** — see [the log](https://x.example/log) or https://x.example/raw.',
    '',
    '```js',
    'const x = 1.5; // not spoken.',
    '```',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '- first item',
    '- second `plan.md` item',
    '![shot](https://x.example/a.png)',
    'Done.',
  ].join('\n');
  assert.equal(speakableText(md), 'Result. The run passed — see the log or. first item. second plan.md item. Done.');
});

test('long inline code is dropped, short inline code is kept', () => {
  assert.equal(speakableText('Edit `a.mjs` then run `node --test --test-timeout=300000 test/*.mjs` now.'), 'Edit a.mjs then run now.');
});

test('chunker emits complete sentences as text streams in, never inside a fence', () => {
  const c = createSpeechChunker();
  const said = [];
  let acc = '';
  for (const part of ['Hello there. How', ' are you? I am', ' fine.\n```\nx. y. z.\n', '```\nBye', ' now.']) {
    acc += part;
    said.push(...c.push(acc));
  }
  said.push(...c.push(acc, true));
  assert.deepEqual(said, ['Hello there.', 'How are you?', 'I am fine.', 'Bye now.']);
});

test('chunker waits for a partial line that could open a fence or a table', () => {
  const c = createSpeechChunker();
  assert.deepEqual(c.push('Intro.\n`'), ['Intro.']);
  assert.deepEqual(c.push('Intro.\n``` \ncode. more.\n'), []);
  assert.deepEqual(c.push('Intro.\n``` \ncode. more.\n```\n| a. | b. |\nAfter it. '), ['After it.']);
});

test('chunker: abbreviations and decimals do not split; long runs split at a comma', () => {
  const c = createSpeechChunker({ maxChars: 40 });
  assert.deepEqual(c.push('Use e.g. version 3.5 today. '), ['Use e.g. version 3.5 today.']);
  const long = createSpeechChunker({ maxChars: 40 });
  const out = long.push('alpha beta gamma delta, epsilon zeta eta theta iota kappa', true);
  assert.ok(out.length >= 2 && out.every((s) => s.length <= 40), JSON.stringify(out));
});

test('chunker: a replay rewind waits, a divergence skips ahead, nothing is spoken twice', () => {
  const c = createSpeechChunker();
  assert.deepEqual(c.push('One. Two. '), ['One.', 'Two.']);
  assert.deepEqual(c.push(''), []);                 // rewind: text restarts
  assert.deepEqual(c.push('One. '), []);            // still a prefix of what was seen
  assert.deepEqual(c.push('One. Two. Three. '), ['Three.']);
  assert.deepEqual(c.push('Different text entirely. '), []); // diverged: realign, do not re-speak
  assert.deepEqual(c.push('Different text entirely. Next. '), ['Next.']);
});

test('headings and list items end their own sentence even without punctuation', () => {
  const c = createSpeechChunker();
  assert.deepEqual(c.push('## Summary\n- one\n- two\n'), ['Summary.', 'one.', 'two.']);
});

test('encodeWav writes a 16-bit mono PCM RIFF header and clamps samples', () => {
  const wav = encodeWav(new Float32Array([0, 1, -1, 2]), 16000);
  const v = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), 'WAVE');
  assert.equal(v.getUint16(22, true), 1);           // channels
  assert.equal(v.getUint32(24, true), 16000);       // sample rate
  assert.equal(v.getUint16(34, true), 16);          // bits
  assert.equal(v.getUint32(40, true), 8);           // data bytes
  assert.deepEqual([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true), v.getInt16(50, true)], [0, 32767, -32768, 32767]);
  assert.equal(wav.length, 52);
});

test('cleanTranscript drops whisper non-speech markers', () => {
  assert.equal(cleanTranscript(' [BLANK_AUDIO] '), '');
  assert.equal(cleanTranscript('(silence) Hello  [ Music ] world '), 'Hello world');
});
