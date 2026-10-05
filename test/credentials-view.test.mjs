// test/credentials-view.test.mjs
// Settings › My model credentials (ui/public/credentials-view.mjs): status only,
// a link to the key page, never a key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderCredentials } from '../ui/public/credentials-view.mjs';
import { checkRows } from './helpers/rows.mjs';

const doc = new JSDOM('<!doctype html><body></body>').window.document;

test('credentials view in multi, single, no-person and broker-error states', async () => {
  await checkRows([
    { name: 'multi mode: one row per slot with its state, and a Manage keys link to the key page', run: () => {
      const el = renderCredentials({
        enabled: true, mode: 'multi', keyPage: 'https://keys.example.com', person: 'ada@acme.dev',
        slots: [
          { id: 'anthropic', label: 'Anthropic API key', state: 'set', suffix: '1a2b' },
          { id: 'openai', label: 'OpenAI API key', state: 'missing' },
          { id: 'local', label: 'Local models', state: 'keyless' },
        ],
      }, doc);
      const rows = [...el.querySelectorAll('.cred-row')].map((r) => r.textContent);
      assert.deepEqual(rows, ['Anthropic API keySet ••••1a2b', 'OpenAI API keyNot set', 'Local modelsNo key needed']);
      const a = el.querySelector('a');
      assert.equal(a.href, 'https://keys.example.com/');
      assert.equal(a.target, '_blank');
      assert.match(a.className, /btn-primary/, 'a missing key makes Manage keys the primary action');
    } },
    { name: 'credentials view: single mode, no person and broker error states', run: async () => {
      await checkRows([
        { name: 'single mode says where keys live; no key page link', run: () => {
          const el = renderCredentials({ enabled: true, mode: 'single', keyPage: null, person: null, slots: [{ id: 'anthropic', label: 'Anthropic API key', state: 'set' }] }, doc);
          assert.match(el.textContent, /held by the credential broker/);
          assert.equal(el.querySelector('a'), null);
        } },
        { name: 'no signed-in person, and a broker that did not answer', run: () => {
          assert.match(renderCredentials({ enabled: true, mode: 'multi', person: null, slots: [] }, doc).textContent, /Sign in/);
          assert.match(renderCredentials({ enabled: true, error: 'cannot reach' }, doc).textContent, /didn't answer: cannot reach/);
        } },
      ]);
    } },
  ]);
});
