// assets/deck-preview/preview-html.mjs
// The PURE half of the visual-system preview: spec -> three self-contained HTML pages
// (system sheet, compositions, samples) and the `approve-system` form data. No fs, no
// child processes, no clock: the same spec always yields the same bytes, so every
// branch is testable without Chrome. Every spec string reaches HTML through esc();
// every value that reaches CSS is validated by checkSpec() first (hex, family, px).
// A type step without a `family` is drawn in the system sans the kit defaults to.

export const KINDS = Object.freeze(['cover', 'statement', 'divider', 'figure', 'two-column',
  'ledger', 'hero-number', 'quote', 'ask', 'list']);
export const ROLES = Object.freeze(['hero', 'title', 'body', 'caption']);
export const LIMITS = Object.freeze({
  grounds: [1, 6], typeSteps: [2, 12], compositions: [1, 12], titles: 3,
  name: 60, job: 200, title: 200, family: 60,
});

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/;
const CLASS_RE = /^\.is-[a-z0-9][a-z0-9-]{0,39}$/;
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const MONO = 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';
const WIDTH = 1600;
const SYSTEM_FAMILY = 'system sans';

// Chrome screenshots exactly `height` and every page is overflow:hidden, so anything past the
// estimate is cut from the PNG without an error. Every block in the page flow therefore has a
// bounded height — one-line text ends in an ellipsis (ONE), longer text is line-clamped
// (CLAMP), cards and captions have set heights — and a page's height is the sum of those
// blocks: it depends on the counts and the type sizes of the spec, never on its strings.
const ONE = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
const CLAMP = (lines) => `display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:${lines};overflow:hidden`;
const PAD = 56;                            // .pg padding, top and bottom
const HEAD = 20 + 10 + 44 + 36;            // .kick, h1 margin, h1, h1 margin
const H2 = 20 + 12;                        // an h2 line and its margin
const SWATCH = 1 + 210 + 156 + 1;          // border, .fill, .meta (name, hex, a 3-line job), border
const LABEL = 44;                          // a ladder label: the step name over one meta line
const STEP_PAD = 10 + 10 + 1;              // a ladder row's padding and rule
const BOTTOM = 282;                        // the accent card: rule, padding, h2, chip row, 3-line job, class
const CARD_Y = 1 + 16 + 18 + 1;            // a .cmp card's border and padding around frame + caption
const CAP_JOBS = 14 + 96;                  // a composition caption: name, a 2-line job, the count line
const CAP_ONE = 14 + 24;                   // a sample caption: one line
const GAP = 28;                            // the grid gap

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isText = (v, max) => typeof v === 'string' && v.trim() !== '' && v.length <= max;

