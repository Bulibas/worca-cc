// test/ui-cost-breakdown.test.mjs — the run cost broken into agents, Away mode, Auto workflow and the
// run title: the header cost's panel, the glance tile and the Overview cost card, on the run page and
// on the History run page. History boot + fixtures: helpers/history-detail-boot.mjs (its generic boot()
// also drives the run page through the socket it captures).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { boot, settle, go, bootDetail, openDetail, DETAIL, PROJECT, secOf, click } from './helpers/history-detail-boot.mjs';
import { runCostBreakdown } from '../src/shared/cost/breakdown.mjs';
import { costBreakdownEl, costSummaryText, awayTotalText } from '../ui/public/cost-breakdown.mjs';

const css = readFileSync(fileURLToPath(new URL('../ui/public/style.css', import.meta.url)), 'utf8');

// Task 6's fixture: $3.3319 in all, $0.12 of it two Away mode reviews; one more review stopped (≥$0.0234)
// and two agent turns a pause cut off (≥$0.31) — both lower bounds, apart from every total.
const STEPS = () => ([
  { key: 'x:preflight:1', executionId: 'x:preflight:1', nodeId: 'preflight', status: 'done', costUsd: 0.0419,
    auxCosts: { auto: { usd: 0.0398, calls: 1 }, title: { usd: 0.0021, calls: 1 } } },
  { key: 'n_plan:1', executionId: 'n_plan:1', nodeId: 'n_plan', status: 'done', costUsd: 0.67, auxCosts: { away: { usd: 0.05, calls: 1 } } },
  { key: 'n_impl:1', executionId: 'n_impl:1', nodeId: 'n_impl', status: 'done', costUsd: 1.91,
    auxCosts: { away: { usd: 0.07, calls: 1, floorUsd: 0.0234, stopped: 1 } } },
  { key: 'n_impl:2', executionId: 'n_impl:2', nodeId: 'n_impl', status: 'start', costUsd: 0.71,
    stoppedTurns: { turns: 2, tokens: 21000, floorUsd: 0.31 } },
]);
const OLD_STEPS = () => STEPS().map(({ auxCosts, stoppedTurns, ...s }) => s);   // a run from before the shares were kept
const TOTAL = 3.3319;

/** [label, value, note] per panel row, in order. */
const panelRows = (pop) => [...pop.querySelectorAll('.cost-bd-row')].map((r) => [
  r.querySelector('.cost-bd-l').textContent, r.querySelector('.cost-bd-v').textContent, r.querySelector('.cost-bd-n')?.textContent ?? '']);
const EXPECTED_ROWS = [
  ['Agents', '$3.17', ''],
  ['Away mode', '$0.12', '2 reviews'],
  ['Auto workflow', '$0.04', '1 call'],
  ['Run title', '<$0.01', '1 call'],
  ['Total', '$3.33', ''],
  ['Stopped reviews', '≥$0.02', '1 review · not in total'],
  ['Stopped agent turns', '≥$0.31', '2 turns · not in total'],
];
const glanceCost = (scope) => {
  const tile = [...scope.querySelectorAll('.rd-facts .rd-stats > div')].find((t) => /\$/.test(t.querySelector('b').textContent));
  return tile ? [tile.querySelector('b').textContent, tile.querySelector('span').textContent] : null;
};

// --- the run page: boot, hello, one run; frames through the socket the boot captured ---------------
async function bootRun({ steps = STEPS(), total = TOTAL, hash = 'running/r1/details/overview' } = {}) {
  const ctx = await boot({ fetchHandler: (url) => (url.endsWith('/api/history') ? Promise.resolve({ ok: true, status: 200, json: async () => ({ pipelines: [], ghAvailable: false }) }) : null) });
  const ws = ctx.wsBox.ws;
  ws.dispatch('open', {});
  ctx.frame = (msg) => ws.dispatch('message', { data: JSON.stringify(msg) });
  ctx.frame({ type: 'hello', runs: [] });
  await settle(ctx.window, 4);
  ctx.frame({ type: 'run-created', runId: 'r1', title: 'Rate limit uploads', projectDir: PROJECT, status: 'running', startedAt: '2026-08-19T10:00:00Z', kind: 'run' });
  ctx.frame({ type: 'state', runId: 'r1', id: 'p1', status: 'running', steps, subAgents: [], totalCostUsd: total });
  go(ctx.window, hash);
  await settle(ctx.window, 6);
  ctx.rd = ctx.window.document.querySelector('#run-detail .rd');
  return ctx;
}

