// test/ui-branch-sync-model.test.mjs
// Sync before run (#527): the pure models behind the Source-branch pill, the Projects /
// Workspaces chips, the Ask proposal note, the run header's Sync label and the refusal copy.
// The models are plain functions; the DOM helpers at the end run under jsdom.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ago, syncPillModel, chipState, projectChipModel, worstChip, sourceRefNote,
  fetchFailureCopy, ffRefusalCopy, syncStageLabel, freshSyncState, cssEscape,
  mountSyncRow, paintSyncRow, isSyncableBranchName, fetchedAgo,
} from '../ui/public/branch-sync.mjs';
import { isSafeBranchName } from '../src/core/git-sync.mjs';

const block = (over = {}) => ({
  base: 'dev', remote: 'origin', state: 'up-to-date', ahead: 0, behind: 0,
  dirty: false, checkedOutHere: true, shallow: false, stale: false, ...over,
});

test('syncPillModel: the four required colours, hidden without a remote, diverged amber', () => {
  assert.deepEqual(syncPillModel(block({ state: 'behind', behind: 3 }), { autoSync: true }),
    { tone: 'blue', label: '3 behind', state: 'behind' });
  assert.deepEqual(syncPillModel(block({ state: 'behind', behind: 3 }), { autoSync: false }),
    { tone: 'amber', label: '3 behind', state: 'behind-off' });
  assert.equal(syncPillModel(block()).tone, 'green');
  assert.equal(syncPillModel(block()).label, 'Up to date');
  assert.equal(syncPillModel(block({ state: 'ahead', ahead: 2 })).tone, 'green');
  assert.deepEqual(syncPillModel(block({ state: 'behind', behind: 3, stale: true })),
    { tone: 'grey', label: 'Offline', state: 'offline' });
  assert.equal(syncPillModel(block({ fetchError: { kind: 'auth' } })).label, 'Offline');
  assert.deepEqual(syncPillModel(block({ remote: null })), { hidden: true });
  assert.deepEqual(syncPillModel(null), { hidden: true });
  assert.deepEqual(syncPillModel(block({ state: 'diverged' })), { tone: 'amber', label: 'Diverged', state: 'diverged' });
  assert.equal(syncPillModel(block({ state: 'remote-only' })).label, 'Remote only');
  assert.equal(syncPillModel(block({ state: 'no-upstream' })).label, 'Not on origin');
  assert.equal(syncPillModel(block({ state: 'missing' })).label, 'Unknown');
  assert.equal(syncPillModel(block({ state: 'behind', behind: 5, shallow: true })).label, 'at least 5 behind');
});

test('projectChipModel: texts and actions', () => {
  assert.deepEqual(projectChipModel(block()), { state: 'ok', tone: 'green', text: 'dev · up to date', action: 'Sync' });
  assert.deepEqual(projectChipModel(block({ state: 'behind', behind: 3 })),
    { state: 'behind', tone: 'blue', text: 'dev · 3 behind', action: 'Sync' });
  assert.deepEqual(projectChipModel(block({ base: 'main', state: 'diverged' })),
    { state: 'diverged', tone: 'amber', text: 'main · diverged', action: 'Review…' });
  assert.deepEqual(projectChipModel(block({ base: 'main', dirty: true })),
    { state: 'dirty', tone: 'amber', text: 'main · dirty', action: 'Sync' });
  assert.equal(projectChipModel(block({ remote: null })), null);
  assert.equal(projectChipModel(block({ state: 'unknown' })), null);
  assert.equal(projectChipModel(block({ state: 'remote-only' })), null, 'on the remote: no chip');
  assert.equal(projectChipModel(block({ stale: true })).text, 'dev · offline');
  assert.equal(projectChipModel(block({ dirty: true, checkedOutHere: false })).state, 'ok', 'a dirty tree elsewhere is not this base');
});

