// test/db-migrate-v44.test.mjs
// v44: ask_threads.mcp_off (MCP registry §9.4 — the per-chat picker's switched-off sets and
// memberships). The fresh-DB path, the ladder path (stamped v43, column missing) and the
// self-heal path (stamped past current). Modelled on test/db-migrate-v40.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate, SCHEMA_VERSION } from '../src/core/db.mjs';

const cols = (db) => db.prepare('PRAGMA table_info(ask_threads)').all().map((c) => c.name);
const version = (db) => db.prepare('PRAGMA user_version').get().user_version;

test('v44 adds the nullable ask_threads.mcp_off on a fresh DB', () => {
  assert.ok(SCHEMA_VERSION >= 44);
  const db = new DatabaseSync(':memory:');
  migrate(db);
  assert.ok(cols(db).includes('mcp_off'));
  assert.equal(version(db), SCHEMA_VERSION);
  db.close();
});

test('a v43-stamped DB without the column is healed by the ladder in ONE migrate, rows kept, NULL', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.prepare("INSERT INTO ask_threads (id, title, created_at, updated_at) VALUES ('ask_00000001', 'kept', 't', 't')").run();
  db.exec('ALTER TABLE ask_threads DROP COLUMN mcp_off; PRAGMA user_version = 43;');
  assert.ok(!cols(db).includes('mcp_off'), 'precondition: dropped');
  migrate(db);
  assert.ok(cols(db).includes('mcp_off'));
  assert.equal(version(db), SCHEMA_VERSION);
  assert.deepEqual({ ...db.prepare('SELECT title, mcp_off FROM ask_threads').get() }, { title: 'kept', mcp_off: null });
  db.close();
});

test('self-heal: stamped past current, column missing, is ALTERed and not re-stamped', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.exec(`ALTER TABLE ask_threads DROP COLUMN mcp_off; PRAGMA user_version = ${SCHEMA_VERSION + 1};`);
  migrate(db);
  assert.equal(version(db), SCHEMA_VERSION + 1);
  assert.ok(cols(db).includes('mcp_off'));
  db.close();
});
