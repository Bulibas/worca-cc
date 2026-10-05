// test/subagent-migration.test.mjs
// Layer A (DB) — forward incremental migrations that add the sub-agent tables
// and columns. Each row seeds a REAL on-disk DB stamped at an old user_version
// (1, 2, 5, 6, 7), opens it through the production getDb() — a file-backed climb
// of the WHOLE ladder from mid-way, the only such climbs from a pre-v10 stamp —
// and asserts its step ran: the table/column exists, user_version is now
// SCHEMA_VERSION, and pre-existing tables/rows survived. One fresh home and
// _resetForTests() per row; never :memory: and never a shared home.
// The v1 row is the first incremental (v1->vN) migration in the codebase.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getDb, _resetForTests, dbPath, SCHEMA_VERSION } from '../src/core/db.mjs';
import { worcaHome } from '../src/core/projects.mjs';
import { checkRows } from './helpers/rows.mjs';

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite');

const homes = [];
async function freshHome() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'worca-cc-subagent-mig-')));
  homes.push(dir);
  _resetForTests();
  process.env.WORCA_HOME = dir;
}
after(async () => {
  _resetForTests();
  delete process.env.WORCA_HOME;
  await Promise.all(homes.map((d) => rm(d, { recursive: true, force: true })));
});

// The exact v1 pipelines DDL (the only table sub_agents FKs to) + the v1
// pipeline_steps DDL (the v5 ladder step ALTERs it, so a faithful pre-v2 seed
// must carry it). Seeding these + user_version=1 reproduces a real pre-v2
// install for the upgrade path.
const V1_PIPELINES = `
  CREATE TABLE pipelines (
    id TEXT PRIMARY KEY, project_key TEXT NOT NULL, workspace_key TEXT,
    target TEXT NOT NULL DEFAULT 'project', title TEXT, base_name TEXT,
    date_prefix TEXT, status TEXT NOT NULL DEFAULT 'created',
    phase TEXT NOT NULL DEFAULT 'created', cycle INTEGER NOT NULL DEFAULT 0,
    started_at TEXT, updated_at TEXT, total_cost_usd REAL NOT NULL DEFAULT 0,
    total_active_ms INTEGER NOT NULL DEFAULT 0, prompt TEXT, branch TEXT,
    workspace_meta TEXT, stepper TEXT, tools TEXT
  );
  CREATE TABLE pipeline_steps (
    pipeline_id TEXT NOT NULL, key TEXT NOT NULL, node_id TEXT, phase TEXT,
    step_index INTEGER, cycle INTEGER, status TEXT, started_at TEXT,
    updated_at TEXT, active_ms INTEGER NOT NULL DEFAULT 0, running_since TEXT,
    cost_usd REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (pipeline_id, key),
    FOREIGN KEY (pipeline_id) REFERENCES pipelines (id) ON DELETE CASCADE
  );
  CREATE TABLE workflows (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
    steps TEXT NOT NULL DEFAULT '[]', feedbacks TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE config_workflow_nodes (
    project_key TEXT NOT NULL, workflow_id TEXT NOT NULL, node_id TEXT NOT NULL,
    model TEXT, effort TEXT, fan_out INTEGER,
    PRIMARY KEY (project_key, workflow_id, node_id)
  );
`;
const V2_SUB_AGENTS = `
  CREATE TABLE sub_agents (
    pipeline_id TEXT NOT NULL, id TEXT NOT NULL, step_key TEXT, node_id TEXT,
    step_index INTEGER, cycle INTEGER, label TEXT,
    status TEXT NOT NULL DEFAULT 'running', started_at TEXT, finished_at TEXT,
    duration_ms INTEGER, tokens INTEGER, cost_usd REAL,
    PRIMARY KEY (pipeline_id, id),
    FOREIGN KEY (pipeline_id) REFERENCES pipelines (id) ON DELETE CASCADE
  );
  CREATE INDEX idx_sub_agents_pipeline ON sub_agents (pipeline_id);
  CREATE INDEX idx_sub_agents_step ON sub_agents (pipeline_id, step_key);
`;
// Minimal v5 seed: pipelines + sub_agents(+ui_phase) + pipeline_steps(+session_id), stamped user_version=5.
// (Only sub_agents and pipeline_steps are touched by the v5->v6 migration, so the minimal
//  seed is sufficient — migrate() runs ONLY `if (current < 6)` from a v5-stamped DB.)
const V5_SEED = `
CREATE TABLE pipelines (id TEXT PRIMARY KEY, project_key TEXT);
CREATE TABLE sub_agents (pipeline_id TEXT, id TEXT, ui_phase TEXT, PRIMARY KEY (pipeline_id,id));
CREATE TABLE pipeline_steps (pipeline_id TEXT, key TEXT, session_id TEXT, PRIMARY KEY (pipeline_id,key));
CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT, steps TEXT, feedbacks TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE config_workflow_nodes (project_key TEXT, workflow_id TEXT, node_id TEXT, model TEXT, effort TEXT, fan_out INTEGER, PRIMARY KEY (project_key,workflow_id,node_id));
INSERT INTO pipelines (id, project_key) VALUES ('p1','proj');
`;
// Minimal v6 seed: pipelines + sub_agents(+skills) + pipeline_steps(+skills),
// stamped user_version=6. migrate() runs the v7 step (subagent_type on sub_agents)
// AND the v8 step (graphify_count on BOTH agent tables) from this v6-stamped DB, so
// the seed must carry pipeline_steps too — a real v6 DB has it (from v1, +skills at
// v6). Both tables carry their full v6 columns so the later ALTERs are the only delta.
const V6_SEED = `
CREATE TABLE pipelines (id TEXT PRIMARY KEY, project_key TEXT);
CREATE TABLE sub_agents (pipeline_id TEXT, id TEXT, skills TEXT, PRIMARY KEY (pipeline_id,id));
CREATE TABLE pipeline_steps (pipeline_id TEXT, key TEXT, skills TEXT, PRIMARY KEY (pipeline_id,key));
CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT, steps TEXT, feedbacks TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE config_workflow_nodes (project_key TEXT, workflow_id TEXT, node_id TEXT, model TEXT, effort TEXT, fan_out INTEGER, PRIMARY KEY (project_key,workflow_id,node_id));
INSERT INTO pipelines (id, project_key) VALUES ('p1','proj');
`;
// Minimal v7 seed: pipelines + sub_agents(+skills,+subagent_type) + pipeline_steps(+skills),
// stamped user_version=7. The v7->v8 migration adds graphify_count to BOTH agent tables,
// so the seed carries both with their full v7 columns and the v8 ALTERs are the only delta.
const V7_SEED = `
CREATE TABLE pipelines (id TEXT PRIMARY KEY, project_key TEXT);
CREATE TABLE sub_agents (pipeline_id TEXT, id TEXT, skills TEXT, subagent_type TEXT, PRIMARY KEY (pipeline_id,id));
CREATE TABLE pipeline_steps (pipeline_id TEXT, key TEXT, skills TEXT);
CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT, steps TEXT, feedbacks TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE config_workflow_nodes (project_key TEXT, workflow_id TEXT, node_id TEXT, model TEXT, effort TEXT, fan_out INTEGER, PRIMARY KEY (project_key,workflow_id,node_id));
INSERT INTO pipelines (id, project_key) VALUES ('p1','proj');
`;