// One table shared in spirit with §3.4's server chipState test: the two copies must agree.
const CHIP_TABLE = [
  [block(), 'ok'],
  [block({ state: 'behind', behind: 1 }), 'behind'],
  [block({ state: 'diverged' }), 'diverged'],
  [block({ dirty: true }), 'dirty'],
  [block({ stale: true }), 'offline'],
  [block({ state: 'no-upstream', base: 'feat/x' }), 'local'],
  [block({ state: 'missing' }), 'local'],
  [block({ state: 'remote-only' }), null],
  [block({ state: 'unknown' }), null],
  [block({ remote: null }), null],
];
test('chipState table; no-upstream is a grey "not on the remote" chip, never green', () => {
  for (const [b, want] of CHIP_TABLE) assert.equal(chipState(b), want, JSON.stringify(b));
  assert.deepEqual(projectChipModel(block({ state: 'no-upstream', base: 'feat/x' })),
    { state: 'local', tone: 'grey', text: 'feat/x · not on the remote', action: 'Sync' });
});

test('worstChip: the worst member wins, independent of order', () => {
  const a = block(); const b = block({ state: 'behind', behind: 2 }); const c = block({ state: 'diverged' });
  const d = block({ stale: true }); const e = block({ state: 'no-upstream' });
  assert.deepEqual(worstChip([a, b, c]), { state: 'diverged', tone: 'amber', text: 'diverged' });
  assert.deepEqual(worstChip([c, b, a]), worstChip([a, b, c]));
  assert.deepEqual(worstChip([a, b]), { state: 'behind', tone: 'blue', text: 'behind' });
  assert.equal(worstChip([e, d]).state, 'offline');
  assert.equal(worstChip([d, e]).state, 'offline');
  assert.equal(worstChip([a, e]).state, 'local');
  assert.equal(worstChip([e, a]).state, 'local');
  assert.equal(worstChip([block({ remote: null })]), null);
  assert.equal(worstChip([]), null);
  assert.equal(worstChip(null), null);
});

test('sourceRefNote', () => {
  assert.equal(sourceRefNote(null), '');
  assert.equal(sourceRefNote({ ref: 'dev' }), '');
  assert.equal(sourceRefNote({ ref: 'origin/feat', remoteOnly: true }), 'from origin/feat (remote only)');
  assert.equal(sourceRefNote({ ref: 'dev', behind: 2 }), 'from dev (2 behind)');
  assert.equal(sourceRefNote({ ref: 'dev', behind: 2, stale: true }), 'from dev (2 behind, could not fetch — last known refs)');
});

test('syncStageLabel for all five results', () => {
  assert.equal(syncStageLabel(null), 'Sync');
  assert.equal(syncStageLabel({ result: 'fast-forwarded', commits: 3 }), 'Synced 3 commits');
  assert.equal(syncStageLabel({ result: 'fast-forwarded', commits: 1 }), 'Synced 1 commit');
  assert.equal(syncStageLabel({ result: 'remote-start', remote: 'origin' }, 'dev'), 'Started from origin/dev');
  assert.equal(syncStageLabel({ result: 'remote-start' }, 'main'), 'Started from origin/main');
  assert.equal(syncStageLabel({ result: 'fetch-failed' }), 'Sync: used the last fetch');
  assert.equal(syncStageLabel({ result: 'diverged' }), 'Sync: diverged');
  assert.equal(syncStageLabel({ result: 'up-to-date' }), 'Sync');
});

test('ffRefusalCopy: dirty, in-use, diverged, unknown kind, ok', () => {
  assert.match(ffRefusalCopy({ ok: false, kind: 'dirty' }, 'dev'), /^dev has uncommitted changes, so it was not moved\. Runs start from origin\/dev/);
  assert.match(ffRefusalCopy({ ok: false, kind: 'in-use' }, 'dev', 'upstream'), /checked out in another worktree.*upstream\/dev/);
  assert.equal(ffRefusalCopy({ ok: false, kind: 'diverged' }, 'dev'), 'dev has diverged from origin/dev. Nothing was moved.');
  assert.equal(ffRefusalCopy({ ok: false, kind: 'weird' }, 'dev'), 'Could not update dev.');
  assert.equal(ffRefusalCopy({ ok: true }, 'dev'), '');
  assert.equal(ffRefusalCopy(null, 'dev'), '');
});

