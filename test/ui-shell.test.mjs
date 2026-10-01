import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const html = readFileSync(fileURLToPath(new URL('../ui/public/index.html', import.meta.url)), 'utf8');

test('exactly fifteen routed views', () => {
  assert.equal((html.match(/data-view/g) || []).length, 15);   // + getting-started (docs/getting-started.md) + scripts + schedules + team-policy (team-policy design §11); Running + History merged into Runs
});
test('thirteen views include composer + the two workspace views + the two agent views + scripts + projects + stats + team-metrics (plugins/guardrails/models are Settings tabs now)', () => {
  for (const v of ['new', 'runs', 'stats', 'team-metrics', 'composer', 'workspaces', 'workspace-create', 'agents', 'scripts', 'agent-create', 'projects', 'settings'])
    assert.ok(html.includes(`data-view="${v}"`), `missing data-view=${v}`);
  // Folded into Settings: a pane, not a routed view (see .settings-pane below).
  for (const v of ['plugins', 'guardrails', 'models'])
    assert.ok(!html.includes(`data-view="${v}"`), `${v} should no longer be a routed view`);
});
test('nav targets: the base set + workspaces + projects + stats (workspace-create is NOT a nav target)', () => {
  for (const v of ['new', 'runs', 'stats', 'composer', 'workspaces', 'scripts', 'projects', 'settings'])
    assert.ok(html.includes(`data-nav="${v}"`), `missing data-nav=${v}`);
  // workspace-create is reached via location.hash only — no nav link.
  assert.ok(!html.includes('data-nav="workspace-create"'), 'workspace-create must not be a nav target');
});
test('shell hooks present (base + workspace surfaces)', () => {
  for (const id of [
    'run-detail-tpl', 'run-shell', 'run-detail', 'stop-modal',
    'hist-detail-tpl', 'shipit-modal',
    'runs-shell', 'runs-list', 'runs-pane', 'nav-needs-count', 'nav-running-count',
    'ws-detail-tpl', 'ws-shell', 'ws-detail', 'ws-list', 'target-seg', 'target-project-pane',
    'target-workspace-pane', 'workspaceSelect', 'ws-members', 'wiz-close',
  ])
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
});
test('the log filter bar ships in its own template', () => {
  assert.ok(html.includes('id="log-bar-tpl"'), 'missing #log-bar-tpl');
});
test('scan loader carries role=status + aria-live=polite (A11y)', () => {
  const m = html.match(/class="ws-loader"[^>]*>/);
  assert.ok(m, 'missing .ws-loader');
  assert.match(m[0], /role="status"/, '.ws-loader missing role="status"');
  assert.match(m[0], /aria-live="polite"/, '.ws-loader missing aria-live="polite"');
});
test('old shell removed', () => {
  assert.ok(!html.includes('class="layout"'), 'old .layout present');
  assert.ok(!html.includes('<ol id="steps"'), 'old #steps present');
});
