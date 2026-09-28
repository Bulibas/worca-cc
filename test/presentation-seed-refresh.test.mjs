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

const graphOf = (db) => JSON.parse(db.prepare("SELECT graph FROM workflows WHERE id='wf_presentation'").get().graph);

// Wires whose id is no longer present in CUR because a later shape retired them
// (rather than merely re-pointing them). The v1 fixture references w16, which
// Task 4 removed from CUR entirely (the export now gates on n_bundle, not on
// n_review directly) — so CUR alone can no longer reconstruct it.
const RETIRED_WIRES = [
  { id: 'w16', from: { node: 'n_review', port: 'pass' }, to: { node: 'n_export', port: 'await' } },
];

/** Rebuild the shape a given SHIPPED fingerprint describes, from CUR's nodes/wires
 *  plus RETIRED_WIRES for any id CUR no longer carries. Asserts the round-trip:
 *  a reconstruction that no longer matches its own fingerprint would mean this
 *  helper — not the product code — has drifted, and every test built on it would
 *  silently stop testing what it claims to. */
function reconstructShape(fp) {
  const [nodesPart, wiresPart] = fp.split('|');
  const keptNodes = new Set(nodesPart.split(','));
  const keptWires = new Set(wiresPart.split(','));
  const allWires = [...CUR.wires, ...RETIRED_WIRES.filter((w) => !CUR.wires.some((c) => c.id === w.id))];
  const shape = {
    nodes: CUR.nodes.filter((n) => keptNodes.has(n.id)),
    wires: allWires.filter((w) => keptWires.has(w.id)),
  };
  assert.equal(presentationGraphFingerprint(shape), fp, 'reconstructed the shipped shape named by the fingerprint');
  return shape;
}

/** A migrated DB whose wf_presentation row has been rolled back to the shape a
 *  given SHIPPED fingerprint describes — exactly what an install that first
 *  seeded at that shape, then never reopened until now, looks like. */
function dbHoldingShape(fp) {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const old = reconstructShape(fp);
  db.prepare("UPDATE workflows SET graph=? WHERE id='wf_presentation'").run(JSON.stringify(old));
  return db;
}

test('the current shape is not listed as a prior one, or every open would rewrite', () => {
  assert.ok(!PRESENTATION_SHIPPED_FINGERPRINTS.includes(presentationGraphFingerprint(CUR)));
});

// Every entry in PRESENTATION_SHIPPED_FINGERPRINTS is exercised here, not just
// the oldest. An appended fingerprint is the ONLY thing that stops a stale
// install from being read as user-edited (src/core/graph/presentation-workflow.mjs
// says so at length) — if the string itself is wrong (a transposed id, a dropped
// comma), the reconstruction above simply fails its own round-trip assertion, so
// a corrupt fingerprint is caught here rather than shipped silently. Looping
// over every entry means the NEXT appended fingerprint is covered automatically,
// with no test file edit required.
PRESENTATION_SHIPPED_FINGERPRINTS.forEach((fp, i) => {
  const label = `v${i + 1}`;

  test(`the ${label} shipped shape really is invalid against the current sidecars (V9)`, () => {
    const db = dbHoldingShape(fp);
    const stored = graphOf(db);
    const { errors } = validateGraph({ ...CUR, nodes: stored.nodes, wires: stored.wires }, realPortsFn());
    assert.ok(errors.length > 0, 'a stale seed must be detectably broken, or this test proves nothing');
    assert.ok(errors.some((e) => String(e.code || e) === 'V9' || /unwired/i.test(JSON.stringify(e))),
      `expected a V9 unwired-input error, got ${JSON.stringify(errors)}`);
    db.close();
  });

  test(`re-running the ladder refreshes a stale ${label} seed to the current shape`, () => {
    const db = dbHoldingShape(fp);
    db.prepare('PRAGMA user_version = 30').run();      // an install stamped before this migration
    migrate(db);

    const stored = graphOf(db);
    assert.equal(presentationGraphFingerprint(stored), presentationGraphFingerprint(CUR), 'refreshed to current');
    const { errors, warnings } = validateGraph({ ...CUR, nodes: stored.nodes, wires: stored.wires }, realPortsFn());
    assert.deepEqual(errors, [], JSON.stringify(errors));
    assert.deepEqual(warnings, [], JSON.stringify(warnings));
    db.close();
  });

  test(`a user-edited ${label} workflow is never clobbered by the refresh`, () => {
    const db = dbHoldingShape(fp);
    const edited = graphOf(db);
    edited.nodes.push({ id: 'n_mine', kind: 'agent', key: 'deckAudit', x: 1, y: 1, config: {} });
    db.prepare("UPDATE workflows SET graph=? WHERE id='wf_presentation'").run(JSON.stringify(edited));
    db.prepare('PRAGMA user_version = 30').run();
    migrate(db);

    const after = graphOf(db);
    assert.ok(after.nodes.some((n) => n.id === 'n_mine'), 'the user edit survived');
    // n_bundle is only in the CURRENT shape — never in any shipped fingerprint
    // below it — so its absence proves the refresh did NOT force the shipped
    // shape over the user's edit, regardless of which prior shape this is.
    assert.ok(!after.nodes.some((n) => n.id === 'n_bundle'), 'and the shipped shape was NOT forced over it');
    db.close();
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
  // the two halves of the migration disagree. 37 is the version this release
  // (Task 4) leaves behind: an install stamped there is exactly the DB a v2-shaped
  // stale seed (label v2) would be found in the wild.
  for (const stamped of [29, 30, 31, 35, 36, 37]) {
    test(`a DB stamped ${stamped} holding the ${label} shape is refreshed to the current one`, () => {
      const db = dbHoldingShape(fp);
      db.exec(`PRAGMA user_version = ${stamped}`);
      migrate(db);
      const after = graphOf(db);
      assert.equal(presentationGraphFingerprint(after), presentationGraphFingerprint({ nodes: CUR.nodes, wires: CUR.wires }),
        `stamped ${stamped} kept a stale ${label} graph`);
      assert.ok(after.nodes.some((n) => n.id === 'n_export'), 'the export node arrived');
      const { errors } = validateGraph({ ...CUR, nodes: after.nodes, wires: after.wires }, realPortsFn());
      assert.deepEqual(errors, [], JSON.stringify(errors));
      db.close();
    });
  }
});

// deleteWorkflow issues a real DELETE (it does not archive), and the module
// header promises "a user who edits or DELETES it keeps their choice". Gating the
// whole step on `current < SCHEMA_VERSION` so the refresh re-runs on every bump
// made the INSERT re-run too, resurrecting a workflow the user removed on
// purpose. Seed once; refresh always.
test('a workflow the user deleted is not resurrected by a later version bump', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.prepare("DELETE FROM workflows WHERE id = 'wf_presentation'").run();
  db.exec('PRAGMA user_version = 40');                 // at the seed's own version, so it will not re-fire
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
