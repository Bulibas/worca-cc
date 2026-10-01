// test/mcp-team-plugin-seeds.test.mjs — a plugin reference's policy values seed only the plugin server's
// non-secret fields (MCP registry spec §11.1, §11.2): its keys can be checked only once the plugin is installed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useTempHome } from './helpers/temp-home.mjs';
import { SENTRY, writeMcpPlugin } from './helpers/mcp-plugin-fixture.mjs';
import { pluginDir, readPluginsLock, writePluginsLock } from '../src/core/plugins-lock.mjs';
import { writeTeamPolicyPrefs } from '../src/core/config.mjs';
import { cachedPolicyHomes } from '../src/core/policy/cache.mjs';
import { entryHash, teamAction } from '../src/core/mcp/team.mjs';
import { mcpDir } from '../src/core/mcp/store.mjs';
import { getSetView } from '../src/core/mcp/views.mjs';

useTempHome(after);

test('Turn on seeds a plugin reference\'s non-secret fields only; a secret or unknown key never lands in values', async () => {
  const sha = 'abcdef0123456789abcdef0123456789abcdef01';
  writeMcpPlugin(join(pluginDir('acme-tools'), 'versions', sha.slice(0, 7)), { name: 'acme-tools', mcpServers: { sentry: SENTRY } });
  symlinkSync(join('versions', sha.slice(0, 7)), join(pluginDir('acme-tools'), 'current'));
  writePluginsLock({ ...readPluginsLock(), 'acme-tools': { repo: '/x', subdir: '', pinnedSha: sha, version: '1', enabled: true } });
  writeTeamPolicyPrefs('platform-0123abcd', { present: true, hasOrigin: true, docKnown: true, slug: 'acme/platform', headSha: '8c1d2e0', delegateTo: null, checkedAt: new Date().toISOString(),
    doc: { schema: 1, fields: { 'plugins.required': { kind: 'soft', value: [{ name: 'acme-tools' }] },
      'mcp.required': { kind: 'soft', value: [{ plugin: 'acme-tools', server: 'sentry', values: { org: 'acme', token: 'not-a-token', nope: 'x' } }] } } } });
  // The plugin is installed: the checklist offers Turn on, never "Needs plugin" (the plugin states reach the rows).
  const { mcpRequirements } = await import('../src/core/policy/local.mjs');
  assert.deepEqual((await mcpRequirements()).map((r) => [r.serverId, r.state]), [['plugin:acme-tools/sentry', 'never-consented']]);
  const e = cachedPolicyHomes()[0].doc.fields['mcp.required'].value[0];
  const { setId } = await teamAction('turn-on', 'acme/platform', 'plugin:acme-tools/sentry', { expectHash: entryHash(e) });
  const st = JSON.parse(readFileSync(join(mcpDir(), 'sets.json'), 'utf8')).teams['acme/platform'].members['plugin:acme-tools/sentry'];
  assert.deepEqual([st.values, st.seeded], [{ org: 'acme' }, { org: 'acme' }]);
  // The card's "Team suggests … · Use team value" offers the same keys only (P1 refuses a secret or unknown key in values).
  const card = (await getSetView(setId)).members.find((m) => m.serverId === 'plugin:acme-tools/sentry');
  assert.deepEqual(card.team.suggests, [], 'never the policy\'s token (a secret field) or nope (no such field)');
});
