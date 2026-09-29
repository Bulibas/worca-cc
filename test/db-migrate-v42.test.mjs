// v42: re-kind the deck subresources already indexed on finished runs.
//
// Until v41 the deck ports swept `deck/*` under one `deck` kind, so a finished
// presentation run indexed its kit scripts, fonts and instrumented proof copy
// beside the two files a human actually opens — 8 rows where 3 were meaningful,
// on top of one row per screenshot. The sidecars now split deliverables from
// subresources; this backfills the runs that already exist, applying the SAME
// rule the ports do. The rows are not dropped: the raw-bytes route resolves
// `rel` only among indexed rows, so deleting them would 404 deck.html's own
// <script src> and @font-face and break the stored deck's preview.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { migrate, SCHEMA_VERSION } from '../src/core/db.mjs';

const KINDS = [
  ['deck', 'deck/deck.html'],
  ['deck', 'deck/deck-b.html'],
  ['deck', 'deck/deck.standalone.html'],
  ['deck', 'deck/deck.pdf'],
  ['deck', 'deck/deck-stage.js'],
  ['deck', 'deck/deck-enhance.js'],
  ['deck', 'deck/proof.html'],
  ['deck', 'deck/poppins-latin-400-normal.woff2'],
  ['deck-shot', 'shots/s01.png'],
  ['deck-manifest', 'deck-manifest.md'],
];

function seeded() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.prepare("INSERT INTO pipelines (id, project_key) VALUES ('p1', 'proj-0cea65fb')").run();
  const ins = db.prepare('INSERT INTO artifacts (pipeline_id, kind, rel_path) VALUES (?, ?, ?)');
  for (const [kind, rel] of KINDS) ins.run('p1', kind, rel);
  db.exec('PRAGMA user_version = 41');
  return db;
}
const kindOf = (db, rel) => db.prepare('SELECT kind FROM artifacts WHERE pipeline_id = ? AND rel_path = ?').get('p1', rel)?.kind;

test('the ladder re-kinds deck subresources and leaves the deliverables alone', () => {
  assert.ok(SCHEMA_VERSION >= 42);
  const db = seeded();
  migrate(db);

  for (const rel of ['deck/deck.html', 'deck/deck-b.html', 'deck/deck.standalone.html', 'deck/deck.pdf']) {
    assert.equal(kindOf(db, rel), 'deck', rel);
  }
  for (const rel of ['deck/deck-stage.js', 'deck/deck-enhance.js', 'deck/proof.html', 'deck/poppins-latin-400-normal.woff2']) {
    assert.equal(kindOf(db, rel), 'deck-asset', rel);
  }
  // Untouched: other kinds, and anything outside deck/.
  assert.equal(kindOf(db, 'shots/s01.png'), 'deck-shot');
  assert.equal(kindOf(db, 'deck-manifest.md'), 'deck-manifest');
  assert.equal(db.prepare('SELECT count(*) n FROM artifacts').get().n, KINDS.length, 'no row is dropped');
  db.close();
});

test('re-running the step is idempotent, even against an existing deck-asset row', () => {
  const db = seeded();
  db.prepare("INSERT INTO artifacts (pipeline_id, kind, rel_path) VALUES ('p1', 'deck-asset', 'deck/deck-stage.js')").run();
  migrate(db);
  assert.equal(kindOf(db, 'deck/deck-stage.js'), 'deck-asset');
  db.exec('PRAGMA user_version = 41');
  migrate(db);
  assert.equal(kindOf(db, 'deck/deck-stage.js'), 'deck-asset');
  assert.equal(db.prepare("SELECT count(*) n FROM artifacts WHERE rel_path = 'deck/deck-stage.js'").get().n, 1);
  db.close();
});

// A real pre-attribution install sits at user_version 29 with a three-column
// `artifacts` table; step_key/node_id/cycle/created_at are declared only in
// INCREMENTAL_COLUMNS and materialise through repairSchemaGaps, whose last
// ladder call lives in applySchemaV29. Upgrading 29 -> 32 skips V29 (current is
// not < 29), runs V41/V42, stamps 32, and never reaches reconcileSchema (that
// is the current >= SCHEMA_VERSION fast path) — so the columns never arrive.
//
// The blast radius is the whole first session after upgrade, because the handle
// is a process singleton: recordArtifact's INSERT names all seven columns and
// throws into its own best-effort catch, so NOTHING is indexed — no viewer rows,
// no exact unlink on delete, and deck.html's <script src> 404s on the raw route
// because `rel` only resolves among indexed rows.
//
// Every other migration test stamps a version onto an ALREADY-migrated DB, so
// the table is already wide and none of them can catch this. This one reshapes.
function v29Install() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.exec(`
    PRAGMA foreign_keys=OFF;
    DROP TABLE artifacts;
    CREATE TABLE artifacts (
      pipeline_id TEXT NOT NULL,
      kind        TEXT NOT NULL,
      rel_path    TEXT NOT NULL,
      PRIMARY KEY (pipeline_id, kind, rel_path),
      FOREIGN KEY (pipeline_id) REFERENCES pipelines (id) ON DELETE CASCADE
    );
    PRAGMA user_version = 29;
  `);
  return db;
}