/** HTML-escape one value. The only way a spec string reaches the page. */
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** → { ok, errors: string[] }. Everything the pages put into CSS is proven safe here. */
export function checkSpec(spec) {
  const errors = [];
  const bad = (m) => errors.push(m);
  if (!isObj(spec)) return { ok: false, errors: ['the spec is a JSON object'] };
  if (!isText(spec.deckTitle, LIMITS.title)) bad(`deckTitle is 1-${LIMITS.title} characters`);
  if (!isText(spec.coverTitle, LIMITS.title)) bad(`coverTitle is 1-${LIMITS.title} characters`);
  const list = (key, [min, max]) => {
    const v = spec[key];
    if (!Array.isArray(v) || v.length < min || v.length > max) { bad(`${key} is a list of ${min}-${max} entries`); return []; }
    return v;
  };
  const ids = (rows, key) => {
    const seen = new Set();
    rows.forEach((r, i) => {
      if (!isObj(r) || typeof r.id !== 'string' || !ID_RE.test(r.id)) bad(`${key}[${i}].id is text matching ${ID_RE}`);
      else if (seen.has(r.id)) bad(`${key}[${i}].id "${r.id}" is used twice`);
      else seen.add(r.id);
    });
    return seen;
  };
  const grounds = list('grounds', LIMITS.grounds);
  const groundIds = ids(grounds, 'grounds');
  grounds.forEach((g, i) => {
    if (!isObj(g)) return;
    if (!isText(g.name, LIMITS.name)) bad(`grounds[${i}].name is 1-${LIMITS.name} characters`);
    if (!HEX_RE.test(String(g.hex))) bad(`grounds[${i}].hex is #RRGGBB`);
    if (!HEX_RE.test(String(g.ink))) bad(`grounds[${i}].ink is #RRGGBB`);
    if (!isText(g.job, LIMITS.job)) bad(`grounds[${i}].job is 1-${LIMITS.job} characters`);
  });
  const steps = list('typeSteps', LIMITS.typeSteps);
  ids(steps, 'typeSteps');
  steps.forEach((s, i) => {
    if (!isObj(s)) return;
    if (!isText(s.name, LIMITS.name)) bad(`typeSteps[${i}].name is 1-${LIMITS.name} characters`);
    if (!(Number.isInteger(s.px) && s.px >= 8 && s.px <= 1080)) bad(`typeSteps[${i}].px is a whole number 8-1080`);
    if (!(Number.isInteger(s.weight) && s.weight >= 100 && s.weight <= 900 && s.weight % 100 === 0)) bad(`typeSteps[${i}].weight is 100-900 in steps of 100`);
    if (s.family !== undefined && !FAMILY_RE.test(String(s.family))) bad(`typeSteps[${i}].family, when given, is a font family name (letters, digits, space . _ -)`);
    if (s.role !== undefined && !ROLES.includes(s.role)) bad(`typeSteps[${i}].role is one of ${ROLES.join(', ')}`);
    if (s.sample !== undefined && !isText(s.sample, LIMITS.name)) bad(`typeSteps[${i}].sample is 1-${LIMITS.name} characters`);
  });
  const comps = list('compositions', LIMITS.compositions);
  ids(comps, 'compositions');
  comps.forEach((c, i) => {
    if (!isObj(c)) return;
    if (!isText(c.name, LIMITS.name)) bad(`compositions[${i}].name is 1-${LIMITS.name} characters`);
    if (!KINDS.includes(c.kind)) bad(`compositions[${i}].kind is one of ${KINDS.join(', ')}`);
    if (!isText(c.job, LIMITS.job)) bad(`compositions[${i}].job is 1-${LIMITS.job} characters`);
    if (c.ground !== undefined && !groundIds.has(c.ground)) bad(`compositions[${i}].ground names a ground id`);
    if (!(Array.isArray(c.titles) && c.titles.length >= 1 && c.titles.length <= LIMITS.titles
      && c.titles.every((t) => isText(t, LIMITS.title)))) bad(`compositions[${i}].titles is 1-${LIMITS.titles} real slide titles`);
    if (!(Number.isInteger(c.slides) && c.slides >= 0 && c.slides <= 200)) bad(`compositions[${i}].slides is the number of slides that use it`);
  });
  const a = spec.accent;
  if (!isObj(a)) bad('accent is { name, hex, job, className }');
  else {
    if (!isText(a.name, LIMITS.name)) bad(`accent.name is 1-${LIMITS.name} characters`);
    if (!HEX_RE.test(String(a.hex))) bad('accent.hex is #RRGGBB');
    if (!isText(a.job, LIMITS.job)) bad(`accent.job is 1-${LIMITS.job} characters`);
    if (!CLASS_RE.test(String(a.className))) bad('accent.className is .is-<job>, e.g. .is-unowned');
  }
  const ic = spec.icons;
  if (!isObj(ic) || !isText(ic.family, LIMITS.name) || !(Number.isFinite(ic.stroke) && ic.stroke >= 1 && ic.stroke <= 4)) {
    bad('icons is { family, stroke (1-4) }');
  }
  return { ok: errors.length === 0, errors };
}

/** WCAG 2.x contrast ratio of two #RRGGBB colours, rounded to one decimal. */
export function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 10) / 10;
}

