// test/speech-g2p.test.mjs
// English text → Kokoro phonemes without eSpeak (src/shared/speech-g2p.mjs):
// number reading, dictionary lookup (gold before silver, case variants, DEFAULT
// readings), misaki's -s / -ed / -ing rules, acronym spelling, the British
// fallback dictionary, the/ði, punctuation, and the letter-to-sound last resort.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createG2P, normalizeText, numberToWords, ordinalToWords } from '../src/shared/speech-g2p.mjs';

// A slice of misaki's us_gold / us_silver, entries as they appear there.
const GOLD = {
  the: 'ði', pipeline: 'pˈIplˌIn', finish: 'fˈɪnɪʃ', and: 'ænd', all: 'ˈɔl', test: 'tˈɛst', pass: 'pˈæs',
  wait: 'wˈAt', review: 'ɹəvjˈu', read: { DEFAULT: 'ɹˈid', VBD: 'ɹˈɛd' }, apple: 'ˈæpᵊl', work: 'wˈɜɹk', tree: 'tɹˈi',
  git: 'ɡˈɪt', hub: 'hˈʌb', box: 'bˈɑks', like: 'lˈIk', hello: 'həlˈO', GitHub: 'ɡˈɪthˌʌb',
  A: 'ˈA', N: 'ˈɛn', P: 'pˈi', M: 'ˈɛm', I: 'ˈI',
};
const SILVER = { orchestra: 'ˈɔɹkəstɹə' };
const g2p = createG2P({ gold: GOLD, silver: SILVER });

test('numbers, ordinals, years, money, times and percent read as words', () => {
  assert.equal(numberToWords(0), 'zero');
  assert.equal(numberToWords(45), 'forty-five');
  assert.equal(numberToWords(1234567), 'one million two hundred thirty-four thousand five hundred sixty-seven');
  assert.equal(ordinalToWords(21), 'twenty-first');
  assert.equal(ordinalToWords(12), 'twelfth');
  assert.equal(normalizeText('In 1999 and 2025, 2005 too'), 'In nineteen ninety-nine and twenty twenty-five, two thousand five too');
  assert.equal(normalizeText('costs $0.42 or £3'), 'costs forty-two cents or three pounds');
  assert.equal(normalizeText('at 10:05, 95% done'), 'at ten oh five, ninety-five percent done');
  assert.equal(normalizeText('version 1.6 on the 3rd'), 'version one point six on the third');
  assert.equal(normalizeText('Mr. Smith, e.g. this'), 'Mister Smith, for example this');
});

test('dictionary words, DEFAULT readings, case variants; the/ði by the next sound; punctuation kept', () => {
  assert.equal(g2p.phonemize('The pipeline, the apple!'), 'ðə pˈIplˌIn, ði ˈæpᵊl!');
  assert.equal(g2p.word('read'), 'ɹˈid');
  assert.equal(g2p.word('Hello'), 'həlˈO');
  assert.equal(g2p.word('HELLO'), 'həlˈO');
  assert.equal(g2p.word('Orchestra'), 'ˈɔɹkəstɹə');           // silver
  assert.equal(g2p.phonemize('a test'), 'ɐ tˈɛst');
});

test("misaki's suffix rules: -s, -ed, -ing, possessive", () => {
  assert.equal(g2p.word('tests'), 'tˈɛsts');
  assert.equal(g2p.word('boxes'), 'bˈɑksᵻz');
  assert.equal(g2p.word('passed'), 'pˈæst');
  assert.equal(g2p.word('waited'), 'wˈAɾᵻd');
  assert.equal(g2p.word('finished'), 'fˈɪnɪʃt');
  assert.equal(g2p.word('liking'), 'lˈIkɪŋ');
  assert.equal(g2p.word('waiting'), 'wˈAɾɪŋ');
  assert.equal(g2p.word("pipeline's"), 'pˈIplˌInz');
});

test('acronyms are spelled; camelCase and kebab parts; compounds; letter-to-sound as the last resort', () => {
  assert.equal(g2p.word('NPM'), 'ˌɛnpˌiˈɛm');
  assert.equal(g2p.word('npm'), 'ˌɛnpˌiˈɛm');
  assert.equal(g2p.word('GitHub'), 'ɡˈɪthˌʌb');              // known as a whole
  assert.equal(g2p.word('GitBox'), 'ɡˈɪt bˈɑks');              // not known: split at the case change
  assert.equal(g2p.word('work-tree'), 'wˈɜɹk tɹˈi');
  assert.equal(g2p.word('worktree'), 'wˈɜɹktɹˌi');
  assert.equal(g2p.word('worca'), 'wˈɔɹkə');
  assert.equal(g2p.phonemize('!!! ...'), '!!!...');
  assert.equal(g2p.phonemize(''), '');
});

test('British: its own lexicon first, then the American one before any guessing; British -ed', () => {
  const gb = createG2P({ gold: { test: 'tˈɛst', want: 'wˈɒnt' }, silver: {}, british: true, also: { orchestrator: 'ˈɔɹkəstɹˌAɾəɹ' } });
  assert.equal(gb.word('orchestrator'), 'ˈɔɹkəstɹˌAɾəɹ');
  assert.equal(gb.word('wanted'), 'wˈɒntɪd');
});
