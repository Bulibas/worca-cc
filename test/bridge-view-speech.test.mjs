// test/bridge-view-speech.test.mjs
// The Providers card's Speech row (docs/speech.md): collectSpeechRow's PATCH
// body (unchanged key omitted, '' clears).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderProvidersCard, collectSpeechRow } from '../ui/public/bridge-view.mjs';

const doc = new JSDOM('<!doctype html><body></body>').window.document;
const SPEECH = {
  stt: { engine: 'server', baseUrl: 'http://127.0.0.1:8080/v1', model: 'whisper-1', language: 'bg', configured: true, keySet: true, keySource: 'stored', keyMasked: '••••••abcd', keyRef: null, keyMissing: false },
  tts: { engine: 'off', baseUrl: '', model: 'tts-1', voice: 'alloy', speed: 1, configured: false, keySet: false, keySource: null, keyMasked: null, keyRef: null, keyMissing: false },
};

test('collectSpeechRow: unchanged key omitted, edits and clears carried', () => {
  const card = renderProvidersCard({ speech: SPEECH }, { doc, split: true });
  const f = (kind, field) => card.querySelector(`.mv-sp-field[data-kind="${kind}"][data-field="${field}"]`);
  f('stt', 'language').value = 'auto';
  f('stt', 'pause').value = '2';
  f('tts', 'baseUrl').value = 'http://127.0.0.1:8880/v1';
  f('tts', 'speed').value = '1.1';
  assert.deepEqual(collectSpeechRow(card), {
    stt: { engine: 'server', language: 'auto', pause: 2, baseUrl: 'http://127.0.0.1:8080/v1', model: 'whisper-1' },
    tts: { engine: 'off', voice: 'alloy', speed: 1.1, baseUrl: 'http://127.0.0.1:8880/v1', model: 'tts-1' },
  });
  f('stt', 'apiKey').value = '';
  assert.equal(collectSpeechRow(card).stt.apiKey, '');
});
