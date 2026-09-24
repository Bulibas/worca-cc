// A direction posted to a PAUSED run reaches directions.ndjson and the index, but
// its `direction:posted` line never reached live-log.ndjson: the orchestrator's
// finally has already closed the log writer, and push() is a documented no-op
// after close. History therefore showed the direction being APPLIED after the
// resume with no record of it ever having been posted.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useTempHome } from './helpers/temp-home.mjs';
import { seedPipeline } from './helpers/db-seed.mjs';
import { createOrchestrator } from '../src/core/orchestrator.mjs';
import { createRunLogWriter } from '../src/core/run-log.mjs';
import { getDb } from '../src/core/db.mjs';

useTempHome(after);

test('a direction posted while the run log is closed still leaves a record', async () => {
  const projDir = await mkdtemp(join(tmpdir(), 'worca-direct-paused-'));
  const { id, dir } = await seedPipeline(projDir, { title: 'P', status: 'paused' });
  const orch = createOrchestrator({ projectDir: projDir, prompt: 'x', claude: { mock: true } });
  orch.pipeline = { id, dir };
  const writer = createRunLogWriter();
  writer.bind(dir);
  await writer.close();                       // exactly what the paused run left behind
  orch.logWriter = writer;

  const rec = await orch.direct('cut the roadmap slide', 'ui');
  assert.ok(rec && rec.id, 'the direction itself is filed');

  const text = getDb().prepare('SELECT text FROM pipeline_events WHERE pipeline_id = ?')
    .all(id).map((e) => e.text || '').join('\n');
  assert.match(text, new RegExp(rec.id), `the posting is recorded somewhere durable:\n${text}`);
});
