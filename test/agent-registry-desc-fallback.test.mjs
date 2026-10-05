// test/agent-registry-desc-fallback.test.mjs — empty sidecar description falls
// back to the agent .md's frontmatter description (spec 2026-08-09). Sidecar
// wins when present; unreadable/absent md, missing frontmatter, missing
// description line, or a block-scalar value degrades to ''.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRows } from './helpers/rows.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgentRegistry } from '../src/core/agent-registry.mjs';

function layer(files) {
  const dir = mkdtempSync(join(tmpdir(), 'worca-desc-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}
const sidecar = (key, extra = {}) => JSON.stringify({
  key, displayName: key, color: 'blue', runnerType: 'producer', order: 1,
  agentFile: `${key}.md`, ...extra,
});
const load = (dir) => loadAgentRegistry(dir, { userAgentsDir: null, includePlugins: false });

test('frontmatter description fallback: quoted values unquoted; missing .md / no frontmatter / no line / block scalar → ""', async () => {
  await checkRows([
    { name: 'quoted frontmatter values are unquoted', run: () => {
      const dir = layer({
        'gamma.meta.json': sidecar('gamma'),
        'gamma.md': '---\ndescription: "Quoted: colons, commas, fine."\n---\n',
      });
      assert.equal(load(dir).gamma.description, 'Quoted: colons, commas, fine.');
    } },
    { name: 'missing .md, no frontmatter, no description line, or a block scalar → empty string', run: () => {
      const dir = layer({
        'noMd.meta.json': sidecar('noMd'),
        'noFm.meta.json': sidecar('noFm'), 'noFm.md': '# no frontmatter\n',
        'noLine.meta.json': sidecar('noLine'), 'noLine.md': '---\nname: noLine\n---\n',
        'folded.meta.json': sidecar('folded'),
        'folded.md': '---\nname: folded\ndescription: >-\n  Folded scalar body\n  continues here.\n---\n',
      });
      const reg = load(dir);
      assert.equal(reg.noMd.description, '');
      assert.equal(reg.noFm.description, '');
      assert.equal(reg.noLine.description, '');
      assert.equal(reg.folded.description, '', 'block-scalar indicator must degrade to empty, never ">-"');
    } },
  ]);
});