// One row per ladder step: v = the version whose step adds the column, stamp =
// the seeded user_version. [table, col] pairs: col null = the table itself.
// absent: missing from the seed; present: there after getDb(). indexes: the
// sub_agents indexes the step creates. keepsRow: the seeded pipelines 'p1' row.
const LADDER = [
  { name: 'opening a user_version=1 DB forward-migrates to v2 (adds sub_agents + indexes)',
    v: 2, stamp: 1, seed: [V1_PIPELINES],
    absent: [['sub_agents', null]],
    present: [['sub_agents', null], ['pipelines', null]],
    indexes: ['idx_sub_agents_pipeline', 'idx_sub_agents_step'] },
  { name: 'opening a user_version=2 DB forward-migrates to v3 (adds sub_agents.ui_phase)',
    v: 3, stamp: 2, seed: [V1_PIPELINES, V2_SUB_AGENTS],
    absent: [['sub_agents', 'ui_phase']],
    present: [['sub_agents', 'ui_phase'], ['sub_agents', null]] },
  { name: 'opening a user_version=5 DB forward-migrates to v6 (adds skills to both agent tables)',
    v: 6, stamp: 5, seed: [V5_SEED],
    absent: [['sub_agents', 'skills']],
    present: [['sub_agents', 'skills'], ['pipeline_steps', 'skills']], keepsRow: true },
  { name: 'opening a user_version=6 DB forward-migrates to v7 (adds subagent_type to sub_agents)',
    v: 7, stamp: 6, seed: [V6_SEED],
    absent: [['sub_agents', 'subagent_type']],
    present: [['sub_agents', 'subagent_type']], keepsRow: true },
  { name: 'opening a user_version=7 DB forward-migrates to v8 (adds graphify_count to both agent tables)',
    v: 8, stamp: 7, seed: [V7_SEED],
    absent: [['sub_agents', 'graphify_count'], ['pipeline_steps', 'graphify_count']],
    present: [['sub_agents', 'graphify_count'], ['pipeline_steps', 'graphify_count']], keepsRow: true },
];