test('fetchFailureCopy by kind, never stderr', () => {
  assert.match(fetchFailureCopy('auth'), /^Sign-in to origin failed/);
  assert.match(fetchFailureCopy('network', 'upstream'), /^upstream could not be reached/);
  assert.match(fetchFailureCopy('timeout'), /did not answer in time/);
  assert.match(fetchFailureCopy('failed'), /^Fetching origin failed/);
  assert.match(fetchFailureCopy(undefined), /^Fetching origin failed/);
});

test('ago', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  assert.equal(ago(null, now), 'never');
  assert.equal(ago('garbage', now), 'never');
  assert.equal(ago('2026-09-30T11:59:30Z', now), 'just now');
  assert.equal(ago('2026-09-30T12:00:30Z', now), 'just now', 'clock skew clamps to now');
  assert.equal(ago('2026-09-30T11:55:00Z', now), '5 min ago');
  assert.equal(ago('2026-09-30T09:00:00Z', now), '3 h ago');
  assert.equal(ago('2026-09-28T12:00:00Z', now), '2 d ago');
});

test('freshSyncState: one complete shape, never shared between calls', () => {
  const a = freshSyncState();
  assert.deepEqual(a, { block: null, autoSync: null, busy: false, members: {}, gen: 0 });
  assert.equal(freshSyncState(4).gen, 4, 'the caller bumps the generation');
  const b = freshSyncState();
  a.members.x = 1;
  assert.deepEqual(b.members, {}, 'a fresh object every time');
});

