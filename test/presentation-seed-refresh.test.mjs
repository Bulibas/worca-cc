// The upgrade path: an EXISTING DB meeting a CHANGED shipped graph.
//
// This is the gap the seed bug came through. graph-presentation-workflow.test.mjs
// checks the code constant; db-migrate-v36.test.mjs checks a fresh DB. Neither
// covered a DB that already holds an older seeded copy — and `INSERT OR IGNORE`
// writes once, so that copy never refreshed. The stored 9-node graph stayed put
// while the constant grew a 10th node and deckReviewer gained a required `task`
// input, and the workflow then failed validation (V9) at run start with no
// remedy offered but re-wiring by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/core/db.mjs';
import { validateGraph } from '../src/shared/graph/validate.mjs';
import { realPortsFn } from './helpers/graph-ports.mjs';
import {
  GRAPH_PRESENTATION_WORKFLOW as CUR,
  presentationGraphFingerprint,
  PRESENTATION_SHIPPED_FINGERPRINTS,
} from '../src/core/graph/presentation-workflow.mjs';

const PRIOR = PRESENTATION_SHIPPED_FINGERPRINTS[0];
const graphOf = (db) => JSON.parse(db.prepare("SELECT graph FROM workflows WHERE id='wf_presentation'").get().graph);

/** A migrated DB whose wf_presentation row has been rolled back to a prior
 *  shipped shape — exactly what an install that first seeded then looks like. */
function dbHoldingPriorShape() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const keptWires = new Set(PRIOR.split('|')[1].split(','));
  const keptNodes = new Set(PRIOR.split('|')[0].split(','));
  const old = {
    nodes: CUR.nodes.filter((n) => keptNodes.has(n.id)),
    wires: CUR.wires.filter((w) => keptWires.has(w.id)),
  };
  assert.equal(presentationGraphFingerprint(old), PRIOR, 'reconstructed the prior shipped shape');
  db.prepare("UPDATE workflows SET graph=? WHERE id='wf_presentation'").run(JSON.stringify(old));
  return db;
}

test('the prior shipped shape really is invalid against the current sidecars (V9)', () => {
  const db = dbHoldingPriorShape();
  const stored = graphOf(db);
  const { errors } = validateGraph({ ...CUR, nodes: stored.nodes, wires: stored.wires }, realPortsFn());
  assert.ok(errors.length > 0, 'a stale seed must be detectably broken, or this test proves nothing');
  assert.ok(errors.some((e) => String(e.code || e) === 'V9' || /unwired/i.test(JSON.stringify(e))),
    `expected a V9 unwired-input error, got ${JSON.stringify(errors)}`);
  db.close();
});

test('re-running the ladder refreshes a stale seed to the current shape', () => {
  const db = dbHoldingPriorShape();
  db.prepare('PRAGMA user_version = 30').run();      // an install stamped before this migration
  migrate(db);

  const stored = graphOf(db);
  assert.equal(presentationGraphFingerprint(stored), presentationGraphFingerprint(CUR), 'refreshed to current');
  const { errors, warnings } = validateGraph({ ...CUR, nodes: stored.nodes, wires: stored.wires }, realPortsFn());
  assert.deepEqual(errors, [], JSON.stringify(errors));
  assert.deepEqual(warnings, [], JSON.stringify(warnings));
  db.close();
});

test('a user-edited workflow is never clobbered by the refresh', () => {
  const db = dbHoldingPriorShape();
  const edited = graphOf(db);
  edited.nodes.push({ id: 'n_mine', kind: 'agent', key: 'deckAudit', x: 1, y: 1, config: {} });
  db.prepare("UPDATE workflows SET graph=? WHERE id='wf_presentation'").run(JSON.stringify(edited));
  db.prepare('PRAGMA user_version = 30').run();
  migrate(db);

  const after = graphOf(db);
  assert.ok(after.nodes.some((n) => n.id === 'n_mine'), 'the user edit survived');
  assert.ok(!after.nodes.some((n) => n.id === 'n_export'), 'and the shipped shape was NOT forced over it');
  db.close();
});

test('the current shape is not listed as a prior one, or every open would rewrite', () => {
  assert.ok(!PRESENTATION_SHIPPED_FINGERPRINTS.includes(presentationGraphFingerprint(CUR)));
});

// The refresh must re-run on EVERY version bump, not at one fixed version.
// SCHEMA_VERSION went 29 -> 32 while the refresh stayed gated on `current < 31`,
// so an install already stamped 31 never re-entered it and kept the stale graph
// — the exact V9 failure this file exists to prevent, one version later. The
// guard is now `current < SCHEMA_VERSION`, so any future bump picks the shape up
// and appending a fingerprint is genuinely all a shape change needs.
//
// 35 and 36 are the rungs the rebase onto upstream introduced: 36 is the SEED's
// own version, so a DB stamped there skips the seed and must still be refreshed —
// which is precisely the "one fixed version" trap, and the only stamp at which
// the two halves of the migration disagree.
for (const stamped of [29, 30, 31, 35, 36]) {
  test(`a DB stamped ${stamped} holding the prior shape is refreshed to the current one`, () => {
    const db = dbHoldingPriorShape();
    db.exec(`PRAGMA user_version = ${stamped}`);
    migrate(db);
    const after = graphOf(db);
    assert.equal(presentationGraphFingerprint(after), presentationGraphFingerprint({ nodes: CUR.nodes, wires: CUR.wires }),
      `stamped ${stamped} kept a stale graph`);
    assert.ok(after.nodes.some((n) => n.id === 'n_export'), 'the export node arrived');
    const { errors } = validateGraph({ ...CUR, nodes: after.nodes, wires: after.wires }, realPortsFn());
    assert.deepEqual(errors, [], JSON.stringify(errors));
    db.close();
  });
}

// deleteWorkflow issues a real DELETE (it does not archive), and the module
// header promises "a user who edits or DELETES it keeps their choice". Gating the
// whole step on `current < SCHEMA_VERSION` so the refresh re-runs on every bump
// made the INSERT re-run too, resurrecting a workflow the user removed on
// purpose. Seed once; refresh always.
test('a workflow the user deleted is not resurrected by a later version bump', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.prepare("DELETE FROM workflows WHERE id = 'wf_presentation'").run();
  db.exec('PRAGMA user_version = 36');                 // at the seed's own version, so it will not re-fire
  migrate(db);
  assert.equal(db.prepare("SELECT id FROM workflows WHERE id = 'wf_presentation'").get(), undefined,
    'the deletion stands');
  db.close();
});

test('but a DB that never reached the seed still gets it', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.prepare("DELETE FROM workflows WHERE id = 'wf_presentation'").run();
  db.exec('PRAGMA user_version = 29');                 // predates the seed
  migrate(db);
  assert.ok(db.prepare("SELECT id FROM workflows WHERE id = 'wf_presentation'").get(), 'seeded on the way past 36');
  db.close();
});