test('the panel body: Agents, one row per booked share, Total, then the stopped reviews and cut agent turns apart', () => {
  const { window } = new JSDOM('<!doctype html><body></body>');
  const fmt = (n) => (n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);
  const panel = (steps, total) => costBreakdownEl(window.document, runCostBreakdown(steps, total), { fmtUsd: fmt });
  const el = panel(STEPS(), TOTAL);
  assert.ok(el.classList.contains('cost-bd'));
  assert.deepEqual(panelRows(el), EXPECTED_ROWS);
  assert.deepEqual([...el.children].map((c) => c.dataset.kind || c.tagName), ['agents', 'away', 'auto', 'title', 'HR', 'total', 'stopped', 'cut']);
  assert.deepEqual([...el.querySelectorAll('.cost-bd-floor')].map((r) => r.dataset.kind), ['stopped', 'cut']);
  assert.equal(costSummaryText(runCostBreakdown(STEPS(), TOTAL), fmt), 'incl. $0.12 Away mode');
  // A run whose only review stopped: nothing booked to "include", and no "$0.00 · 0 reviews" share row.
  const onlyStopped = [{ key: 'a', costUsd: 1, auxCosts: { away: { usd: 0, calls: 0, floorUsd: 0.03, stopped: 1 } } }];
  assert.equal(costSummaryText(runCostBreakdown(onlyStopped, 1), fmt), '');
  assert.deepEqual(panelRows(panel(onlyStopped, 1)),
    [['Agents', '$1.00', ''], ['Total', '$1.00', ''], ['Stopped reviews', '≥$0.03', '1 review · not in total']]);
  // No list price: "not priced"; a {free} model (floor 0): the count only, never "≥$0.00".
  assert.deepEqual(panelRows(panel([{ key: 'a', costUsd: 1, auxCosts: { away: { usd: 0, calls: 0, stopped: 2 } } }], 1)).at(-1),
    ['Stopped reviews', 'not priced', '2 reviews · not in total']);
  assert.deepEqual(panelRows(panel([{ key: 'a', costUsd: 0, auxCosts: { away: { usd: 0, calls: 0, floorUsd: 0, stopped: 1 } } }], 0)).at(-1),
    ['Stopped reviews', '', '1 review · not in total']);
  assert.deepEqual(panelRows(panel([{ key: 'a', costUsd: 1, stoppedTurns: { turns: 1, tokens: 900, floorUsd: null } }], 1)),
    [['Agents', '$1.00', ''], ['Total', '$1.00', ''], ['Stopped agent turns', 'not priced', '1 turn · not in total']]);
  window.close();
});

