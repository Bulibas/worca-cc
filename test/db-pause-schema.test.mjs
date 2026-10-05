// test/db-pause-schema.test.mjs
// writeState round-trips pipelines.resume_point + pipeline_steps.session_id (and clears
// resume_point when state carries none). The v5 columns themselves are pinned by the
// fresh-DB and self-heal tests in test/db.test.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTempHome } from './helpers/temp-home.mjs';
import { getDb } from '../src/core/db.mjs';
import { writeState } from '../src/core/artifacts.mjs';
import { checkRows } from './helpers/rows.mjs';

useTempHome(after);

test('writeState round-trips resumePoint + per-step sessionId and clears resume_point when state carries none', async () => {
  await checkRows([
    { name: 'writeState persists resumePoint and per-step sessionId', run: async () => {
      const dir = mkdtempSync(join(tmpdir(), 'worca-cc-pause-'));
      const rp = { version: 1, kind: 'node', stepIndex: 2, pausedAt: '2026-06-09T00:00:00Z' };
      await writeState(dir, {
        id: 'pl_test1', projectKey: 'proj-1', status: 'paused', phase: 'implement', cycle: 1,
        resumePoint: rp,
        steps: [{ key: '2:n_impl', nodeId: 'n_impl', phase: 'implementer', stepIndex: 2, cycle: 1,
                  status: 'paused', startedAt: 't', updatedAt: 't', activeMs: 5, runningSince: null,
                  costUsd: 0, sessionId: 'sess-abc' }],
      });
      const row = getDb().prepare('SELECT resume_point FROM pipelines WHERE id = ?').get('pl_test1');
      assert.deepEqual(JSON.parse(row.resume_point), rp);
      const step = getDb().prepare('SELECT session_id FROM pipeline_steps WHERE pipeline_id = ?').get('pl_test1');
      assert.equal(step.session_id, 'sess-abc');
    } },
    { name: 'writeState clears resume_point when state carries none', run: async () => {
      const dir = mkdtempSync(join(tmpdir(), 'worca-cc-pause2-'));
      await writeState(dir, { id: 'pl_test2', projectKey: 'proj-1', status: 'paused', phase: 'x', cycle: 0,
        resumePoint: { version: 1, kind: 'boundary', stepIndex: 0 }, steps: [] });
      await writeState(dir, { id: 'pl_test2', projectKey: 'proj-1', status: 'running', phase: 'x', cycle: 0, steps: [] });
      const row = getDb().prepare('SELECT resume_point FROM pipelines WHERE id = ?').get('pl_test2');
      assert.equal(row.resume_point, null);
    } },
  ]);
});