const family = (f) => (f ? `"${f}", ${SANS}` : SANS);
const familyName = (s) => s.family || SYSTEM_FAMILY;
const byPx = (steps) => [...steps].sort((x, y) => y.px - x.px);
const stepFor = (spec, role, fallbackIndex) => {
  const sorted = byPx(spec.typeSteps);
  return sorted.find((s) => s.role === role) || sorted[Math.min(fallbackIndex, sorted.length - 1)];
};
const groundOf = (spec, id) => spec.grounds.find((g) => g.id === id) || spec.grounds[0];

function page(title, width, height, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${esc(title)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${width}px;height:${height}px;overflow:hidden;background:#F6F5F1;color:#1C1D21;font:400 18px/1.4 ${SANS}}
.pg{padding:${PAD}px 64px}
.kick{height:20px;font:600 14px/20px ${SANS};letter-spacing:.14em;text-transform:uppercase;color:#8A8983;${ONE}}
h1{font:700 40px/44px ${SANS};margin:10px 0 36px;letter-spacing:-.01em}
h2{height:20px;font:600 14px/20px ${SANS};letter-spacing:.12em;text-transform:uppercase;color:#8A8983;margin:0 0 12px;${ONE}}
.card{background:#fff;border:1px solid #E7E5DF;border-radius:18px;box-shadow:0 1px 2px rgba(20,20,20,.04),0 8px 24px rgba(20,20,20,.05)}
.mono{font-family:${MONO}}
.row{display:flex;gap:24px}
.sw{flex:1;min-width:0;overflow:hidden}
.sw .fill{height:210px;padding:24px;display:flex;flex-direction:column;justify-content:space-between}
.sw .aa{font:700 72px/1 ${SANS}}
.sw .cr{font:600 14px/1 ${MONO};opacity:.8}
.sw .meta{height:156px;padding:18px 22px}
.sw .nm{font:600 20px/24px ${SANS};${ONE}}
.sw .hx{font:500 14px/22px ${MONO};color:#6D6C66;${ONE}}
.sw .jb{font-size:16px;line-height:22px;color:#3A3B40;margin-top:6px;${CLAMP(3)}}
.ladder{padding:28px 32px;margin-top:36px}
.step{display:flex;align-items:center;gap:28px;padding:10px 0;border-top:1px solid #EFEDE8}
.step:first-of-type{border-top:0}
.step .lb{width:340px;flex:none;font:500 14px/22px ${MONO};color:#6D6C66}
.step .lb b{display:block;font:600 16px/22px ${SANS};color:#1C1D21;${ONE}}
.step .lb span{display:block;${ONE}}
.step .tx{flex:1;min-width:0;${ONE}}
.bottom{display:flex;gap:24px;margin-top:36px;height:${BOTTOM}px}
.acc,.ico{flex:1;min-width:0;overflow:hidden;padding:28px 32px}
.acc .top{display:flex;align-items:center;gap:16px;height:56px}
.acc .chip{flex:none;width:56px;height:56px;border-radius:14px}
.acc .ln{min-width:0;font:600 22px/28px ${SANS};${ONE}}
.acc p{margin-top:16px;font-size:18px;line-height:26px;color:#3A3B40;${CLAMP(3)}}
.acc .cls{display:block;width:fit-content;max-width:100%;margin-top:14px;padding:4px 10px;border-radius:8px;background:#F1EFEA;font:500 14px/20px ${MONO};${ONE}}
.ico .set{display:flex;gap:26px;margin-top:18px;color:#1C1D21}
.grid{display:grid;gap:${GAP}px}
.cmp{min-width:0;padding:16px 16px 18px}
.frame{position:relative;width:100%;aspect-ratio:16/9;border-radius:10px;overflow:hidden}
.cap{margin-top:14px;height:24px}
.cap.jobs{height:96px}
.cap .nm{font:600 19px/24px ${SANS};${ONE}}
.cap .jb{font-size:15px;line-height:21px;color:#55555A;margin-top:4px;${CLAMP(2)}}
.cap .ct{font:500 13px/20px ${MONO};color:#8A8983;margin-top:6px;${ONE}}
.bar{position:absolute;border-radius:4px;opacity:.22}
.wt{position:absolute;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical}
</style></head><body><div class="pg">${body}</div></body></html>`;
}

const ICONS = ['M4 12h14M13 6l6 6-6 6', 'M5 13l4 4L19 7', 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0', 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  'M5 21V4h11l-2 4 2 4H5'];
const icon = (d, stroke) => `<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;

/** The system sheet: grounds as swatches, the type ladder at true relative size, accent, icons. */
export function sheetPage(spec) {
  const steps = byPx(spec.typeSteps);
  const scale = Math.min(1, 150 / steps[0].px);          // the largest step shows at ≤150px; ratios are kept
  const size = (s) => Math.round(s.px * scale * 10) / 10;
  // the sample is one line, 1.2 × its size high; the label beside it is LABEL high; the row takes the taller
  const rowH = (s) => Math.max(Math.ceil(size(s) * 1.2), LABEL) + STEP_PAD;
  const ladderH = 1 + 28 + H2 + steps.reduce((n, s) => n + rowH(s), 0) + 28 + 1;
  const height = PAD + HEAD + H2 + SWATCH + 36 + ladderH + 36 + BOTTOM + PAD;
  const swatches = spec.grounds.map((g) => `<div class="card sw">
  <div class="fill" style="background:${g.hex};color:${g.ink}"><span class="aa">Aa</span><span class="cr">${contrast(g.hex, g.ink)}:1 ink on ground</span></div>
  <div class="meta"><div class="nm">${esc(g.name)}</div><div class="hx">${esc(g.hex)} · ink ${esc(g.ink)}</div><div class="jb">${esc(g.job)}</div></div>
</div>`).join('');
  const ladder = steps.map((s) => `<div class="step" style="height:${rowH(s)}px">
  <div class="lb"><b>${esc(s.name)}</b><span>${s.px}px · ${esc(familyName(s))} ${s.weight}</span></div>
  <div class="tx" style="font:${s.weight} ${size(s)}px/1.2 ${esc(family(s.family))}">${esc(s.sample || spec.coverTitle)}</div>
</div>`).join('');
  const a = spec.accent;
  const body = `<div class="kick">${esc(spec.deckTitle)}</div><h1>Visual system</h1>
<h2>Grounds</h2><div class="row">${swatches}</div>
<div class="card ladder"><h2>Type scale — true proportions${scale < 1 ? ` at ${Math.round(scale * 100)}%` : ''}</h2>${ladder}</div>
<div class="bottom">
  <div class="card acc"><h2>Accent — one job</h2><div class="top"><span class="chip" style="background:${a.hex}"></span><span class="ln">${esc(a.name)} <span class="mono">${esc(a.hex)}</span></span></div>
    <p>${esc(a.job)}</p><span class="cls">${esc(a.className)}</span></div>
  <div class="card ico"><h2>Icons — ${esc(spec.icons.family)}, ${spec.icons.stroke}px stroke, currentColor (stroke sample)</h2>
    <div class="set">${ICONS.map((d) => icon(d, spec.icons.stroke)).join('')}</div></div>
</div>`;
  return { name: 'system-sheet', width: WIDTH, height, html: page(`${spec.deckTitle} — visual system`, WIDTH, height, body) };
}

/** One composition as a wireframe in a 16:9 frame, drawn with its real slide title. */
function wireframe(spec, c) {
  const g = groundOf(spec, c.ground);
  const title = stepFor(spec, 'title', 1);
  const t = (txt, css, lines = 2) => `<div class="wt" style="${css};-webkit-line-clamp:${lines};color:${g.ink};font-family:${esc(family(title.family))};font-weight:${title.weight}">${esc(txt)}</div>`;
  const bar = (l, tp, w, h, color = g.ink) => `<div class="bar" style="left:${l}%;top:${tp}%;width:${w}%;height:${h}%;background:${color}${color === g.ink ? '' : ';opacity:.9'}"></div>`;
  // the accent on its own ground would vanish: fall back to the ink there
  const acc = spec.accent.hex.toLowerCase() === g.hex.toLowerCase() ? g.ink : spec.accent.hex;
  const [t1] = c.titles;
  // the number in the title, else the hero step's sample (the real hero number), else a dash
  const hero = spec.typeSteps.find((s) => s.role === 'hero');
  const num = ((/\d[\d.,]*\s?[%x×]?/.exec(t1) || [hero && hero.sample ? hero.sample : '—'])[0]).trim();
  const shapes = {
    cover: t(spec.deckTitle, 'left:7%;top:12%;width:60%;font-size:11px;opacity:.7', 1) + t(t1, 'left:7%;top:38%;width:80%;font-size:28px;line-height:1.1', 3) + bar(7, 88, 14, 2, acc),
    statement: t(t1, 'left:10%;top:30%;width:80%;font-size:30px;line-height:1.15;text-align:center', 3),
    divider: t('01', 'left:8%;top:18%;font-size:64px;line-height:1', 1) + t(t1, 'left:8%;top:58%;width:80%;font-size:24px;line-height:1.15', 2),
    figure: t(t1, 'left:6%;top:7%;width:88%;font-size:17px;line-height:1.2') + bar(6, 36, 12, 52) + bar(22, 50, 12, 38) + bar(38, 28, 12, 60, acc) + bar(54, 58, 12, 30) + bar(70, 44, 12, 44),
    'two-column': t(t1, 'left:6%;top:7%;width:88%;font-size:17px;line-height:1.2') + [34, 46, 58, 70].map((y) => bar(6, y, 40, 5) + bar(54, y, 40, 5)).join(''),
    ledger: t(t1, 'left:6%;top:7%;width:88%;font-size:17px;line-height:1.2') + [34, 45, 56, 67, 78].map((y, i) => bar(6, y, 88, 6, i === 2 ? acc : g.ink)).join(''),
    'hero-number': t(num, 'left:8%;top:10%;font-size:96px;line-height:1', 1) + t(t1, 'left:8%;top:68%;width:84%;font-size:17px;line-height:1.2'),
    quote: t('“', 'left:7%;top:4%;font-size:80px;line-height:1', 1) + t(t1, 'left:12%;top:34%;width:76%;font-size:22px;line-height:1.2;font-style:italic', 3),
    ask: t(t1, 'left:8%;top:24%;width:84%;font-size:26px;line-height:1.15', 2) + bar(8, 70, 30, 12, acc),
    list: t(t1, 'left:6%;top:7%;width:88%;font-size:17px;line-height:1.2') + [36, 52, 68].map((y) => bar(6, y, 3, 6, acc) + bar(12, y, 70, 6)).join(''),
  };
  return `<div class="frame" style="background:${g.hex}">${shapes[c.kind]}</div>`;
}

/** Every named composition as a wireframe filled with a REAL slide title from the deck. */
export function compositionsPage(spec) {
  const cols = spec.compositions.length <= 4 ? 2 : 3;
  const height = gridHeight(spec.compositions.length, cols, CAP_JOBS);
  const cards = spec.compositions.map((c) => `<div class="card cmp">${wireframe(spec, c)}
  <div class="cap jobs"><div class="nm">${esc(c.name)}</div><div class="jb">${esc(c.job)}</div>
  <div class="ct">${c.slides} slide${c.slides === 1 ? '' : 's'} · ${esc(groundOf(spec, c.ground).name)} · ${esc(c.kind)}</div></div></div>`).join('');
  const body = `<div class="kick">${esc(spec.deckTitle)}</div><h1>Compositions</h1>
<div class="grid" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">${cards}</div>`;
  return { name: 'compositions', width: WIDTH, height, html: page(`${spec.deckTitle} — compositions`, WIDTH, height, body) };
}

/** A page of `n` .cmp cards in `cols` columns: each card is a 16:9 frame over a `cap`-high caption. */
function gridHeight(n, cols, cap) {
  const colW = (WIDTH - 128 - GAP * (cols - 1)) / cols;
  const cardH = CARD_Y + (colW - 34) * 9 / 16 + cap;
  const rows = Math.ceil(n / cols);
  return Math.ceil(PAD + HEAD + rows * cardH + (rows - 1) * GAP + PAD);
}

/** The cover, on every ground: the one question a ground answers is "does this read on it?". */
export function samplesPage(spec) {
  const cols = spec.grounds.length === 1 ? 1 : 2;
  const cardW = (WIDTH - 128 - GAP * (cols - 1)) / cols;
  const k = cardW / 1920;                                  // the slide is 1920×1080, shown at k
  const height = gridHeight(spec.grounds.length, cols, CAP_ONE);
  const title = stepFor(spec, 'title', 1);
  const caption = stepFor(spec, 'caption', spec.typeSteps.length - 1);
  const cards = spec.grounds.map((g) => {
    const acc = spec.accent.hex.toLowerCase() === g.hex.toLowerCase() ? g.ink : spec.accent.hex;
    return `<div class="card cmp"><div class="frame" style="background:${g.hex};color:${g.ink}">
  <div class="wt" style="left:7%;top:10%;width:70%;-webkit-line-clamp:1;font:${caption.weight} ${Math.round(caption.px * k * 10) / 10}px/1.3 ${esc(family(caption.family))};opacity:.75">${esc(spec.deckTitle)}</div>
  <div class="wt" style="left:7%;top:44%;width:84%;-webkit-line-clamp:3;font:${title.weight} ${Math.round(title.px * k * 10) / 10}px/1.1 ${esc(family(title.family))}">${esc(spec.coverTitle)}</div>
  <div class="bar" style="left:7%;top:86%;width:12%;height:1.6%;opacity:1;background:${acc}"></div>
</div><div class="cap"><div class="nm">${esc(g.name)} <span class="mono" style="font-size:14px;line-height:1;color:#8A8983">${esc(g.hex)} · ${contrast(g.hex, g.ink)}:1</span></div></div></div>`;
  }).join('');
  const body = `<div class="kick">${esc(spec.deckTitle)}</div><h1>The cover on every ground</h1>
<div class="grid" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">${cards}</div>`;
  return { name: 'samples', width: WIDTH, height, html: page(`${spec.deckTitle} — samples`, WIDTH, height, body) };
}

/** The three pages, in the order the form's tabs show them. */
export function previewPages(spec) {
  return [sheetPage(spec), compositionsPage(spec), samplesPage(spec)];
}

/** Page name → the `approve-system` data field that carries its PNG. */
export const IMAGE_FIELDS = Object.freeze({ 'system-sheet': 'sheet', compositions: 'compositionsSheet', samples: 'samples' });

/** The `approve-system` form data for this spec. `images`: { sheet, compositionsSheet, samples }
 *  as RUN-RELATIVE paths, or null when no PNG was rendered (the fields are then omitted).
 *  `chrome`: whether a Chrome was found, so the headline can say why a picture is missing. */
export function formData(spec, { images = null, chrome = false } = {}) {
  const a = spec.accent;
  const lead = 'Review the system below, then approve it or pick what to rework.';
  const missing = images ? Object.keys(IMAGE_FIELDS).filter((n) => !images[IMAGE_FIELDS[n]]) : [];
  const data = {
    headline: !images ? `Preview images unavailable (${chrome ? 'Chrome could not render them' : 'no Chrome found'}); the tables below carry the system.`
      : missing.length ? `Not rendered: ${missing.join(', ')}; the tables below carry the system.` : lead,
    grounds: spec.grounds.map((g) => ({ id: g.id, name: g.name, hex: g.hex, ink: g.ink, job: g.job })),
    typeSteps: byPx(spec.typeSteps).map((s) => ({ id: s.id, name: s.name, px: s.px, family: familyName(s), weight: s.weight })),
    compositions: spec.compositions.map((c) => ({ id: c.id, name: c.name, job: c.job, slides: c.slides })),
    accent: `${a.name} ${a.hex}: ${a.job} (class ${a.className})`,
  };
  if (images) for (const k of ['sheet', 'compositionsSheet', 'samples']) if (images[k]) data[k] = images[k];
  return data;
}