test('cssEscape works without window.CSS (jsdom) and escapes quotes', () => {
  assert.equal(cssEscape('plain-key_1'), 'plain-key_1');
  const out = cssEscape('a"b\\c');
  assert.ok(!/(^|[^\\])"/.test(out), `unescaped quote in ${out}`);
  assert.equal(cssEscape(null), '');
});

// ── DOM helpers (jsdom) ────────────────────────────────────────────────────
const tick = (n = 1) => new Promise((r) => setTimeout(r, n));
async function dom(body = '') {
  const { JSDOM } = await import('jsdom');
  const d = new JSDOM(`<!doctype html><body>${body}</body>`, { url: 'http://localhost/' });
  for (const k of ['window', 'document', 'Node', 'HTMLElement', 'Event', 'KeyboardEvent']) {
    Object.defineProperty(globalThis, k, { value: d.window[k], configurable: true, writable: true });
  }
  return d.window;
}
const ROW = `<div class="sync-row" id="sync-row" hidden>
  <button type="button" class="sync-pill grey" id="sync-pill"><span class="sdot"></span><span class="sync-pill-txt">Checking…</span></button>
  <button type="button" class="btn btn-mini sync-btn" id="sync-btn"><span>Sync</span></button>
  <label class="switch-row sync-auto"><input id="syncAuto" class="sw-input" type="checkbox" checked></label>
</div><button id="opener">open</button>`;

test('paintSyncRow: hidden without a remote; tone, label, aria-label, busy and switch otherwise', async () => {
  const w = await dom(ROW);
  const host = w.document.getElementById('sync-row');
  assert.deepEqual(paintSyncRow(host, block({ remote: null })), { hidden: true });
  assert.equal(host.hidden, true);
  paintSyncRow(host, block({ state: 'behind', behind: 3 }), { autoSync: false, busy: true });
  assert.equal(host.hidden, false);
  const pill = w.document.getElementById('sync-pill');
  assert.equal(pill.className, 'sync-pill amber');
  assert.equal(pill.querySelector('.sync-pill-txt').textContent, '3 behind');
  assert.equal(pill.getAttribute('aria-label'), 'Sync status: 3 behind. Show details');
  const btn = w.document.getElementById('sync-btn');
  assert.ok(btn.classList.contains('busy')); assert.equal(btn.disabled, true);
  assert.equal(w.document.getElementById('syncAuto').checked, false);
  paintSyncRow(host, block({ state: 'behind', behind: 3 }), { autoSync: true });
  assert.equal(pill.className, 'sync-pill blue');
  assert.equal(btn.disabled, false);
});

test('mountSyncRow wires pill, Sync and the switch', async () => {
  const w = await dom(ROW);
  const host = w.document.getElementById('sync-row');
  const seen = [];
  mountSyncRow(host, { onPill: () => seen.push('pill'), onSync: () => seen.push('sync'), onToggle: (on) => seen.push(`toggle:${on}`) });
  w.document.getElementById('sync-pill').click();
  w.document.getElementById('sync-btn').click();
  const sw = w.document.getElementById('syncAuto');
  sw.checked = false; sw.dispatchEvent(new w.Event('change'));
  assert.deepEqual(seen, ['pill', 'sync', 'toggle:false']);
});

test('openSyncDialog: rows, commits as text, Escape returns focus, scrim closes, onSync repaint and refusal note', async () => {
  const w = await dom(ROW);
  const { openSyncDialog } = await import('../ui/public/branch-sync.mjs');
  const opener = w.document.getElementById('opener'); opener.focus();
  const b = block({ state: 'behind', behind: 2, fetchedAt: new Date().toISOString(), remoteLabel: 'github.com/acme/web',
    incoming: [{ sha: 'abcdef1234', at: new Date().toISOString(), subject: '<b>x</b>', author: 'a' }] });
  let done = openSyncDialog({ title: 'Sync status', subtitle: 'web · dev', sync: b, autoSync: true, opener });
  const dlg = w.document.querySelector('[role=dialog]');
  assert.ok(dlg.classList.contains('sync-modal'));
  assert.equal(dlg.getAttribute('aria-labelledby'), 'sync-dlg-title');
  assert.ok(dlg.querySelector('.card.sync-card'));
  const dts = [...dlg.querySelectorAll('.sync-kv dt')].map((n) => n.textContent);
  assert.deepEqual(dts, ['Local base', 'origin/dev', 'Behind / ahead', 'Last fetched', 'Remote', 'Working tree', 'Auto-sync']);
  const li = dlg.querySelector('.sync-commits li');
  assert.equal(li.children[0].textContent, 'abcdef1');
  assert.equal(li.children[1].textContent, '<b>x</b>', 'subject is text, never markup');
  assert.equal(li.querySelector('b'), null);
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(await done, null);
  assert.equal(w.document.querySelector('[role=dialog]'), null);
  assert.equal(w.document.activeElement, opener);

  done = openSyncDialog({ sync: b, opener });
  const m2 = w.document.querySelector('.sync-modal');
  m2.dispatchEvent(new w.Event('click', { bubbles: true }));
  assert.equal(await done, null);

  // onSync returns nothing → the current block stays; returns a refused ff → the note explains.
  let answer;
  done = openSyncDialog({ sync: b, opener, onSync: async () => answer });
  const d3 = w.document.querySelector('.sync-modal');
  d3.querySelector('.sync-go').click(); await tick(2);
  assert.equal(d3.querySelector('.sync-pill-txt').textContent, '2 behind');
  answer = { ...b, ff: { ok: false, kind: 'dirty' } };
  d3.querySelector('.sync-go').click(); await tick(2);
  assert.match(d3.querySelector('.sync-note').textContent, /uncommitted changes/);
  assert.equal(d3.querySelector('.sync-note').hidden, false);
  d3.querySelector('.sync-x').click();
  await done;
});

test('openSyncDialog offline: auth copy and Retry; a gone opener falls back', async () => {
  const w = await dom(ROW);
  const { openSyncDialog } = await import('../ui/public/branch-sync.mjs');
  const opener = w.document.getElementById('opener');
  const fb = w.document.getElementById('sync-pill');
  const done = openSyncDialog({ sync: block({ stale: true, fetchError: { kind: 'auth' } }), opener, fallbackFocus: () => fb });
  const d = w.document.querySelector('.sync-modal');
  assert.match(d.querySelector('.sync-note').textContent, /^Sign-in to origin failed/);
  assert.equal(d.querySelector('.sync-go').textContent, 'Retry');
  assert.equal(d.querySelector('.sync-pill-txt').textContent, 'Offline');
  opener.remove();
  d.querySelector('.confirm-actions .btn').click();
  await done;
  assert.equal(w.document.activeElement, fb);
});

test('chooseSyncRefusal: diverged → origin; forbidden → Cancel only; fetch-failed → last-fetch; Escape → null', async () => {
  const w = await dom();
  const { chooseSyncRefusal } = await import('../ui/public/branch-sync.mjs');
  const members = [{ projectKey: 'k', base: 'dev', remote: 'origin', ahead: 1, behind: 2 }];
  let p = chooseSyncRefusal({ code: 'sync-diverged', options: ['origin', 'cancel'], members });
  let m = w.document.querySelector('.sync-modal');
  assert.ok(m.querySelector('.qpanel'));
  assert.equal(m.querySelector('.qopt'), null);
  assert.match(m.textContent, /dev has diverged from origin\/dev \(1 ahead, 2 behind\)\./);
  const go = [...m.querySelectorAll('button')].find((b) => b.textContent === 'Start from origin/dev');
  assert.ok(go && go.classList.contains('btn-primary'));
  go.click();
  assert.equal(await p, 'origin');

  p = chooseSyncRefusal({ code: 'sync-diverged', options: ['cancel'], forbidden: true, members });
  m = w.document.querySelector('.sync-modal');
  assert.deepEqual([...m.querySelectorAll('button')].map((b) => b.textContent), ['Cancel']);
  assert.match(m.textContent, /does not allow starting from the remote/);
  m.querySelector('button').click();
  assert.equal(await p, null);

  p = chooseSyncRefusal({ code: 'sync-fetch-failed', fetchKind: 'auth', options: ['last-fetch', 'cancel'],
    members: [{ projectKey: 'a', projectName: 'A', base: 'dev', remote: 'origin', fetchKind: 'auth' },
      { projectKey: 'b', projectName: 'B', base: 'main', remote: 'origin', fetchKind: 'network' }] });
  m = w.document.querySelector('.sync-modal');
  assert.match(m.textContent, /A: Sign-in to origin failed/);
  assert.match(m.textContent, /B: origin could not be reached/);
  [...m.querySelectorAll('button')].find((b) => b.textContent === 'Start anyway from last fetch').click();
  assert.equal(await p, 'last-fetch');

  p = chooseSyncRefusal({ code: 'sync-diverged', options: ['origin', 'cancel'], members });
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(await p, null);
  assert.equal(w.document.querySelector('.sync-modal'), null);
});

// ── Markup + stylesheet, by source (jsdom cannot see the cascade) ─────────
test('index.html: branch pair, sync row after the previous-run switch, run-header Sync, Ship-it warn, topbar wrapper', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../ui/public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<div class="field-grid-2 branch-pair" id="branch-fields" data-min-level="advanced">/);
  assert.ok(!html.includes('sourceBranchHint'), 'the hint is gone');
  const prev = html.indexOf('id="ws-source-previous-row"');
  const row = html.indexOf('<div class="sync-row" id="sync-row" hidden>');
  assert.ok(prev > 0 && row > prev, 'the sync row follows #ws-source-previous-row');
  for (const id of ['sync-pill', 'sync-btn', 'syncAuto', 'sync-auto-row']) assert.ok(html.includes(`id="${id}"`), id);
  const copied = html.indexOf('<span class="rd-copied">');
  const rdSync = html.indexOf('<button type="button" class="rd-sync" hidden data-min-level="advanced" title="Show the Sync log"></button>');
  const spacer = html.indexOf('<span class="rd-spacer">');
  assert.ok(copied > 0 && rdSync > copied && spacer > rdSync, '.rd-sync sits between .rd-copied and .rd-spacer');
  const summaryEnd = html.indexOf('<small class="hint warn" id="shipit-base-warn" hidden></small>');
  assert.ok(summaryEnd > html.indexOf('class="shipit-summary mono"'));
  assert.match(html, /<div class="topbar-actions"><button class="btn btn-mini" id="projects-sync-all" type="button">Sync all<\/button>\s*<button type="button" id="project-add-btn"/);
});

