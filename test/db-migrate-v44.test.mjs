// v44 (scheduled resume): scheduled_runs.resume_pipeline_id — added to a DB stamped 43 by
// the gap repair, and present in a fresh DDL. NULL on every pre-v44 row = "starts a new run".
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { useTempHome } from './helpers/temp-home.mjs';
import { getDb, migrate, SCHEMA_VERSION, _resetForTests } from '../src/core/db.mjs';

useTempHome(after);

const cols = (db) => db.prepare('PRAGMA table_info(scheduled_runs)').all().map((c) => c.name);

test('a DB stamped 43 gains resume_pipeline_id', () => {
  let db = getDb();
  assert.ok(SCHEMA_VERSION >= 44);
  db.exec('ALTER TABLE scheduled_runs DROP COLUMN resume_pipeline_id');
  db.exec('PRAGMA user_version = 43');
  _resetForTests();

  db = getDb();                                    // 40 -> 44 on the ladder
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.ok(cols(db).includes('resume_pipeline_id'));
});

// The fresh-DB idiom of test/db-migrate-v34.test.mjs: a REAL new database, not a reopen
// of the already-migrated home file (which would assert nothing).
test('a fresh DB has resume_pipeline_id from the DDL', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  assert.ok(cols(db).includes('resume_pipeline_id'));
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  db.close();
});
