import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextEntries, mergeContexts, MAX_CONTEXTS, PAGE_LABELS } from '../src/core/ask/contexts.mjs';

test('contextEntries: resolved project/run/workspace + named page, pin marked', () => {
  const ctx = { view: 'settings', pinned: true, workspaceId: 'wks-havn-0000abcd', pipelineId: '1a2b3c4d' };
  const header = {
    view: 'settings', pinned: true,
    project: { name: 'worca-cc', key: 'worca-cc-ace1a602' },
    workspace: { name: 'havn', id: 'wks-havn-0000abcd', members: [] },
    run: { id: '1a2b3c4d', title: 'Fix login', status: 'done', startedAt: '', branch: null, home: 'worca-cc-ace1a602' },
  };
  assert.deepEqual(contextEntries(ctx, header), [
    { kind: 'project', id: 'worca-cc-ace1a602', label: 'worca-cc' },
    { kind: 'workspace', id: 'wks-havn-0000abcd', label: 'havn', pinned: true },
    { kind: 'run', id: '1a2b3c4d', label: 'Fix login', home: 'worca-cc-ace1a602' },
    { kind: 'page', id: 'settings', label: 'Settings' },
  ]);
});

test('contextEntries: unresolved ids and list views produce nothing', () => {
  assert.deepEqual(contextEntries({ view: 'history', projectKey: 'gone-00000001' }, { view: 'history' }), []);
  assert.deepEqual(contextEntries({}, {}), []);
  assert.deepEqual(contextEntries(undefined, undefined), []);
});

test('contextEntries: untitled run labels with its id; long names are clipped', () => {
  const [run] = contextEntries({}, { run: { id: '1a2b3c4d', title: '', home: 'p-00000001' } });
  assert.deepEqual(run, { kind: 'run', id: '1a2b3c4d', label: '1a2b3c4d', home: 'p-00000001' });
  const [p] = contextEntries({}, { project: { name: 'x'.repeat(200), key: 'p-00000001' } });
  assert.equal(p.label.length, 80);
});

test('mergeContexts: origin first, dedupe by kind:id, label refresh, sticky pin', () => {
  const a = { kind: 'project', id: 'p-00000001', label: 'Old' };
  const b = { kind: 'page', id: 'settings', label: 'Settings' };
  let m = mergeContexts(null, [a]);
  m = mergeContexts(m, [b, { ...a, label: 'New', pinned: true }]);
  m = mergeContexts(m, [{ kind: 'project', id: 'p-00000001', label: 'New' }]);   // later unpinned sighting
  assert.deepEqual(m, [
    { kind: 'project', id: 'p-00000001', label: 'New', pinned: true },
    { kind: 'page', id: 'settings', label: 'Settings' },
  ]);
  assert.deepEqual(mergeContexts('garbage', []), [], 'a corrupt stored value degrades to empty');
});

test('contextEntries: a run with no home (a live run before its pipeline id) earns no chip', () => {
  // its header id is a run-id prefix, not the pipeline id a later turn resolves: a chip would duplicate
  assert.deepEqual(contextEntries({}, { run: { id: 'deadbeef', title: 'Live', home: null } }), []);
  assert.deepEqual(contextEntries({}, { run: { id: 'deadbeef', title: 'Live' } }), []);
});

test('mergeContexts: an id-only fallback label never replaces a real one', () => {
  const named = { kind: 'run', id: '1a2b3c4d', label: 'Fix login', home: 'p-00000001' };
  let m = mergeContexts([], [named]);
  m = mergeContexts(m, [{ ...named, label: '1a2b3c4d' }]);           // a later turn saw no title
  assert.equal(m[0].label, 'Fix login');
  m = mergeContexts(m, [{ ...named, label: 'Fix login v2' }]);        // a real rename still lands
  assert.equal(m[0].label, 'Fix login v2');
});

test('mergeContexts: cap keeps the origin plus the most recent', () => {
  const many = Array.from({ length: MAX_CONTEXTS + 5 }, (_, i) => ({ kind: 'run', id: i.toString(16).padStart(8, '0'), label: `r${i}`, home: null }));
  const m = mergeContexts([], many);
  assert.equal(m.length, MAX_CONTEXTS);
  assert.equal(m[0].label, 'r0', 'origin kept');
  assert.equal(m.at(-1).label, `r${MAX_CONTEXTS + 4}`, 'newest kept');
});

test('PAGE_LABELS covers exactly the named pages', () => {
  assert.deepEqual(Object.keys(PAGE_LABELS).sort(), ['settings', 'team-metrics', 'team-policy']);
});
