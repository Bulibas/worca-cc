// test/db-migrate-v50.test.mjs — v50 = the terminal's tables (issue #573). A DB stamped 49 gains them
// through the ladder; a DB stamped past 50 by another branch without them is healed by repairSchemaGaps.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempHome } from './helpers/temp-home.mjs';
import { getDb, SCHEMA_VERSION, _resetForTests } from '../src/core/db.mjs';

useTempHome(after);
const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name);
const TABLES = ['terminal_sessions', 'terminal_blocks', 'terminal_audit', 'terminal_worktrees'];

test('a DB stamped 49 gains the terminal tables', () => {
  let db = getDb();
  assert.ok(SCHEMA_VERSION >= 50);
  for (const t of TABLES) db.exec(`DROP TABLE ${t}`);
  db.exec('PRAGMA user_version = 49');
  _resetForTests();
  db = getDb();
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.deepEqual(cols(db, 'terminal_blocks'), ['id', 'session_id', 'seq', 'source', 'run_id', 'member', 'command', 'cwd', 'status',
    'exit_code', 'started_at', 'ended_at', 'duration_ms', 'output', 'output_bytes', 'output_truncated', 'run_by', 'stopped_by']);
  assert.ok(cols(db, 'terminal_sessions').includes('created_by'));
  assert.deepEqual(cols(db, 'terminal_audit'), ['id', 'ts', 'session_id', 'block_seq', 'run_id', 'actor', 'action', 'detail']);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_terminal_blocks_run'").get());
});

test('a DB stamped at the current version without the tables is repaired', () => {
  let db = getDb();
  db.exec('DROP TABLE terminal_audit');
  _resetForTests();
  db = getDb();
  assert.ok(cols(db, 'terminal_audit').length > 0);
});

test('terminal_sessions.scope is free text: run, project and branch sessions all fit (no CHECK to migrate)', () => {
  const db = getDb();
  assert.doesNotMatch(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'terminal_sessions'").get().sql, /CHECK/i);
});
