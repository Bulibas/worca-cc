// src/core/night/decider-model.mjs
// Which model and effort the nightDecider (analysis.mjs) runs with, decided PER CALL like
// title.mjs resolveTitleModel: nothing is captured when a question opens, so a Settings save
// reaches the very next review.
//   model:  1. the configured deciderModel, while it is in the catalog AND runnable on this
//              install (a bridged entry whose provider is not set up carries `needsSignIn`)
//           2. the run's model (this.claude.model), verbatim like --model everywhere
//           3. null: the CLI's own default model
//   effort: the configured deciderEffort, else medium (what the decider always ran at). An effort
//           the resolved model's catalog entry does not offer falls back to medium too.
// Pure: the caller hands in the catalog rows (config.mjs listModels('')), so tests need no I/O.
import { NIGHT_EFFORTS, NIGHT_DEFAULT_EFFORT } from './config.mjs';

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function findModel(models, id) {
  const lc = id.toLowerCase();
  return (Array.isArray(models) ? models : []).find((m) => m && typeof m.id === 'string' && m.id.toLowerCase() === lc) || null;
}

/**
 * @param {{deciderModel?:string|null, deciderEffort?:string|null, runModel?:string|null}} [o]
 * @param {{models?:Array<{id:string, efforts?:string[], needsSignIn?:boolean}>}} [deps]
 * @returns {{model:string|null, effort:string, source:'setting'|'run'|'default',
 *   stale:string|null, staleWhy:'catalog'|'sign-in'|null, effortDropped:string|null}}
 *   `stale` = a configured id that could not be used (the caller logs it once);
 *   `effortDropped` = a configured effort the model does not offer (the effort is medium instead).
 */
export function resolveDeciderPair({ deciderModel = null, deciderEffort = null, runModel = null } = {}, { models = [] } = {}) {
  let model = null; let source = 'default'; let stale = null; let staleWhy = null;
  const configured = str(deciderModel);
  if (configured) {
    const hit = findModel(models, configured);
    if (hit && !hit.needsSignIn) { model = hit.id; source = 'setting'; }
    else { stale = configured; staleWhy = hit ? 'sign-in' : 'catalog'; }
  }
  const run = str(runModel);
  if (!model && run) { model = run; source = 'run'; }
  const wanted = NIGHT_EFFORTS.includes(deciderEffort) ? deciderEffort : NIGHT_DEFAULT_EFFORT;
  const entry = model ? findModel(models, model) : null;
  const offered = wanted === NIGHT_DEFAULT_EFFORT || !entry || !Array.isArray(entry.efforts) || entry.efforts.includes(wanted);
  return { model, effort: offered ? wanted : NIGHT_DEFAULT_EFFORT, source, stale, staleWhy, effortDropped: offered ? null : wanted };
}