const at = (row, table, col) => `v${row.v} stamp ${row.stamp} ${table}.${col ?? '*'}`;
function has(db, table, col) {
  if (col === null) {
    return db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name=?").get(table).n === 1;
  }
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name).includes(col);
}

test('opening a user_version=N DB forward-migrates to SCHEMA_VERSION with each sub-agent column added (table-driven: v1 sub_agents+indexes, v2 ui_phase, v5 skills, v6 subagent_type, v7 graphify_count)', async () => {
  await checkRows(LADDER.map((row) => ({
    name: row.name,
    run: async () => {
      await freshHome();
      // 1) Seed a real DB file at <worcaHome>/worca-cc.db, stamped at the old version.
      mkdirSync(worcaHome(), { recursive: true });
      const seed = new DatabaseSync(dbPath());
      for (const ddl of row.seed) seed.exec(ddl);
      seed.exec(`PRAGMA user_version = ${row.stamp}`);
      assert.equal(seed.prepare('PRAGMA user_version').get().user_version, row.stamp, `${at(row, 'PRAGMA', 'user_version')}: seeded at v${row.stamp}`);
      for (const [table, col] of row.absent) {
        assert.ok(!has(seed, table, col), `${at(row, table, col)}: absent from the seed (pre-v${row.v})`);
      }
      seed.close();

      // 2) Open through production getDb() — migrate() must run the ladder from the stamp.
      const db = getDb();
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION, `${at(row, 'PRAGMA', 'user_version')}: forward-migrated to the current version`);
      for (const [table, col] of row.present) {
        assert.ok(has(db, table, col), `${at(row, table, col)}: present after the migration (added or preserved)`);
      }
      if (row.indexes) {
        const idx = db.prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_sub_agents_%' ORDER BY name"
        ).all().map((r) => r.name);
        assert.deepEqual(idx, row.indexes, `${at(row, 'sub_agents', 'indexes')}: both sub_agents indexes created`);
      }
      // 3) Data-preserving migration: the seeded row survives.
      if (row.keepsRow) {
        assert.ok(db.prepare("SELECT 1 FROM pipelines WHERE id='p1'").get(), `${at(row, 'pipelines', 'p1')}: pre-existing data preserved`);
      }
    },
  })));
});
