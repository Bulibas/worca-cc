import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DIRECTIONS_FILE, appendDirection, appendConsumption, readDirections, pendingDirections, renderDirectionsBlock,
} from '../src/core/directions.mjs';

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'worca-dir-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('append + read-back: ids are unique, records carry ts/source/text', () => withDir(async (dir) => {
  const a = await appendDirection(dir, { text: 'cut the roadmap section', source: 'ui' });
  const b = await appendDirection(dir, { text: 'accent is too pale', source: 'chat:telegram' });
  assert.notEqual(a.id, b.id);
  assert.match(a.id, /^d[a-z0-9]{6,}$/);
  const parsed = await readDirections(dir);
  assert.deepEqual(parsed.directions.map((d) => d.text), ['cut the roadmap section', 'accent is too pale']);
  assert.equal(parsed.malformed, 0);
  assert.equal(pendingDirections(parsed).length, 2);
}));

test('a consumption record removes the direction from pending; unknown ids are ignored', () => withDir(async (dir) => {
  const a = await appendDirection(dir, { text: 'x', source: 'ui' });
  await appendDirection(dir, { text: 'y', source: 'ui' });
  await appendConsumption(dir, { id: a.id, consumedBy: 'x:n_build:2' });
  await appendConsumption(dir, { id: 'd_nope', consumedBy: 'x:n_build:2' });
  const parsed = await readDirections(dir);
  assert.deepEqual(pendingDirections(parsed).map((d) => d.text), ['y']);
  assert.deepEqual(parsed.consumed.get(a.id), ['x:n_build:2']);
}));

test('a torn/malformed line is skipped and counted, never thrown', () => withDir(async (dir) => {
  await appendDirection(dir, { text: 'ok', source: 'ui' });
  await appendFile(join(dir, DIRECTIONS_FILE), '{"id":"d1","ts":', 'utf8');
  const parsed = await readDirections(dir);
  assert.equal(parsed.directions.length, 1);
  assert.equal(parsed.malformed, 1);
}));

test('missing file reads as empty; the prompt block is "" when nothing is pending', () => withDir(async (dir) => {
  const parsed = await readDirections(dir);
  assert.deepEqual(parsed.directions, []);
  assert.equal(renderDirectionsBlock([], 'x:n_a:1'), '');
  const block = renderDirectionsBlock([{ id: 'd1', ts: '2026-09-15T10:22:31Z', source: 'ui', text: 'cut the roadmap' }], 'x:n_build:2');
  assert.match(block, /^## New directions since the last step/m);
  assert.match(block, /- \*\*d1\*\* \(ui, 2026-09-15T10:22:31Z\): cut the roadmap/);
  assert.match(block, /"consumedBy":"x:n_build:2"/);
}));

// ROUND 3, F4. THE SETTLE WINDOW. postDirection gates on the DB ROW, but a
// terminal run sets its in-memory status first and only persists after
// _finalizeDirections has already computed the done summary: for that whole window
// (a readFile, sometimes an appendAudit) the row still reads `running`, the route
// answered 201, and the record landed in directions.ndjson where nothing would
// ever read it — `pending` was already empty, so chat, the CLI and the audit all
// reported nothing. A write nobody reads and nobody is told about is worse than a
// refusal, and every caller already renders RUN_FINISHED.
test('direct() refuses once the run has settled, even before the row is persisted', async () => {
  const { RunHarness } = await import('../src/core/run-harness.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'worca-settle-'));
  try {
    const harness = Object.create(RunHarness.prototype);
    harness.pipeline = { dir, id: 'pipe-settle01' };

    for (const status of ['done', 'error', 'stopped']) {
      harness.state = { status };
      await assert.rejects(
        () => harness.direct('cut the roadmap slide'),
        (e) => e.code === 'RUN_FINISHED',
        `a direction was accepted for a ${status} run`,
      );
    }
    // Nothing was written for any of them.
    assert.deepEqual((await readDirections(dir)).directions, [], 'a refused direction still hit the inbox');

    // `paused` is NOT closed — replaying the inbox on resume is the whole point —
    // so it must get past the guard. (It then fails deeper, on the un-wired
    // harness; what matters is that it is not RUN_FINISHED.)
    harness.state = { status: 'paused' };
    await harness.direct('still readable').catch((e) => {
      assert.notEqual(e.code, 'RUN_FINISHED', 'a paused run must still take a direction');
    });
    assert.equal((await readDirections(dir)).directions.length, 1, 'the paused run did not record it');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