test('run page: the header cost opens its breakdown; a repaint keeps it open; a click elsewhere or Escape closes it', async () => {
  const ctx = await bootRun();
  const { window, rd } = ctx;
  const doc = window.document;
  const btn = rd.querySelector('.rd-meta .rd-cost');
  assert.equal(btn.tagName, 'BUTTON', 'the cost is the trigger');
  assert.equal(btn.textContent, '$3.33');
  assert.match(btn.title, /Estimated cost/, 'the estimate tooltip stays');
  const pop = doc.getElementById(btn.getAttribute('aria-controls'));
  assert.ok(pop && pop.classList.contains('cost-pop'));
  assert.equal(pop.parentElement, rd.querySelector('.rd-header'), 'the panel hangs off the header, outside the rebuilt meta line');
  assert.equal(pop.hidden, true);
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  btn.click();
  assert.equal(pop.hidden, false);
  assert.equal(rd.querySelector('.rd-meta .rd-cost').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(panelRows(pop), EXPECTED_ROWS);
  // Every frame repaints the header (its meta line only when what it says changed): the open panel
  // (the same element) stays open.
  ctx.frame({ type: 'state', runId: 'r1', status: 'running', steps: STEPS(), totalCostUsd: TOTAL });
  await settle(window, 3);
  assert.equal(rd.querySelector('.rd-header > .cost-pop'), pop);
  assert.equal(pop.hidden, false, 'still open after a repaint');
  assert.equal(rd.querySelector('.rd-meta .rd-cost').getAttribute('aria-expanded'), 'true');
  // Same numbers: the panel's rows are not rebuilt (no flicker under the pointer).
  const firstRow = pop.querySelector('.cost-bd-row');
  ctx.frame({ type: 'state', runId: 'r1', status: 'running', steps: STEPS(), totalCostUsd: TOTAL });
  await settle(window, 3);
  assert.equal(pop.querySelector('.cost-bd-row'), firstRow, 'unchanged numbers keep the same rows');
  // New numbers repaint the open panel in place.
  const more = STEPS(); more[2].auxCosts.away = { usd: 0.09, calls: 2, floorUsd: 0.0234, stopped: 1 }; more[2].costUsd = 1.93;
  ctx.frame({ type: 'state', runId: 'r1', status: 'running', steps: more, totalCostUsd: 3.3519 });
  await settle(window, 3);
  assert.deepEqual(panelRows(pop)[1], ['Away mode', '$0.14', '3 reviews']);
  // A click inside the panel keeps it; a click elsewhere closes it.
  click(window, pop.querySelector('.cost-bd-row .cost-bd-l'));
  assert.equal(pop.hidden, false);
  click(window, rd.querySelector('.rd-title'));
  assert.equal(pop.hidden, true);
  // Escape closes an open panel and stays on Details (the capture-phase arm would otherwise go back to the glance).
  rd.querySelector('.rd-meta .rd-cost').click();
  assert.equal(pop.hidden, false);
  const hash = window.location.hash;
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle(window, 2);
  assert.equal(pop.hidden, true, 'Escape closed the panel');
  assert.equal(window.location.hash, hash, 'and did not leave Details');
  assert.equal(doc.activeElement, rd.querySelector('.rd-meta .rd-cost'), 'focus back on the trigger');
  // With the panel closed, Escape is the page's again.
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle(window, 2);
  assert.notEqual(window.location.hash, hash);
});

test('run page: the panel\'s Total is the header\'s total, not a re-sum of the steps', async () => {
  const ctx = await bootRun({ total: 3.5 });   // Σ steps is 3.3319: the run total is what the header says
  const { rd } = ctx;
  const btn = rd.querySelector('.rd-meta .rd-cost');
  assert.equal(btn.textContent, '$3.50');
  btn.click();
  const rows = panelRows(rd.querySelector('.rd-header > .cost-pop'));
  assert.deepEqual(rows.find((r) => r[0] === 'Total'), ['Total', '$3.50', '']);
  assert.deepEqual(rows[0], ['Agents', '$3.34', ''], '3.50 − 0.1619');
});

test('run page: agent turns a pause cut off open the breakdown even with no Away mode, Auto workflow or run title', async () => {
  const ctx = await bootRun({ total: 1, steps: [{ key: 'n_impl:1', executionId: 'n_impl:1', nodeId: 'n_impl', status: 'done', costUsd: 1,
    stoppedTurns: { turns: 1, tokens: 21000, floorUsd: 0.07 } }] });
  const { window, rd } = ctx;
  const btn = rd.querySelector('.rd-meta .rd-cost');
  assert.equal(btn.tagName, 'BUTTON');
  btn.click();
  assert.deepEqual(panelRows(rd.querySelector('.rd-header > .cost-pop')),
    [['Agents', '$1.00', ''], ['Total', '$1.00', ''], ['Stopped agent turns', '≥$0.07', '1 turn · not in total']]);
  assert.equal(btn.textContent, '$1.00', 'the lower bound never reaches the header total');
  assert.doesNotMatch(rd.textContent, /incl\./, 'cut turns are no Away mode share');
  go(window, 'running/r1');
  await settle(window, 6);
  assert.deepEqual(glanceCost(rd.querySelector('.rd-glance')), ['$1.00', 'cost']);
});

test('run page: a focused trigger keeps the focus across a rebuild, without scrolling the page back to it', async () => {
  const ctx = await bootRun();
  const { window, rd } = ctx;
  const seen = [];
  const focus = window.HTMLElement.prototype.focus;
  window.HTMLElement.prototype.focus = function (o) { seen.push(o); return focus.call(this, o); };
  try {
    rd.querySelector('.rd-meta .rd-cost').focus();
    ctx.frame({ type: 'state', runId: 'r1', status: 'running', steps: STEPS(), totalCostUsd: 3.5 });   // a new total rebuilds the line
    await settle(window, 3);
  } finally { window.HTMLElement.prototype.focus = focus; }
  assert.equal(window.document.activeElement, rd.querySelector('.rd-meta .rd-cost'));
  assert.deepEqual(seen.at(-1), { preventScroll: true }, 'a browser focuses a clicked button: a plain focus() would scroll a read-down page back up');
});

test('run page: a frame that changes nothing the header says keeps its trigger; the elapsed time is written in place', async () => {
  const ctx = await bootRun();
  const { window, rd } = ctx;
  const btn = rd.querySelector('.rd-meta .rd-cost');
  const dur = rd.querySelector('.rd-meta .run-time');
  const before = dur.textContent;
  const later = STEPS(); later[1].activeMs = 61_000;                 // only the elapsed time moved
  ctx.frame({ type: 'state', runId: 'r1', status: 'running', steps: later, totalCostUsd: TOTAL });
  await settle(window, 3);
  assert.equal(rd.querySelector('.rd-meta .rd-cost'), btn, 'one node: a click whose press and release straddle the frame still lands');
  assert.equal(rd.querySelector('.rd-meta .run-time'), dur);
  assert.notEqual(dur.textContent, before, 'the elapsed time still moves');
  ctx.frame({ type: 'state', runId: 'r1', status: 'running', steps: later, totalCostUsd: 3.3321 });   // the same cents, a new estimate
  await settle(window, 3);
  assert.match(rd.querySelector('.rd-meta .rd-cost').title, /\$3\.3321/, 'the tooltip follows the total');
  ctx.frame({ type: 'state', runId: 'r1', status: 'running', steps: later, totalCostUsd: 3.5 });
  await settle(window, 3);
  assert.equal(rd.querySelector('.rd-meta .rd-cost').textContent, '$3.50', 'a new total rebuilds the line');
});

test('run page: a route change with no click (Back) closes an open panel, so the next Escape is the page\'s', async () => {
  const ctx = await bootRun();
  const { window, rd } = ctx;
  rd.querySelector('.rd-meta .rd-cost').click();
  const pop = rd.querySelector('.rd-header > .cost-pop');
  assert.equal(pop.hidden, false);
  go(window, 'running/r1');                                          // Back to the glance: no click reached the outside closer
  await settle(window, 6);
  assert.equal(pop.hidden, true);
});

test('run page: a trigger with nothing left to open turns back into the plain cost', async () => {
  const ctx = await bootRun();
  const { window, rd } = ctx;
  assert.equal(rd.querySelector('.rd-meta .rd-cost').tagName, 'BUTTON');
  // The same total and texts, so the meta line is kept; the steps no longer carry a share or a cut turn.
  ctx.frame({ type: 'state', runId: 'r1', status: 'running', steps: OLD_STEPS(), totalCostUsd: TOTAL });
  await settle(window, 3);
  const seg = rd.querySelector('.rd-meta .rd-cost');
  assert.equal(seg.tagName, 'SPAN', 'never a button that opens an empty panel');
  assert.equal(seg.textContent, '$3.33');
  assert.equal(rd.querySelector('.rd-meta .cost-bd-btn'), null);
});

test('run page: the panel opens under its trigger, clamped inside the header card (phone width)', async () => {
  const ctx = await bootRun();
  const { rd } = ctx;
  const header = rd.querySelector('.rd-header');
  const pop = rd.querySelector('.rd-header > .cost-pop');
  const rect = (o) => () => ({ x: o.left, y: o.top, width: o.width, height: o.bottom - o.top, right: o.left + o.width, ...o });
  header.getBoundingClientRect = rect({ left: 16, top: 100, width: 358, bottom: 300 });
  Object.defineProperty(pop, 'offsetWidth', { configurable: true, get: () => 240 });
  let btn = rd.querySelector('.rd-meta .rd-cost');
  btn.getBoundingClientRect = rect({ left: 330, top: 140, width: 40, bottom: 160 });
  btn.click();
  assert.deepEqual([pop.style.left, pop.style.top], ['110px', '66px'], 'right edge clamped to the card (358 - 240 - 8)');
  btn.click();
  btn = rd.querySelector('.rd-meta .rd-cost');
  btn.getBoundingClientRect = rect({ left: 18, top: 140, width: 40, bottom: 160 });
  btn.click();
  assert.equal(pop.style.left, '8px', 'never left of the card');
});

test('run page: the glance cost tile and the Overview cost card carry the Away mode share', async () => {
  const ctx = await bootRun();
  const { rd } = ctx;
  const ov = rd.querySelector('.rd-sec[data-sec="overview"] .hd-ov-card-cost') || rd.querySelector('.hd-ov-card-cost');
  assert.ok(ov, 'the Overview cost card renders');
  assert.match(ov.querySelector('.hd-ov-sub').textContent, / · incl\. \$0\.12 Away mode$/);
  go(ctx.window, 'running/r1');
  await settle(ctx.window, 6);
  assert.deepEqual(glanceCost(rd.querySelector('.rd-glance')), ['$3.33', 'incl. $0.12 Away mode']);
});

test('run page, an old run (no shares kept): the plain cost, no panel, no "incl.", no NaN or undefined', async () => {
  const ctx = await bootRun({ steps: OLD_STEPS() });
  const { rd } = ctx;
  const seg = rd.querySelector('.rd-meta .rd-cost');
  assert.equal(seg.tagName, 'SPAN');
  assert.equal(seg.textContent, '$3.33');
  assert.equal(rd.querySelector('.cost-bd-btn'), null);
  const pop = rd.querySelector('.rd-header > .cost-pop');
  assert.ok(!pop || (pop.hidden && !pop.childElementCount), 'no panel content');
  assert.doesNotMatch(rd.textContent, /incl\.|NaN|undefined/);
  go(ctx.window, 'running/r1');
  await settle(ctx.window, 6);
  assert.deepEqual(glanceCost(rd.querySelector('.rd-glance')), ['$3.33', 'cost']);
  assert.doesNotMatch(rd.textContent, /incl\.|NaN|undefined/);
});

// --- the History run page ------------------------------------------------------------------------
const histDetail = (steps) => ({ ...DETAIL, state: { ...DETAIL.state, steps, totalCostUsd: TOTAL } });

test('History: the header cost opens the same breakdown; the glance and the Overview carry the share', async () => {
  const ctx = await bootDetail({ detail: histDetail(STEPS()) });
  await openDetail(ctx, 'details/overview');
  const doc = ctx.window.document;
  const btn = doc.querySelector('#hist-detail .hd-meta .hd-cost');
  assert.equal(btn.tagName, 'BUTTON');
  assert.equal(btn.textContent, '$3.33');
  const pop = doc.getElementById(btn.getAttribute('aria-controls'));
  assert.equal(pop.parentElement, doc.querySelector('#hist-detail .hd-header'));
  btn.click();
  assert.equal(pop.hidden, false);
  assert.deepEqual(panelRows(pop), EXPECTED_ROWS);
  // Escape closes the panel before History's capture-phase arm can step back to the glance.
  const hash = ctx.window.location.hash;
  doc.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle(ctx.window, 2);
  assert.equal(pop.hidden, true);
  assert.equal(ctx.window.location.hash, hash);
  const card = secOf(doc, 'overview').querySelector('.hd-ov-card-cost');
  assert.equal(card.querySelector('.hd-ov-sub').textContent, 'across 4 steps · incl. $0.12 Away mode');
  await openDetail(ctx, '');
  assert.deepEqual(glanceCost(doc.querySelector('#hist-detail .hd-glance')), ['$3.33', 'incl. $0.12 Away mode']);
});

test('History, an old run: the plain cost and no "incl." anywhere', async () => {
  const ctx = await bootDetail({ detail: histDetail(OLD_STEPS()) });
  await openDetail(ctx, 'details/overview');
  const doc = ctx.window.document;
  assert.equal(doc.querySelector('#hist-detail .hd-meta .hd-cost').tagName, 'SPAN');
  assert.equal(secOf(doc, 'overview').querySelector('.hd-ov-card-cost .hd-ov-sub').textContent, 'across 4 steps');
  await openDetail(ctx, '');
  assert.deepEqual(glanceCost(doc.querySelector('#hist-detail .hd-glance')), ['$3.33', 'cost']);
  assert.doesNotMatch(doc.querySelector('#hist-detail').textContent, /incl\.|NaN|undefined/);
});

test('awayTotalText: booked reviews, else the stopped reviews\' lower bound apart, else nothing', () => {
  const fmt = (n) => `$${n.toFixed(2)}`;
  const away = (a) => runCostBreakdown([{ costUsd: 1, auxCosts: { away: a } }]);
  assert.equal(awayTotalText(runCostBreakdown(STEPS(), TOTAL), fmt), '$0.12');
  assert.equal(awayTotalText(away({ usd: 0, calls: 1 }), fmt), '$0.00', 'a $0 review is shown');
  assert.equal(awayTotalText(away({ usd: 0, calls: 0, floorUsd: 0.03, stopped: 1 }), fmt), '≥$0.03 · not in total');
  assert.equal(awayTotalText(away({ usd: 0, calls: 0, stopped: 1 }), fmt), '', 'not priced: no figure');
  assert.equal(awayTotalText(away({ usd: 0, calls: 0, floorUsd: 0, stopped: 1 }), fmt), '', 'a {free} model: never "≥$0.00"');
  assert.equal(awayTotalText(runCostBreakdown(OLD_STEPS(), TOTAL), fmt), '');
});

test('History: "Answered for you" names each review\'s model and cost, and the heading sums the steps\' reviews', async () => {
  const decisions = [
    { questionId: 'c-1', kind: 'clarify', at: '2026-01-01T14:02:00', choice: 'Redis', strategy: 'analysis', model: null,
      reviewId: 'night-decider-ab12cd34', reviewStatus: 'finished', costUsd: 0.05, tokens: 900, executionId: 'n_plan:1', flagged: false, rationale: 'r',
      questions: [{ id: 'store', question: 'Which store?', choice: 'Redis', strategy: 'analysis', confidence: 80, flagged: false, rationale: 'fits' }] },
    { questionId: 'gate-w-2', kind: 'gate', at: '2026-01-01T14:52:00', choice: 'continue', strategy: 'rule', flagged: false, rationale: 'r' },
  ];
  const ctx = await bootDetail({ detail: histDetail(STEPS()),
    arms: (url) => (url.includes('/api/night-decisions') ? Promise.resolve({ ok: true, status: 200, json: async () => ({ decisions }) }) : null) });
  await openDetail(ctx, '');
  await settle(ctx.window, 4);
  const sec = ctx.window.document.querySelector('#hist-detail .hd-night-sec');
  assert.equal(sec.hidden, false);
  assert.deepEqual([...sec.querySelectorAll('.rd-na .rd-slabel')].map((c) => c.textContent),
    ['Clarifying questions · 14:02 · the default model · $0.05', 'Review loop · 14:52 · rule · $0.00']);
  assert.equal(sec.querySelector('h3').textContent, 'Answered for you · 2 answers · $0.12');
});

test('CSS: the panel is tokens only, has a [hidden] rule, and no accent edge', () => {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = bare.match(/[^{}]*\.cost-(?:bd|pop)[^{}]*\{[^}]*\}/g) || [];
  assert.ok(rules.length >= 8, `cost rules found: ${rules.length}`);
  for (const r of rules) {
    assert.doesNotMatch(r, /border-left\s*:/, r);
    assert.doesNotMatch(r, /#[0-9a-f]{3,8}\b|rgba?\(/i, r);
  }
  assert.match(bare, /\.cost-pop\[hidden\]\s*\{\s*display:\s*none/);
  // Open, the card lifts above the sticky tabs (z-index 5), like the ⋯ menu's header.
  assert.match(bare, /\.rd-header:has\(> \.cost-pop:not\(\[hidden\]\)\),\.hd-header:has\(> \.cost-pop:not\(\[hidden\]\)\)\{position:relative;z-index:6;\}/);
  // ...and the sticky top bar (z-index 5) stays above that card: scrolling closes nothing.
  assert.match(bare, /\.rd:has\(> \.rd-details > \.rd-header > \.cost-pop:not\(\[hidden\]\)\) > \.rd-bar,\.hd:has\(> \.hd-details > \.hd-header > \.cost-pop:not\(\[hidden\]\)\) > \.hd-bar\{z-index:7;\}/);
  for (const m of bare.matchAll(/\.cost-(?:bd|pop)[^{]*\{([^}]*)\}/g)) {
    for (const v of m[1].matchAll(/var\((--[\w-]+)\)/g)) assert.match(css, new RegExp(`(^|[;{\\s])${v[1]}\\s*:`), `${v[1]} is a real token`);
  }
});