test('style.css: §6.3 block before the 6193 reduced-motion line, explicit [hidden], override inside the final block', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../ui/public/style.css', import.meta.url), 'utf8');
  const block = css.indexOf('/* Sync before run (#527) */');
  assert.ok(block > css.indexOf('.confirm-modal .card{width:min(440px,100%);}'), 'after .confirm-modal .card');
  assert.ok(block < css.indexOf('@media (prefers-reduced-motion: reduce){.mode-modal .card'), 'before the 6193 block');
  assert.match(css, /\.sync-row\[hidden\],\.sync-pill\[hidden\],\.sync-note\[hidden\],\.sync-commits\[hidden\],\.sync-go\[hidden\],\.rd-sync\[hidden\],#shipit-base-warn\[hidden\],\.proj-sync\[hidden\],\.ws-sync\[hidden\]\{display:none;\}/);
  assert.match(css, /\.sync-pill\.blue\{background:var\(--blue-bg\);color:var\(--blue-ink-strong\);\}/);
  assert.match(css, /\.field-grid-2\.branch-pair\{/);
  assert.match(css, /\.ws-src-row \.sync-pill\{align-self:flex-start;\}/);
  const last = css.lastIndexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(css.slice(last).includes('.sync-btn.busy svg{animation:none;}'), 'the override lives in the final block');
  assert.ok(css.indexOf('.sync-btn.busy svg{animation:ws-spin') < last);
});

test('isSyncableBranchName is the twin of git-sync isSafeBranchName (the UI skips the 400)', () => {
  const names = ['dev', 'main', 'feat/x', 'release/1.0', 'a.b-c_d', 'plus+branch', 'with space', '', '-x', '/x', 'x/', 'x.',
    'x.lock', 'a/b.lock/c', 'a..b', 'a//b', '.hidden', 'a/.b', 'a'.repeat(256), 'a'.repeat(255), '0123456789abcdef0123456789abcdef01234567',
    'ümlaut', 'x~1', 'x^', 'x:y', 'x?', 'x*', 'x[', 'x\\y', null, undefined, 7];
  for (const n of names) assert.equal(isSyncableBranchName(n), isSafeBranchName(n), JSON.stringify(n));
});

test('paintSyncRow: an Unknown pill disables Sync (the server would refuse it)', async () => {
  const { JSDOM } = await import('jsdom');
  const { window } = new JSDOM('<div id="r"><button class="sync-pill"><span class="sync-pill-txt"></span></button><button class="sync-btn"></button><input type="checkbox"></div>');
  const host = window.document.getElementById('r');
  paintSyncRow(host, block({ state: 'unknown' }));
  assert.equal(host.querySelector('.sync-btn').disabled, true);
  paintSyncRow(host, block({ state: 'behind', behind: 1 }));
  assert.equal(host.querySelector('.sync-btn').disabled, false);
});

test('fetchedAgo: "never" only when nothing failed; a failed fetch with no time says so', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  assert.equal(fetchedAgo({ fetchedAt: '2026-09-30T11:57:00Z' }, now), '3 min ago');
  assert.equal(fetchedAgo({ fetchedAt: null }, now), 'never');
  assert.equal(fetchedAgo({ fetchedAt: null, stale: true, fetchError: { kind: 'network' } }, now), 'unknown (the last fetch failed)');
  assert.equal(fetchedAgo({ fetchedAt: '2026-09-30T11:57:00Z', stale: true }, now), '3 min ago', 'a known time always wins');
});
