// test/skills-views-host.test.mjs
// Skills registry §4.1 in the Settings views (P2's views.mjs): installed Claude Code plugin names come from
// skillHostFacts (CLAUDE_CONFIG_DIR, skills-dir plugins), and a set's prefix is the resolver's own (pluginNamesFor) —
// a renamed set never takes another set's slug, so Settings shows what pipelines and Ask load.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTempHome } from './helpers/temp-home.mjs';
import { getSetView, viewContext } from '../src/core/mcp/views.mjs';
import { createSet, putSkillMember } from '../src/core/mcp/store.mjs';

useTempHome(after, 'worca-skills-views-');
const cfg = mkdtempSync(join(tmpdir(), 'worca-skills-views-cfg-'));
after(() => rmSync(cfg, { recursive: true, force: true }));
const put = (file, text) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); };
const NOTES = 'skill:library:release-notes';

test('viewContext reads installed plugin names through skillHostFacts; a renamed set shows the prefix spawns use', async () => {
  const prev = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, WORCA_CLAUDE_MANAGED_SETTINGS: process.env.WORCA_CLAUDE_MANAGED_SETTINGS };
  process.env.CLAUDE_CONFIG_DIR = cfg;   // never the developer's ~/.claude
  process.env.WORCA_CLAUDE_MANAGED_SETTINGS = join(cfg, 'no-managed-settings.json');
  try {
    put(join(cfg, 'settings.json'), JSON.stringify({ enabledPlugins: { 'billing@acme-market': true } }));
    put(join(cfg, 'skills', 'shop', '.claude-plugin', 'plugin.json'), '{"name":"shop"}');
    assert.equal((await createSet('Billing')).id, 'billing');
    assert.equal((await createSet('Billing set')).id, 'billing-set');
    await putSkillMember('billing', NOTES, {}, { entry: { id: NOTES } });
    const c = await viewContext();
    assert.deepEqual(c.hostFacts, { installedPluginNames: ['billing', 'shop'] }, 'CLAUDE_CONFIG_DIR + a skills-dir plugin');
    const v = await getSetView('billing');
    assert.deepEqual([v.set.pluginName, v.set.renamedPlugin], ['billing-set-2', true], 'billing-set is another set\'s slug');
    assert.deepEqual(v.skills.map((m) => m.qualifiedName), ['billing-set-2:release-notes']);
    const other = await getSetView('billing-set');
    assert.deepEqual([other.set.pluginName, other.set.renamedPlugin], ['billing-set', false]);
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
