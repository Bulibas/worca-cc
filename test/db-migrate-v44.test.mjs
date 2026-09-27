// test/db-migrate-v44.test.mjs
// v44 = night_decisions (night mode: one row per night-decided ask). A DB stamped 43
// gains the table through the ladder.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempHome } from './helpers/temp-home.mjs';
import { getDb, SCHEMA_VERSION, _resetForTests } from '../src/core/db.mjs';

useTempHome(after);

const cols = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);

test('a DB stamped 43 gains night_decisions through the ladder', () => {
  let db = getDb();
  assert.ok(SCHEMA_VERSION >= 44);
  assert.deepEqual(cols(db, 'night_decisions'), ['id', 'pipeline_id', 'question_id', 'kind', 'ts', 'record']);
  db.exec('DROP TABLE night_decisions');
  db.exec('PRAGMA user_version = 43');
  _resetForTests();

  db = getDb();
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.deepEqual(cols(db, 'night_decisions'), ['id', 'pipeline_id', 'question_id', 'kind', 'ts', 'record']);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_night_decisions_pipeline'").get());
});
