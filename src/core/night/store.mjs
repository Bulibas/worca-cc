// src/core/night/store.mjs
// night_decisions rows (schema v44) and the counters night mode's guardrails read from them.
// The counters live in the DB, not the harness, so they survive a pause/resume.
import { prepare } from '../db.mjs';
import { windowedSpendUsd } from '../cost-budget.mjs';
import { awayAnswerCounts } from '../../shared/away-mode/labels.mjs';

export function writeNightDecision(pipelineId, { questionId, kind, ...record }) {
  if (!pipelineId) return;
  prepare('INSERT INTO night_decisions (pipeline_id, question_id, kind, ts, record) VALUES (?, ?, ?, ?, ?)')
    .run(pipelineId, String(questionId), String(kind), new Date().toISOString(), JSON.stringify(record));
}

export function readNightDecisions(pipelineId) {
  if (!pipelineId) return [];
  return prepare('SELECT question_id, kind, ts, record FROM night_decisions WHERE pipeline_id = ? ORDER BY id').all(pipelineId)
    .map((r) => {
      let rec = {};
      try { rec = JSON.parse(r.record) || {}; } catch { /* corrupt row */ }
      return { questionId: r.question_id, kind: r.kind, at: r.ts, ...rec, flagged: rec.flagged === true };
    });
}

export function countNightDecisions(pipelineId) {
  // Guardrail rows and cost-cap overrides do not spend the maxDecisions budget.
  return pipelineId
    ? prepare("SELECT COUNT(*) AS n FROM night_decisions WHERE pipeline_id = ? AND kind != 'cost-cap' AND json_extract(record, '$.guardrail') IS NULL").get(pipelineId).n
    : 0;
}

/** The run's night counters as the run view and policy state show them: `decisions` spends the
 *  maxDecisions budget (countNightDecisions), `flagged` counts every flagged row; `answers` and
 *  `checks` count what the answers list shows, one per answered question (awayAnswerCounts). */
export function nightCounts(pipelineId) {
  if (!pipelineId) return { decisions: 0, flagged: 0, answers: 0, checks: 0 };
  const flagged = prepare("SELECT COUNT(*) AS n FROM night_decisions WHERE pipeline_id = ? AND json_extract(record, '$.flagged') = 1").get(pipelineId).n;
  return { decisions: countNightDecisions(pipelineId), flagged, ...awayAnswerCounts(readNightDecisions(pipelineId)) };
}

/** Night-granted extra cycles on one loop wire (gate decisions answered `another`). */
export function nightGateCycles(pipelineId, wireId) {
  return readNightDecisions(pipelineId).filter((d) => d.kind === 'gate' && d.choice === 'another' && d.meta?.wireId === wireId).length;
}

/** Spend across ALL pipelines since `sinceMs` (the night anchor). `cost_ledger.ts` is INTEGER
 *  epoch ms; comparing it with an ISO string would always be false in SQLite, so reuse the helper. */
export function nightSpendSinceUsd(sinceMs) {
  return windowedSpendUsd(sinceMs);
}

/** Answers worca gave on every run since `sinceMs`, and how many of them are marked to check, one per
 *  answered question (awayAnswerCounts). Guardrail rows and cost-cap overrides are not answers. `ts` is
 *  an ISO string, so compare it as one. */
export function nightAnsweredSince(sinceMs) {
  const rows = prepare(`SELECT kind, record FROM night_decisions
    WHERE ts >= ? AND kind != 'cost-cap' AND json_extract(record, '$.guardrail') IS NULL`).all(new Date(sinceMs).toISOString())
    .map((r) => { try { return { kind: r.kind, ...JSON.parse(r.record) }; } catch { return null; } });
  const { answers, checks } = awayAnswerCounts(rows);
  return { answered: answers, flagged: checks };
}
