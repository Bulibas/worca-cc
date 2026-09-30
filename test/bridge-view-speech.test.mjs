// test/bridge-view-speech.test.mjs
// The Providers card's Speech row (docs/speech.md): fields per service, masked
// key echo, per-service Test buttons and result pills, and collectSpeechRow's
// PATCH body (unchanged key omitted, '' clears).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderProvidersCard, collectSpeechRow } from '../ui/public/bridge-view.mjs';

const doc = new JSDOM('<!doctype html><body></body>').window.document;
const SPEECH = {
  stt: { engine: 'server', baseUrl: 'http://127.0.0.1:8080/v1', model: 'whisper-1', language: 'bg', configured: true, keySet: true, keySource: 'stored', keyMasked: '••••••abcd', keyRef: null, keyMissing: false },
  tts: { engine: 'off', baseUrl: '', model: 'tts-1', voice: 'alloy', speed: 1, configured: false, keySet: false, keySource: null, keyMasked: null, keyRef: null, keyMissing: false },
};

test('Speech row renders both services with test buttons and badges', () => {
  const card = renderProvidersCard({ speech: SPEECH }, { doc, split: true });
  const row = card.querySelector('.mv-pv-row[data-provider="speech"]');
  assert.ok(row);
  assert.equal(row.querySelector('.mv-sp-field[data-kind="stt"][data-field="baseUrl"]').value, 'http://127.0.0.1:8080/v1');
  assert.equal(row.querySelector('.mv-sp-field[data-kind="stt"][data-field="apiKey"]').value, '••••••abcd');
  assert.equal(row.querySelector('.mv-sp-field[data-kind="tts"][data-field="baseUrl"]').placeholder, 'http://127.0.0.1:8880/v1');
  assert.deepEqual([...row.querySelectorAll('.mv-sp-test')].map((b) => b.dataset.kind), ['stt', 'tts']);
  assert.equal(row.querySelectorAll('.mv-sp-result').length, 2);
  assert.ok(row.querySelector('.mv-sp-save'));
  assert.match(row.textContent, /text only/);            // TTS-not-configured badge
});

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

test('Speech row: server fields show only for engine "server"; the model cache line appears once something is downloaded', () => {
  const card = renderProvidersCard({ speech: { ...SPEECH, stt: { ...SPEECH.stt, engine: 'browser' }, cacheBytes: 512e6 } }, { doc, split: true });
  const row = card.querySelector('.mv-pv-row[data-provider="speech"]');
  assert.equal(row.querySelector('.mv-sp-server[data-kind="stt"]').hidden, true);
  const sel = row.querySelector('.mv-sp-engine[data-kind="stt"]');
  sel.value = 'server';
  sel.dispatchEvent(new doc.defaultView.Event('change'));
  assert.equal(row.querySelector('.mv-sp-server[data-kind="stt"]').hidden, false);
  assert.match(row.querySelector('.mv-sp-cache').textContent, /512 MB/);
  assert.ok(row.querySelector('.mv-sp-clear'));
  const none = renderProvidersCard({ speech: { ...SPEECH, cacheBytes: 0 } }, { doc, split: true });
  assert.equal(none.querySelector('.mv-sp-clear'), null);
});
