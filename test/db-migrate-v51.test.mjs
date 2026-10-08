// test/db-migrate-v51.test.mjs — v51 = ask_threads.agent_mode (issue #574, Ask agent mode). An INCREMENTAL_COLUMNS
// entry: a v50 DB without the column gains it on open through the hoisted repairSchemaGaps (no ladder step).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempHome } from './helpers/temp-home.mjs';
import { getDb, SCHEMA_VERSION, _resetForTests } from '../src/core/db.mjs';

useTempHome(after);
const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name);

test('a DB stamped 50 without ask_threads.agent_mode gains it; user_version reads the current version', () => {
  let db = getDb();
  assert.ok(SCHEMA_VERSION >= 51);
  db.exec('ALTER TABLE ask_threads DROP COLUMN agent_mode');
  db.exec('PRAGMA user_version = 50');
  assert.ok(!cols(db, 'ask_threads').includes('agent_mode'));
  _resetForTests();
  db = getDb();
  assert.ok(cols(db, 'ask_threads').includes('agent_mode'));
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
});
