// src/core/directions.mjs
// The direction inbox: <pipelineDir>/directions.ndjson, append-only, one JSON
// object per line, two record shapes:
//   {"id":"d3","ts":"…","source":"ui","text":"cut the roadmap section"}
//   {"id":"d3","ts":"…","consumedBy":"x:n_build:2"}
// Append-only NDJSON is crash-safe and needs no lock for single-line POSIX
// appends (run-log.mjs precedent). Two writers exist — the HTTP/chat ingress and
// the agent's own consumption records — so every write is ONE appendFile of ONE
// line; never read-modify-write. Readers tolerate a torn final line.
import { appendFile, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export const DIRECTIONS_FILE = 'directions.ndjson';
/** Artifact kind indexed in the `artifacts` table (mirrors RUN_LOG_KIND). */
export const DIRECTIONS_KIND = 'directions';
export const DIRECTION_MAX_CHARS = 4000;

/** Run statuses whose inbox no step will ever read again, so a direction posted
 *  now would be written and silently never applied. A PAUSED run is deliberately
 *  NOT one of them: resume replays directions.ndjson, which is the whole point of
 *  accepting a direction for a run that is not currently live.
 *
 *  Lives HERE because both surfaces that accept a direction must agree on it —
 *  the HTTP route (postDirection in ui/server.mjs) and the chat `/direct` command
 *  (command-router.mjs). They disagreed: chat resolved against a live-only set
 *  that excluded `paused`, so the one state the inbox exists for was refused on
 *  the one surface built for it. */
export const DIRECTIONS_CLOSED = Object.freeze(new Set(['done', 'error', 'stopped']));

export function newDirectionId() {
  return 'd' + randomBytes(4).toString('hex');
}

async function appendLine(pipelineDir, record) {
  await appendFile(join(pipelineDir, DIRECTIONS_FILE), JSON.stringify(record) + '\n', 'utf8');
  return record;
}

/** Append a user direction. `source` is 'ui' | 'cli' | 'chat:<platform>'. */
export async function appendDirection(pipelineDir, { text, source = 'ui' }) {
  const clean = String(text || '').trim();
  if (!clean) throw Object.assign(new Error('direction text is required'), { code: 'EMPTY_DIRECTION' });
  return appendLine(pipelineDir, {
    id: newDirectionId(), ts: new Date().toISOString(), source: String(source), text: clean.slice(0, DIRECTION_MAX_CHARS),
  });
}

/** Append a consumption record: `consumedBy` is the executionId (x:<node>:<n>). */
export async function appendConsumption(pipelineDir, { id, consumedBy }) {
  return appendLine(pipelineDir, { id: String(id), ts: new Date().toISOString(), consumedBy: String(consumedBy) });
}

/** Tolerant reader: { directions: [...in file order], consumed: Map<id, string[]>, malformed: n }. */
export async function readDirections(pipelineDir) {
  let text = '';
  try { text = await readFile(join(pipelineDir, DIRECTIONS_FILE), 'utf8'); } catch { /* no inbox yet */ }
  const directions = [];
  const consumed = new Map();
  let malformed = 0;
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (!t) continue;
    let rec;
    try { rec = JSON.parse(t); } catch { malformed++; continue; }
    if (!rec || typeof rec.id !== 'string') { malformed++; continue; }
    if (typeof rec.consumedBy === 'string') {
      if (!consumed.has(rec.id)) consumed.set(rec.id, []);
      consumed.get(rec.id).push(rec.consumedBy);
    } else if (typeof rec.text === 'string') {
      directions.push({ id: rec.id, ts: rec.ts || null, source: rec.source || 'unknown', text: rec.text });
    } else malformed++;
  }
  return { directions, consumed, malformed };
}

export function pendingDirections(parsed) {
  return parsed.directions.filter((d) => !parsed.consumed.has(d.id));
}

/** The prompt block phases.runOpts appends. '' when nothing is pending, so the
 *  byte-equality prompt snapshots (test/graph-prompt-parity) are untouched.
 *
 *  `pipelineDir` is interpolated into the instruction as an ABSOLUTE path. The
 *  agent's cwd is the project worktree, not the run folder, so "append to
 *  directions.ndjson in the pipeline directory" gets the file created in the
 *  user's repo — after which _reconcileDirections finds no consumption record
 *  and reports every honored direction as never applied. */
export function renderDirectionsBlock(pending, executionId, pipelineDir) {
  if (!Array.isArray(pending) || pending.length === 0) return '';
  const lines = pending.map((d) => `- **${d.id}** (${d.source}, ${d.ts}): ${d.text.replace(/\s+/g, ' ')}`);
  const dir = String(pipelineDir || '').replace(/[\\/]+$/, '');
  const target = dir ? `\`${dir}/${DIRECTIONS_FILE}\`` : `\`${DIRECTIONS_FILE}\` in the pipeline directory`;
  return (
    '\n\n## New directions since the last step\n\n' +
    'The user posted these while the run was in progress. Honor every one that falls within your job; ' +
    'leave the ones that plainly belong to another step alone. If a direction contradicts your typed input, ' +
    'the direction wins — say so in your output. For each direction you act on, append ONE line to ' +
    `${target} (this exact path — your working directory is NOT the run folder):\n` +
    `\`{"id":"<id>","ts":"<iso8601>","consumedBy":"${executionId}"}\`\n\n` +
    lines.join('\n') + '\n'
  );
}
