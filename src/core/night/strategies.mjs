// src/core/night/strategies.mjs
// Pure decision rules. The only side effect is the injected `analyze` call.

const realOpts = (q) => (Array.isArray(q?.options) ? q.options.filter((o) => typeof o === 'string' && o.trim()) : []);

/** Weights threshold (confidence ≥ minConfidence, lead over the runner-up ≥ minMargin). */
export function weightsVerdict(q, cfg) {
  const opts = realOpts(q);
  const conf = Array.isArray(q?.confidence) && q.confidence.length === opts.length ? q.confidence : null;
  const idx = conf && typeof q.recommended === 'string' ? opts.indexOf(q.recommended) : -1;
  if (idx < 0) return { met: false, confidence: null, margin: null };
  const c = conf[idx];
  const runnerUp = Math.max(0, ...conf.filter((_, k) => k !== idx));
  const margin = c - runnerUp;
  return { met: c >= cfg.minConfidence && margin >= cfg.minMargin, confidence: c, margin, choice: opts[idx] };
}

/** Normalized weighted score (0-100) per option from 0-10 criterion scores. */
export function weightedTotals(scores, criteria, options) {
  const wsum = Object.values(criteria).reduce((a, b) => a + b, 0) || 1;
  const out = {};
  for (const o of options) {
    const s = scores?.[o] || {};
    let t = 0;
    for (const [k, w] of Object.entries(criteria)) t += w * (Number.isFinite(s[k]) ? Math.min(10, Math.max(0, s[k])) : 0);
    out[o] = Math.round((t / (wsum * 10)) * 100);
  }
  return out;
}

/** The option with the fewest irreversible effects: highest `reversible` score, ties → higher total, then order. */
export function mostReversible(options, scores, totals) {
  const r = (x) => (Number.isFinite(scores?.[x]?.reversible) ? scores[x].reversible : -1);
  let best = options[0];
  for (const o of options.slice(1)) {
    if (r(o) > r(best) || (r(o) === r(best) && (totals[o] ?? 0) > (totals[best] ?? 0))) best = o;
  }
  return best;
}

/**
 * Decide ONE clarify/questions question.
 * @param {object} q normalized question ({options, confidence?, recommended?})
 * @param {object} cfg resolved night config
 * @param {{analyze?:(q)=>Promise<object>}} env
 * @returns {Promise<{id, choice, strategy, confidence, scores, rationale, reversible, flagged}>}
 */
export async function decideQuestion(q, cfg, { analyze } = {}) {
  const opts = realOpts(q);
  const base = { id: q.id, scores: null, reversible: null };
  if (!opts.length) return { ...base, choice: '', strategy: 'none', confidence: null, rationale: 'question has no options', flagged: true };
  const w = weightsVerdict(q, cfg);
  if (cfg.strategy === 'weights' || (cfg.strategy === 'mixed' && w.met)) {
    return w.met
      ? { ...base, choice: w.choice, strategy: 'weights', confidence: w.confidence, rationale: `recommended at ${w.confidence}% (lead ${w.margin})`, flagged: false }
      : { ...base, choice: opts[0], strategy: 'weights', confidence: w.confidence, rationale: 'recommendation below threshold: first option taken', flagged: true };
  }
  let a;
  try {
    if (typeof analyze !== 'function') throw new Error('analysis not configured');
    a = await analyze(q);
    if (!a || typeof a !== 'object') throw new Error('empty analysis');
  } catch (err) {
    const fallback = w.choice || opts[0];
    return { ...base, choice: fallback, strategy: 'analysis', confidence: null, rationale: `analysis unavailable: ${err?.message || err}`, flagged: true };
  }
  const scores = a.scores && typeof a.scores === 'object' ? a.scores : {};
  const totals = weightedTotals(scores, cfg.criteria, opts);
  const conf = Number.isFinite(a.confidence) ? Math.round(a.confidence) : 0;
  const pick = opts.includes(a.choice) ? a.choice : opts.reduce((b, o) => (totals[o] > totals[b] ? o : b), opts[0]);
  if (conf >= cfg.minConfidence) {
    return { id: q.id, choice: pick, strategy: 'analysis', confidence: conf, scores, rationale: String(a.rationale || ''), reversible: a.reversible === true, flagged: false };
  }
  // User decision "never park": continue with the most reversible option, flagged.
  const rev = mostReversible(opts, scores, totals);
  return { id: q.id, choice: rev, strategy: 'analysis', confidence: conf, scores,
    rationale: `low confidence (${conf}%): took the most reversible option. ${String(a.rationale || '')}`.trim(),
    reversible: true, flagged: true };
}

export function gateRule({ issues = [], extraUsed = 0 }, cfg) {
  const critical = issues.filter((i) => String(i?.severity || '').toLowerCase() === 'critical');
  if (!critical.length) return { decision: 'continue', flagged: false, reason: 'no critical issues remain' };
  if (extraUsed < cfg.maxExtraCycles) return { decision: 'another', flagged: false, reason: `${critical.length} critical issue(s): one more cycle` };
  return { decision: 'continue', flagged: true, reason: `${critical.length} critical issue(s) remain but the night cycle budget is spent` };
}

export function workflowRule({ proposal, budget }) {
  const payload = { decision: 'accept', name: proposal?.name, nodes: {} };
  const tight = budget && budget.cap > 0 && budget.spent >= 0.8 * budget.cap;
  return { payload, flagged: !!tight, reason: tight ? `accepted; night budget ${Math.round((budget.spent / budget.cap) * 100)}% used` : 'accepted as proposed' };
}

export function recoveryRule({ attempts, max }) {
  return attempts < max ? { decision: 'retry', flagged: false } : { decision: 'pause', flagged: true };
}
