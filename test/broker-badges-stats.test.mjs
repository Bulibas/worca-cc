// test/broker-badges-stats.test.mjs
// Credential-broker UI pieces (plans/credential-broker-design.html §7.2) and the pure
// logic behind them: "your key / no key" badges, the start-of-run key check, and the
// per-person usage fold the Stats "By person" card renders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credentialBadge, credentialSuffix, setCredentialData, keyPageUrl } from '../ui/public/credential-badges.mjs';
import { missingCredentials, describeMissing, manifestModels } from '../src/core/broker-routing.mjs';
import { foldUsageByPerson } from '../src/core/broker-client.mjs';
import { checkRows } from './helpers/rows.mjs';

const DATA = {
  enabled: true, mode: 'multi', keyPage: 'https://keys.example.com', person: 'ada@acme.dev',
  models: {
    'claude-sonnet-5': { slot: 'anthropic' }, 'gpt-x': { slot: 'openai' }, 'cp-x': { slot: 'copilot' },
    'or-x': { slot: 'openrouter' }, 'qwen-local': { keyless: true }, 'gw-x': { error: 'no credential slot for gw.example' },
  },
  slots: [
    { id: 'anthropic', label: 'Anthropic API key', state: 'set' },
    { id: 'openai', label: 'OpenAI API key', state: 'missing' },
    { id: 'copilot', label: 'GitHub Copilot', state: 'invalid' },
    { id: 'openrouter', label: 'OpenRouter API key', state: 'operator' },
  ],
};

test('badges: one per model state (missing flagged); nothing without a broker or a person; the cache feeds the default', async () => {
  await checkRows([
    { name: 'badges: one per model state, missing ones flagged', run: async () => {
      const b = (id) => credentialBadge(id, DATA);
      assert.deepEqual([b('claude-sonnet-5').text, b('claude-sonnet-5').missing], ['your key', false]);
      assert.deepEqual([b('gpt-x').text, b('gpt-x').missing], ['no key', true]);
      assert.match(b('gpt-x').title, /Add your OpenAI API key on the key page/);
      assert.equal(b('cp-x').text, 'key rejected');
      assert.equal(b('or-x').text, 'team key');
      assert.equal(b('qwen-local').text, 'local');
      assert.equal(b('gw-x').text, 'no route');
      assert.equal(b('unknown-model'), null);
      assert.equal(credentialSuffix('gpt-x', DATA), ' · no key');
      assert.equal(credentialSuffix('claude-sonnet-5', DATA), '', 'a working key adds nothing to a plain option label');
    } },
    { name: 'badges: nothing without a broker or a signed-in person; the cache feeds the default', run: async () => {
      assert.equal(credentialBadge('gpt-x', { enabled: false }), null);
      assert.equal(credentialBadge('gpt-x', { ...DATA, person: null }), null);
      setCredentialData(DATA);
      assert.equal(credentialBadge('gpt-x').text, 'no key');
      assert.equal(keyPageUrl(), 'https://keys.example.com');
      setCredentialData({ enabled: false });
      assert.equal(credentialBadge('gpt-x'), null);
    } },
  ]);
});

test('start-of-run check: every model of the run mapped to its key; each missing one named', () => {
  const manifest = { nodes: [{ kind: 'agent', model: 'claude-sonnet-5' }, { kind: 'agent', model: 'gpt-x' }, { kind: 'agent', model: '' }, { kind: 'script' }], extra: { deep: { model: 'cp-x' } } };
  const models = [...manifestModels(manifest)];
  assert.deepEqual(models.sort(), ['claude-sonnet-5', 'cp-x', 'gpt-x']);
  const slotOf = (id) => DATA.models[id] || null;
  const r = missingCredentials([...models, 'qwen-local', 'gw-x'], slotOf, DATA.slots);
  assert.deepEqual(r.missing.map((m) => [m.slot, m.state, m.models]).sort(), [['copilot', 'invalid', ['cp-x']], ['openai', 'missing', ['gpt-x']]]);
  assert.deepEqual(r.errors, ['gw-x: no credential slot for gw.example']);
  const text = describeMissing(r, 'https://keys.example.com');
  assert.match(text, /OpenAI API key \(not added; needed by gpt-x\)/);
  assert.match(text, /GitHub Copilot \(rejected by the provider; needed by cp-x\)/);
  assert.match(text, /key page \(https:\/\/keys\.example\.com\)/);
  assert.match(text, /gw-x: no credential slot/);
  assert.deepEqual(missingCredentials(['claude-sonnet-5', 'qwen-local'], slotOf, DATA.slots), { missing: [], errors: [] });
});

test('usage folded per person: slots summed, most spend first', () => {
  const people = foldUsageByPerson([
    { billTo: 'bob@acme.dev', slot: 'anthropic', usd: 1.5, requests: 10, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, lastAt: '2026-09-27T10:00:00Z' },
    { billTo: 'ada@acme.dev', slot: 'anthropic', usd: 2, requests: 5, inputTokens: 500, outputTokens: 100, cacheReadTokens: 50, lastAt: '2026-09-27T09:00:00Z' },
    { billTo: 'ada@acme.dev', slot: 'openai', usd: 0.25, requests: 2, inputTokens: 40, outputTokens: 10, cacheReadTokens: 0, lastAt: '2026-09-27T11:00:00Z' },
  ]);
  assert.deepEqual(people.map((p) => [p.person, p.usd, p.requests]), [['ada@acme.dev', 2.25, 7], ['bob@acme.dev', 1.5, 10]]);
  assert.deepEqual(people[0].slots.map((s) => s.slot), ['anthropic', 'openai']);
  assert.equal(people[0].lastAt, '2026-09-27T11:00:00Z');
});
