// test/ask-command-card.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createCommandCard } from '../ui/public/ask-command-card.mjs';

const dom = () => new JSDOM('<!doctype html><html><body></body></html>').window.document;
const CARD = { type: 'command', blockId: 't-0000000001:1', sessionId: 't-0000000001', seq: 1, command: 'npm test', folder: 'demo · main', warning: null };

test('a running command: the command, a live tail, a Stop button', () => {
  const doc = dom(); const stops = [];
  const c = createCommandCard({ doc, card: CARD, onStop: (sid) => stops.push(sid) });
  doc.body.appendChild(c.el);
  c.update({ status: 'running', tail: 'PASS a\nPASS b\n', exitCode: null });
  assert.equal(c.el.querySelector('.ask-cmd-line').textContent, '$ npm test');
  assert.match(c.el.querySelector('.ask-cmd-out').textContent, /PASS b/);
  const stop = c.el.querySelector('.ask-cmd-stop');
  assert.equal(stop.hidden, false);
  stop.click();
  assert.deepEqual(stops, ['t-0000000001']);
  assert.equal(stop.disabled, true);                      // one click
});

test('ended: exit pill, no Stop; a failure is red, a cap stop says so', () => {
  const doc = dom();
  const c = createCommandCard({ doc, card: CARD, onStop: () => {} });
  c.update({ status: 'done', exitCode: 1, tail: 'FAIL', durationMs: 4200 });
  assert.equal(c.el.querySelector('.ask-cmd-stop').hidden, true);
  assert.equal(c.el.querySelector('.ask-cmd-pill').textContent, 'exit 1');
  assert.ok(c.el.querySelector('.ask-cmd-pill').classList.contains('st-red'));
  c.update({ status: 'stopped', exitCode: 130, stoppedBy: 'ask:cap', tail: '' });
  assert.equal(c.el.querySelector('.ask-cmd-pill').textContent, 'stopped (30-min cap)');
});

test('the live-run warning shows when the card carries one', () => {
  const doc = dom();
  const c = createCommandCard({ doc, card: { ...CARD, warning: 'This pipeline is still running…' }, onStop: () => {} });
  assert.equal(c.el.querySelector('.ask-cmd-warning').hidden, false);
});

test('the folder label shows the command\'s terminal tab (onShow with the session)', () => {
  const doc = dom(); const shown = [];
  const c = createCommandCard({ doc, card: CARD, onStop: () => {}, onShow: (sid) => shown.push(sid) });
  const folder = c.el.querySelector('.ask-cmd-folder');
  assert.equal(folder.tagName, 'BUTTON');
  assert.equal(folder.textContent, 'demo · main');
  assert.match(folder.title, /terminal/i);
  folder.click();
  assert.deepEqual(shown, ['t-0000000001']);
});
