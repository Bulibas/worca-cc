// test/db-migrate-v46.test.mjs
// v46 = night_decisions (Away mode: one row per answered ask). A DB stamped 45 gains the
// table through the ladder; a DB stamped 44 by the old local night-mode branch (which had
// night_decisions at v44) keeps its rows and gains dev's v44/v45 columns.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempHome } from './helpers/temp-home.mjs';
import { getDb, SCHEMA_VERSION, _resetForTests } from '../src/core/db.mjs';

useTempHome(after);

const cols = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
const NIGHT_COLS = ['id', 'pipeline_id', 'question_id', 'kind', 'ts', 'record'];

test('a DB stamped 45 gains night_decisions through the ladder', () => {
  let db = getDb();
  assert.ok(SCHEMA_VERSION >= 46);
  assert.deepEqual(cols(db, 'night_decisions'), NIGHT_COLS);
  db.exec('DROP TABLE night_decisions');
  db.exec('PRAGMA user_version = 45');
  _resetForTests();

  db = getDb();
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.deepEqual(cols(db, 'night_decisions'), NIGHT_COLS);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_night_decisions_pipeline'").get());
});

test('a DB stamped 44 by the old night-mode branch keeps night_decisions and gains the v44/v45 columns', () => {
  let db = getDb();
  db.exec('ALTER TABLE scheduled_runs DROP COLUMN resume_pipeline_id');
  db.exec('ALTER TABLE ask_threads DROP COLUMN mcp_off');
  db.exec('PRAGMA user_version = 44');
  _resetForTests();

  db = getDb();
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.deepEqual(cols(db, 'night_decisions'), NIGHT_COLS);
  assert.ok(cols(db, 'scheduled_runs').includes('resume_pipeline_id'));
  assert.ok(cols(db, 'ask_threads').includes('mcp_off'));
});
