// v41: seed AND refresh the shipped Presentation workflow (wf_presentation) as a
// v2 row — a fresh DB gains it, a DB stamped lower gains it on the ladder, an
// archived row with the id is not resurrected, and a user's own live row with the
// id is left untouched.
//
// It is v41 because 30..40 are all taken by unrelated upstream steps (36..39 are
// its attribution ladder, 40 is the workspace map), and a seed on an occupied
// rung is skipped by every
// released install. And an `INSERT OR IGNORE` seed writes once, at first reach of
// its version: a DB already stamped at it would never pick up a later change to
// the shipped graph, which is exactly how a stored 9-node copy survived the
// constant gaining a 10th node and started failing validation (V9) at run start.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate, SCHEMA_VERSION } from '../src/core/db.mjs';
import { useTempHome } from './helpers/temp-home.mjs';
import { assertRunnableWorkflow } from '../src/core/workflows.mjs';
import * as presentationModule from '../src/core/graph/presentation-workflow.mjs';

const rowFor = (db, id) => db.prepare('SELECT * FROM workflows WHERE id = ?').get(id);
const freshMigrated = () => { const db = new DatabaseSync(':memory:'); migrate(db); return db; };

test('a fresh DB carries wf_presentation as a v2 presentation graph with 11 nodes', () => {
  const db = freshMigrated();
  const row = rowFor(db, 'wf_presentation');
  assert.ok(row, 'seeded');
  assert.equal(row.version, 2);
  assert.equal(row.domain, 'presentation');
  const graph = JSON.parse(row.graph);
  assert.equal(graph.nodes.length, 11);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  db.close();
});

test('ladder: a DB stamped 29 gains wf_presentation', () => {
  assert.ok(SCHEMA_VERSION >= 41);
  const db = freshMigrated();
  db.prepare('DELETE FROM workflows WHERE id = ?').run('wf_presentation');
  db.exec('PRAGMA user_version = 29');
  migrate(db);
  assert.ok(rowFor(db, 'wf_presentation'), 'seeded on the ladder');
  db.close();
});

test('INSERT OR IGNORE: an archived row keeps the id and is not resurrected', () => {
  const db = freshMigrated();
  db.prepare('DELETE FROM workflows WHERE id = ?').run('wf_presentation');
  db.prepare(`INSERT INTO workflows (id, name, version, domain, origin, steps, feedbacks, graph, created_at, updated_at, archived_at)
    VALUES ('wf_presentation', 'Mine', 2, 'coding', NULL, '[]', '[]', '{"nodes":[],"wires":[]}', 't', 't', 't')`).run();
  db.exec('PRAGMA user_version = 29');
  migrate(db);
  const row = rowFor(db, 'wf_presentation');
  assert.equal(row.archived_at, 't', 'archived row not resurrected');
  assert.equal(row.name, 'Mine');
  db.close();
});

test('INSERT OR IGNORE: a user\'s own live row with the id is left byte-identical', () => {
  const db = freshMigrated();
  db.prepare('DELETE FROM workflows WHERE id = ?').run('wf_presentation');
  db.prepare(`INSERT INTO workflows (id, name, version, domain, origin, steps, feedbacks, graph, created_at, updated_at, archived_at)
    VALUES ('wf_presentation', 'My Deck', 2, 'presentation', NULL, '[]', '[]', '{"nodes":[],"wires":[]}', 't', 't', NULL)`).run();
  db.exec('PRAGMA user_version = 29');
  migrate(db);
  const row = rowFor(db, 'wf_presentation');
  assert.equal(row.name, 'My Deck');
  assert.equal(row.graph, '{"nodes":[],"wires":[]}');
  db.close();
});

useTempHome(after);

test('assertRunnableWorkflow resolves wf_presentation from the seeded store', async () => {
  const live = await assertRunnableWorkflow('wf_presentation');
  assert.equal(live.id, 'wf_presentation');
  assert.equal(live.version, 2);
});

// The refresh replaced the stored graph WHOLESALE. Its guard — "the stored shape
// is one worca shipped" — is a fingerprint of node ids + wire ids only, so it
// cannot see a config edit: setWorkflowNodeDefaults writes a model pin straight
// into graph.nodes[].config without touching ids, `origin` or `archived_at`, and
// the Composer stores the viewport under `canvas`. Both survived the fingerprint
// and were then silently discarded, which is not what "a user-edited row is never
// touched" promises. The refresh exists to fix WIRING; settings the product
// offers an API to set are not its business.
// Wires whose id is no longer present in the current constant because a later
// shape retired them (rather than merely re-pointing them). The v1 fixture
// references w16, which the deckBundle wiring removed entirely (the export now
// gates on n_bundle, not on n_review directly) — so the current constant alone
// can no longer reconstruct it.
const RETIRED_WIRES = [
  { id: 'w16', from: { node: 'n_review', port: 'pass' }, to: { node: 'n_export', port: 'await' } },
];

test('refresh rewires an older shipped seed WITHOUT discarding node defaults or canvas', () => {
  const { GRAPH_PRESENTATION_WORKFLOW, PRESENTATION_SHIPPED_FINGERPRINTS } = presentationModule;
  const [v1fp] = PRESENTATION_SHIPPED_FINGERPRINTS;
  const [nodeIds, wireIds] = v1fp.split('|').map((s) => new Set(s.split(',')));
  const t = GRAPH_PRESENTATION_WORKFLOW;
  const allWires = [...t.wires, ...RETIRED_WIRES.filter((w) => !t.wires.some((c) => c.id === w.id))];

  const db = freshMigrated();
  // Put the row back to the older shipped shape, with a user's pin and viewport.
  const nodes = t.nodes.filter((n) => nodeIds.has(n.id)).map((n) => (n.id === 'n_build'
    ? { ...n, config: { ...(n.config || {}), model: 'opus-pinned', askQuestions: false } } : n));
  const wires = allWires.filter((w) => wireIds.has(w.id));
  db.prepare('UPDATE workflows SET graph = ? WHERE id = ?')
    .run(JSON.stringify({ nodes, wires, canvas: { x: 40, y: 12, scale: 0.8 } }), t.id);
  db.exec('PRAGMA user_version = 41');

  migrate(db);

  const graph = JSON.parse(rowFor(db, t.id).graph);
  assert.equal(graph.nodes.length, t.nodes.length, 'rewired to the current shipped shape');
  assert.ok(graph.nodes.some((n) => n.id === 'n_export'), 'the new node arrived');
  const build = graph.nodes.find((n) => n.id === 'n_build');
  assert.equal(build.config.model, 'opus-pinned', "the user's model pin survived the refresh");
  assert.equal(build.config.askQuestions, false, 'and so did their askQuestions default');
  assert.deepEqual(graph.canvas, { x: 40, y: 12, scale: 0.8 }, 'and the saved viewport');
  assertRunnableWorkflow({ id: t.id, version: 2, nodes: graph.nodes, wires: graph.wires });
  db.close();
});
