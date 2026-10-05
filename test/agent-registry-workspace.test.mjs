// test/agent-registry-workspace.test.mjs
// M4: the workspace agents in the registry — scope coercion, the
// produces===['workspace'] canary (the §6.9 highest-risk hazard), the DEFAULT_SPEC
// channel wiring, and the mandatory registryToSteps `scope:'workspace-only'`
// exclusion that keeps AGENT_STEPS at EXACTLY 8 (single-project byte-identity).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadAgentRegistry, registryToSteps } from '../src/core/agent-registry.mjs';

const tmpDirs = [];
after(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

test('CANARY: the workspaceScanner sidecar declares its typed ports and fanOut (the scan\'s survey stage)', () => {
  // The v1 channel-id list is gone; the ports ARE the wiring vocabulary now, and
  // an un-ported sidecar is refused outright by resolveGraph.
  const reg = loadAgentRegistry();
  assert.equal(reg.workspaceScanner.metaVersion, 2);
  assert.deepEqual(reg.workspaceScanner.inputs.map((p) => p.id), ['brief']);
  assert.deepEqual(reg.workspaceScanner.outputs.map((p) => p.id), ['survey']);
  assert.equal(reg.workspaceScanner.placeable, false, 'off-pipeline: never placeable on a canvas');
  assert.equal(reg.workspaceScanner.fanOut, true);
});

test('workspaceReviewer mirrors reviewer wiring (code->review->implementer loop)', () => {
  const reg = loadAgentRegistry();
  assert.equal(reg.workspaceReviewer.runnerType, 'verifier');
  assert.deepEqual(reg.workspaceReviewer.outputs.map((p) => p.id), reg.reviewer.outputs.map((p) => p.id));
  assert.deepEqual(reg.workspaceReviewer.inputs.map((p) => p.id), reg.reviewer.inputs.map((p) => p.id));
  assert.equal(reg.workspaceReviewer.fanOut, true);
});

test('scope coercion fails SAFE: a bogus scope value coerces to "project" (visible, not hidden)', async () => {
  // Feed a typo'd scope through the REAL normalizeMeta via loadAgentRegistry with a
  // temp sidecar dir. A non-'workspace-only' value must fall back to 'project' so a
  // typo surfaces a VISIBLE project agent rather than a silently-hidden one (§6.6).
  const dir = await mkdtemp(join(tmpdir(), 'worca-cc-scope-'));
  tmpDirs.push(dir);
  await writeFile(join(dir, 'typoAgent.meta.json'), JSON.stringify({
    key: 'typoAgent', displayName: 'Typo', description: 'd', color: 'blue',
    icon: '<path d="M0 0"/>', agentFile: 'worca-cc-typo.md',
    runnerType: 'producer', order: 9, scope: 'workspace-onlyy', // <- typo
  }), 'utf8');
  await writeFile(join(dir, 'wsOnly.meta.json'), JSON.stringify({
    key: 'wsOnly', displayName: 'WS', description: 'd', color: 'blue',
    icon: '<path d="M0 0"/>', agentFile: 'worca-cc-ws.md',
    runnerType: 'producer', order: 10, scope: 'workspace-only', // exact marker
  }), 'utf8');

  const reg = loadAgentRegistry(dir);
  assert.equal(reg.typoAgent.scope, 'project', 'a typo coerces to project (fails safe to visible)');
  assert.equal(reg.wsOnly.scope, 'workspace-only', 'the exact marker is preserved');
  // And the real shipped registry only ever carries the closed set.
  for (const m of Object.values(loadAgentRegistry())) {
    assert.ok(m.scope === 'project' || m.scope === 'workspace-only', `bad scope for ${m.key}: ${m.scope}`);
  }
});
