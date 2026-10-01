// test/docs-mcp-plugins.test.mjs
// The plugin authoring skill is the contract plugin authors read (MCP registry spec §17):
// it must name API 5, the `mcpServers` rules, and carry a worked example the host accepts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WORCA_MCP_API } from '../src/core/plugin-api.mjs';
import { normalizeManifest } from '../src/core/plugin-manifest.mjs';

const SKILL = readFileSync(fileURLToPath(new URL('../.claude/skills/creating-worca-cc-plugins/SKILL.md', import.meta.url)), 'utf8');
const FLAT = SKILL.replace(/\s+/g, ' ');   // prose wraps; rules are matched on one line

test('the quick reference names API 5 and the mcpServers key', () => {
  assert.match(SKILL, /Host APIs are a SET \(\[1, 2, 3, 4, 5\]\)/);
  assert.match(SKILL, /\*\*API 5 honours the manifest's `mcpServers`\*\*/);
  assert.match(SKILL, /^\| `mcpServers` \|/m);
});

test('the MCP section states the gate and the rules an author trips on', () => {
  assert.match(SKILL, /^## MCP servers \(API 5\)$/m);
  assert.match(SKILL, new RegExp(`">=${WORCA_MCP_API} <${WORCA_MCP_API + 1}"`));
  for (const rule of [
    /`\^\[a-z\]\[a-z0-9-\]\{0,19\}\$`/, /`worca` is reserved/, /`\^\[A-Za-z\]\[A-Za-z0-9_\]\{0,31\}\$`/,
    /`\^\[A-Za-z_\]\[A-Za-z0-9_\]\{0,63\}\$`/, /`MCPSECRET_`/, /`MCPCHILD_`/,
    /`Host`, `Content-Length`, `Transfer-Encoding`, `Connection` and `Upgrade`/,
    /never in `args`/, /`\$\{`/, /`<plugin-dir>\/…`/, /`uv run --directory \.\/`/, /200 characters/,
  ]) assert.match(FLAT, rule);
  assert.match(SKILL, /^\| `mcpServers` on a plugin declaring API 4 \|/m, 'the gate is a common mistake');
});

test('the worked manifest is one the host honours', () => {
  const m = SKILL.match(/```json\n(\{\n  "name": "acme-tools",[\s\S]*?)\n```/);
  assert.ok(m, 'the MCP section carries a full manifest as one json block');
  const r = normalizeManifest(JSON.parse(m[1]));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(Object.keys(r.manifest.mcpServers).sort(), ['jira', 'sentry']);
});
