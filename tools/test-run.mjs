// tools/test-run.mjs — child of tools/test.mjs (which sets the hermetic env). Runs the
// file list through node:test's run(): same per-file process isolation as `node --test`,
// no command-line length limit. Optionally records per-file seconds (sum of top-level tests).
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { relative, resolve } from 'node:path';

const { files, concurrency, timingsOut } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const perFile = {};
// Fail closed: only the run's final summary (the one without a `file`) turns this green.
// It decides exactly like `node --test` (a failing `todo` test emits test:fail yet stays
// green), and a run that dies before its summary stays red.
process.exitCode = 1;
const stream = run({
  files: files.map((f) => resolve(f)),
  concurrency: concurrency || Math.max(1, availableParallelism() - 1),
  timeout: 300_000,
});
const note = (ev) => {
  if (ev.nesting !== 0 || !ev.file) return;
  const f = relative(process.cwd(), ev.file).replace(/\\/g, '/');
  perFile[f] = (perFile[f] || 0) + (ev.details?.duration_ms || 0) / 1000;
};
stream.on('test:pass', note);
stream.on('test:fail', note);
stream.on('test:summary', (ev) => { if (ev.file === undefined) process.exitCode = ev.success ? 0 : 1; });
stream.compose(spec).pipe(process.stdout);
stream.on('close', () => {
  if (timingsOut) writeFileSync(timingsOut, JSON.stringify(Object.fromEntries(Object.entries(perFile).map(([k, v]) => [k, Math.round(v * 100) / 100]))));
});
