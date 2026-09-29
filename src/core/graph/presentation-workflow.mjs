// src/core/graph/presentation-workflow.mjs
// The shipped presentation workflow. Seeded by schema V31 as a v2 row
// (INSERT OR IGNORE), so a user who edits or deletes it keeps their choice.
import { deepFreeze } from './builtin-workflows.mjs';

export const PRESENTATION_WORKFLOW_ID = 'wf_presentation';

export const GRAPH_PRESENTATION_WORKFLOW = deepFreeze({
  id: PRESENTATION_WORKFLOW_ID,
  name: 'Presentation',
  version: 2,
  domain: 'presentation',
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z',
  nodes: [
    { id: 'n_task', kind: 'task', x: 40, y: 200, config: {} },
    { id: 'n_clarify', kind: 'agent', key: 'deckClarify', x: 320, y: 200, config: {} },
    { id: 'n_narr', kind: 'agent', key: 'deckNarrative', x: 600, y: 200, config: { askQuestions: true } },
    { id: 'n_system', kind: 'agent', key: 'deckSystem', x: 880, y: 200, config: { askQuestions: true } },
    { id: 'n_build', kind: 'agent', key: 'deckBuilder', x: 1160, y: 200, config: { awaitAll: true } },
    { id: 'n_audit', kind: 'agent', key: 'deckAudit', x: 1440, y: 200, config: {} },
    { id: 'n_review', kind: 'agent', key: 'deckReviewer', x: 1720, y: 200, config: {} },
    // The OPTIONAL outputs. Each card reads the deckOutputs answers and skips itself (a clean
    // "skipped" report) when its deliverable was not selected, so the graph never branches: the
    // defaults reproduce the standard pipeline (PDF + standalone HTML, no audio).
    { id: 'n_outputs', kind: 'agent', key: 'deckOutputs', x: 320, y: 430, config: { askQuestions: true } },
    { id: 'n_pdf', kind: 'script', key: 'deckPdf', x: 2000, y: 200, config: {} },
    { id: 'n_audio', kind: 'script', key: 'deckAudio', x: 2280, y: 200, config: {} },
    { id: 'n_bundle', kind: 'script', key: 'deckBundle', x: 2560, y: 200, config: {} },
    { id: 'n_export', kind: 'agent', key: 'deckExport', x: 2840, y: 200, config: {} },
    { id: 'n_or', kind: 'or', x: 1580, y: 430, config: { arity: 6 } },
    { id: 'n_end', kind: 'end', x: 3120, y: 200, config: {} },
  ],
  wires: [
    { id: 'w1', from: { node: 'n_task', port: 'task' }, to: { node: 'n_clarify', port: 'task' } },
    { id: 'w2', from: { node: 'n_task', port: 'task' }, to: { node: 'n_narr', port: 'task' } },
    { id: 'w3', from: { node: 'n_clarify', port: 'answers' }, to: { node: 'n_narr', port: 'answers' } },
    { id: 'w4', from: { node: 'n_narr', port: 'spine' }, to: { node: 'n_system', port: 'spine' } },
    { id: 'w5', from: { node: 'n_narr', port: 'spine' }, to: { node: 'n_build', port: 'spine' } },
    { id: 'w6', from: { node: 'n_system', port: 'system' }, to: { node: 'n_build', port: 'system' } },
    { id: 'w7', from: { node: 'n_system', port: 'system' }, to: { node: 'n_review', port: 'system' } },
    { id: 'w8', from: { node: 'n_build', port: 'built' }, to: { node: 'n_audit', port: 'built' } },
    { id: 'w9', from: { node: 'n_audit', port: 'pass' }, to: { node: 'n_review', port: 'await' } },
    { id: 'w12', from: { node: 'n_audit', port: 'findings' }, to: { node: 'n_or', port: 'in1' }, config: { maxCycles: 3 } },
    { id: 'w14', from: { node: 'n_review', port: 'review' }, to: { node: 'n_or', port: 'in2' }, config: { maxCycles: 3 } },
    { id: 'w15', from: { node: 'n_or', port: 'out' }, to: { node: 'n_build', port: 'fixes' } },
    // The export step runs ONCE, after the review is clean — the builder has no
    // signal for "this is the final cycle", so producing deliverables there meant
    // rebuilding them on every fix pass.
    { id: 'w17', from: { node: 'n_build', port: 'built' }, to: { node: 'n_export', port: 'built' } },
    { id: 'w18', from: { node: 'n_task', port: 'task' }, to: { node: 'n_export', port: 'task' } },
    { id: 'w19', from: { node: 'n_export', port: 'findings' }, to: { node: 'n_or', port: 'in3' }, config: { maxCycles: 2 } },
    { id: 'w20', from: { node: 'n_export', port: 'pass' }, to: { node: 'n_end', port: 'result' } },
    { id: 'w21', from: { node: 'n_task', port: 'task' }, to: { node: 'n_review', port: 'task' } },
    // The bundle step runs ONCE, after the review is clean, and the export gates on
    // IT rather than on the review — so a deck whose companions could not be inlined
    // never reaches the deliverable check. It also takes `built` straight from the
    // builder: gated on `await`, so a fresh payload from inside the fix loop cannot
    // re-fire it (test/graph-scheduler.test.mjs pins exactly this shape).
    // review -> pdf -> audio -> bundle -> export. The PDF is printed from the deck BEFORE the audio
    // step wires the narration scripts into it, so the narration UI can never appear in the print.
    { id: 'w22', from: { node: 'n_audio', port: 'pass' }, to: { node: 'n_bundle', port: 'await' } },
    { id: 'w23', from: { node: 'n_build', port: 'built' }, to: { node: 'n_bundle', port: 'built' } },
    { id: 'w24', from: { node: 'n_bundle', port: 'pass' }, to: { node: 'n_export', port: 'await' } },
    { id: 'w25', from: { node: 'n_bundle', port: 'findings' }, to: { node: 'n_or', port: 'in4' }, config: { maxCycles: 2 } },
    { id: 'w26', from: { node: 'n_task', port: 'task' }, to: { node: 'n_outputs', port: 'task' } },
    { id: 'w27', from: { node: 'n_review', port: 'pass' }, to: { node: 'n_pdf', port: 'await' } },
    { id: 'w28', from: { node: 'n_build', port: 'built' }, to: { node: 'n_pdf', port: 'built' } },
    { id: 'w30', from: { node: 'n_pdf', port: 'pass' }, to: { node: 'n_audio', port: 'await' } },
    { id: 'w31', from: { node: 'n_build', port: 'built' }, to: { node: 'n_audio', port: 'built' } },
    // The deliverables/audio answers reach the optional cards THROUGH THE FILE (deck-outputs.json in
    // the pipeline dir), not through wires: a payload wire into a card that already takes `built`
    // is a V18 double-fire hazard, and the card is gated on `await` anyway. This wire is the
    // BARRIER — the builder cannot start until the user has answered, so by the time any card
    // runs the file is final. (n_build.awaitAll: its first run waits for spine, system AND this;
    // a fix cycle re-fires on the fixes loop token alone.)
    { id: 'w37', from: { node: 'n_outputs', port: 'answers' }, to: { node: 'n_build', port: 'answers' } },
    { id: 'w35', from: { node: 'n_pdf', port: 'findings' }, to: { node: 'n_or', port: 'in5' }, config: { maxCycles: 2 } },
    { id: 'w36', from: { node: 'n_audio', port: 'findings' }, to: { node: 'n_or', port: 'in6' }, config: { maxCycles: 2 } },
  ],
});