test('a v29 install gains the artifacts attribution columns on the way to 32', () => {
  const db = v29Install();
  assert.deepEqual(db.prepare('PRAGMA table_info(artifacts)').all().map((c) => c.name),
    ['pipeline_id', 'kind', 'rel_path'], 'the fixture really is the narrow pre-attribution shape');

  migrate(db);

  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  const cols = db.prepare('PRAGMA table_info(artifacts)').all().map((c) => c.name);
  for (const need of ['step_key', 'node_id', 'cycle', 'created_at']) {
    assert.ok(cols.includes(need), `artifacts.${need} is missing after 29 -> ${SCHEMA_VERSION}`);
  }
  db.close();
});

test('and the attributed INSERT recordArtifact uses actually runs after that upgrade', () => {
  const db = v29Install();
  migrate(db);
  db.prepare("INSERT INTO pipelines (id, project_key) VALUES ('p9', 'proj-0cea65fb')").run();
  db.prepare(`INSERT INTO artifacts (pipeline_id, kind, rel_path, step_key, node_id, cycle, created_at)
              VALUES ('p9', 'deck-shot', 'shots/s01.png', 'x:n_audit:1', 'n_audit', 1, 't')`).run();
  const row = db.prepare("SELECT step_key, node_id, cycle FROM artifacts WHERE pipeline_id = 'p9'").get();
  // Spread: node:sqlite hands back null-prototype rows, which strict deepEqual rejects.
  assert.deepEqual({ ...row }, { step_key: 'x:n_audit:1', node_id: 'n_audit', cycle: 1 });
  db.close();
});

// applySchemaV32 repairs incremental gaps because nothing between V29 and V42
// does — but V41 runs FIRST and returns early when any of `workflows`' declared
// columns is absent. On a divergently-stamped DB missing one, the presentation
// seed is skipped, V42 then adds the column, the version is stamped, and the
// ladder never re-enters `current < 31`: wf_presentation is never seeded on that
// install. The repair has to happen before the step that depends on it.
test('a DB missing a workflows column still gets wf_presentation seeded', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.prepare('DELETE FROM workflows WHERE id = ?').run('wf_presentation');
  // Reshape `workflows` without `archived_at` (an INCREMENTAL_COLUMNS entry), the
  // way a checkout with a divergent ladder leaves it.
  db.exec(`
    PRAGMA foreign_keys=OFF;
    CREATE TABLE workflows_narrow AS
      SELECT id, name, version, domain, origin, steps, feedbacks, graph, created_at, updated_at FROM workflows;
    DROP TABLE workflows;
    ALTER TABLE workflows_narrow RENAME TO workflows;
    PRAGMA user_version = 29;
  `);
  assert.ok(!db.prepare('PRAGMA table_info(workflows)').all().map((c) => c.name).includes('archived_at'),
    'the fixture really is missing the column');

  migrate(db);

  assert.ok(db.prepare('PRAGMA table_info(workflows)').all().map((c) => c.name).includes('archived_at'),
    'the gap was repaired');
  assert.ok(db.prepare("SELECT id FROM workflows WHERE id = 'wf_presentation'").get(),
    'and the seed ran, because the repair happened before the step that needs it');
  db.close();
});

// The hoisted repair exists because nothing between V29 and V41/V42 heals the
// INCREMENTAL_COLUMNS, and it was gated on a LITERAL 32. On the next bump a DB
// stamped 32 skips applySchemaV29 (current >= 29) and skips the repair too
// (32 < 32 is false), so a newly declared incremental column never arrives —
// unless whoever writes applySchemaV33 happens to remember. Gating it on
// SCHEMA_VERSION makes it self-maintaining, which is the property this guard
// pins: a literal here is the bug.
test('the hoisted schema repair is gated on SCHEMA_VERSION, never a literal', () => {
  const src = readFileSync('src/core/db.mjs', 'utf8');
  assert.match(src, /if \(current < SCHEMA_VERSION\) repairSchemaGaps\(/,
    'the repair must re-enter on every future bump');
  assert.doesNotMatch(src, /if \(current < \d+\) repairSchemaGaps\(/,
    'a version literal on the repair silently retires it at the next bump');
});