/**
 * Structural fingerprint of a stored graph: sorted node ids + sorted wire ids.
 * Deliberately ignores geometry and config — a seeded row that only moved on the
 * canvas is still the shipped shape, and re-seeding it loses nothing.
 *
 * SHAPE here means nodes and wires, and nothing else. A release that changes only
 * `config` — a wire's `maxCycles`, `n_build.awaitAll`, `n_narr.askQuestions`,
 * `n_or.arity` — produces the SAME fingerprint, so the refresh sees a row that
 * already matches and leaves it alone: existing installs keep the old numbers and
 * only a fresh DB gets the new ones. That is the deliberate trade (it is also
 * what stops the refresh clobbering a user's own config tweak on a row that is
 * otherwise the shipped shape). To ship a config change, the fingerprint has to
 * start covering config — which retires every entry below, since none of them
 * would match the new format, so it needs its own migration step rather than an
 * appended line.
 */
export function presentationGraphFingerprint(graph) {
  const nodes = [...(graph?.nodes || []).map((n) => n && n.id).filter(Boolean)].sort().join(',');
  const wires = [...(graph?.wires || []).map((w) => w && w.id).filter(Boolean)].sort().join(',');
  return `${nodes}|${wires}`;
}

/**
 * Every shape this workflow has ever been SHIPPED as, newest last. A stored seed
 * matching one of these is known to be worca's own and is safe to refresh; a row
 * matching none has been edited by the user and is left alone.
 *
 * Whenever the constant's shape changes, append the OUTGOING fingerprint here
 * and bump SCHEMA_VERSION. That is the whole procedure: the refresh step is
 * gated on `current < SCHEMA_VERSION` (db.mjs), so every bump re-enters it.
 *
 * Skip the fingerprint and the stored graph is treated as user-edited and left
 * alone; skip the version bump and no existing install re-enters the step. Either
 * way every existing install keeps running the old graph — and the moment an
 * agent sidecar gains a required input that graph does not wire, those runs fail
 * validation (V9) with no way forward but re-wiring by hand. Only a fresh DB
 * would be correct, which is the worst way to find out.
 *
 * A hazard for whoever appends the NEXT entry: the tests that prove a prior
 * shape is refreshed (test/presentation-seed-refresh.test.mjs,
 * test/db-migrate-v36.test.mjs) reconstruct that shape by filtering the CURRENT
 * constant's nodes/wires down to the ids this entry names. That only works while
 * every id an old fingerprint names still exists somewhere in the current
 * constant. RE-POINTING a wire (same id, new from/to) is fine. RETIRING one
 * outright — as w16 was here, when the export stopped gating on n_review
 * directly — is not: the id vanishes from the current constant, so the
 * reconstruction can no longer find it, and the fixture silently stops matching
 * its own fingerprint unless the retired wire's shape is supplied explicitly
 * (see `RETIRED_WIRES` in both test files above).
 */
export const PRESENTATION_SHIPPED_FINGERPRINTS = Object.freeze([
  // v1 — before the deckExport step. deckReviewer had no `task` input, so no
  // wire fed n_review.task; adding one made every existing seed invalid.
  'n_audit,n_build,n_clarify,n_end,n_narr,n_or,n_review,n_system,n_task'
    + '|w1,w12,w14,w15,w16,w2,w3,w4,w5,w6,w7,w8,w9',
  // v2 — before the deckBundle card. The export step gated on n_review.pass (w16)
  // and the or card had arity 3.
  'n_audit,n_build,n_clarify,n_end,n_export,n_narr,n_or,n_review,n_system,n_task'
    + '|w1,w12,w14,w15,w16,w17,w18,w19,w2,w20,w21,w3,w4,w5,w6,w7,w8,w9',
  // v3 — before the optional outputs (deckOutputs form, deckPdf, deckAudio). The bundle
  // gated on n_review.pass directly and had no `answers` input.
  'n_audit,n_build,n_bundle,n_clarify,n_end,n_export,n_narr,n_or,n_review,n_system,n_task|w1,w12,w14,w15,w17,w18,w19,w2,w20,w21,w22,w23,w24,w25,w3,w4,w5,w6,w7,w8,w9',
]);
