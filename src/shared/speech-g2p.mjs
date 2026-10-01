// src/shared/speech-g2p.mjs
// English text → Kokoro phonemes, without eSpeak NG (GPL-3.0) — docs/speech.md.
// Kokoro v1.0 was trained on misaki's phoneme set; this is a small JavaScript take
// on misaki's English G2P (github.com/hexgrad/misaki, Apache-2.0): its gold/silver
// pronunciation dictionaries (downloaded at run time, src/core/speech-assets.mjs),
// its -s / -ed / -ing suffix rules and letter spelling, plus our own number
// reading and a rough letter-to-sound fallback for words no dictionary knows.
// No part-of-speech tagging: a word with several readings uses its DEFAULT one.
// Pure: the worker passes the dictionaries in; tests pass small ones.

const PRIMARY = 'ˈ';
const SECONDARY = 'ˌ';
const VOWELS = new Set('AIOQWYaiuæɑɒɔəɛɜɪʊʌᵻ');
const US_TAUS = new Set('AIOWYiuæɑəɛɪɹʊʌ');
const PUNCT = new Set(';:,.!?—…"“”()');

// ── numbers → words ──────────────────────────────────────────────────────────
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = [[1e12, 'trillion'], [1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];

/** 1234 → 'one thousand two hundred thirty-four' (integers up to the trillions). */
export function numberToWords(n) {
  n = Math.floor(Math.abs(n));
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberToWords(n % 100)}` : ''}`;
  for (const [size, name] of SCALES) {
    if (n >= size) {
      const rest = n % size;
      return `${numberToWords(Math.floor(n / size))} ${name}${rest ? ` ${numberToWords(rest)}` : ''}`;
    }
  }
  return String(n);
}

const ORDINAL_WORDS = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
/** 21 → 'twenty-first' */
export function ordinalToWords(n) {
  const w = numberToWords(n);
  return w.replace(/([a-z]+)$/, (last) => ORDINAL_WORDS[last] || (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`));
}

/** 1999 → 'nineteen ninety-nine', 2005 → 'two thousand five', 2025 → 'twenty twenty-five' */
function yearToWords(y) {
  if (y % 1000 < 10 || (y >= 2000 && y < 2010)) return numberToWords(y);
  const hi = Math.floor(y / 100);
  const lo = y % 100;
  if (lo === 0) return `${numberToWords(hi)} hundred`;
  return `${numberToWords(hi)} ${lo < 10 ? `oh ${ONES[lo]}` : numberToWords(lo)}`;
}

const CURRENCY = { $: ['dollar', 'cent'], '£': ['pound', 'penny'], '€': ['euro', 'cent'] };
const plural = (n, [one, many]) => (n === 1 ? one : many);
const CURRENCY_PLURALS = { dollar: 'dollars', cent: 'cents', pound: 'pounds', penny: 'pence', euro: 'euros' };

function money(sym, whole, frac) {
  const [major, minor] = CURRENCY[sym];
  const a = Number(whole.replace(/,/g, ''));
  const b = frac ? Number(frac.padEnd(2, '0').slice(0, 2)) : 0;
  const parts = [];
  if (a || !b) parts.push(`${numberToWords(a)} ${plural(a, [major, CURRENCY_PLURALS[major]])}`);
  if (b) parts.push(`${numberToWords(b)} ${plural(b, [minor, CURRENCY_PLURALS[minor]])}`);
  return parts.join(' and ');
}

/** Spoken-form rewrite of numbers, money, times and a few symbols, before lookup. */
export function normalizeText(text) {
  return String(text)
    .replace(/[‘’]/g, "'")
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\bDr\.(?= [A-Z])/g, 'Doctor')
    .replace(/\bMrs\.(?= [A-Z])/g, 'Missus')
    .replace(/\bMr\.(?= [A-Z])/g, 'Mister')
    .replace(/\bMs\.(?= [A-Z])/g, 'Miss')
    .replace(/\be\.g\./gi, 'for example')
    .replace(/\bi\.e\./gi, 'that is')
    .replace(/\betc\./gi, 'et cetera')
    .replace(/\bvs\.?(?= )/gi, 'versus')
    .replace(/([$£€])(\d[\d,]*)(?:\.(\d{1,2}))?\b/g, (_, s, w, f) => money(s, w, f))
    .replace(/\b(\d{1,2}):([0-5]\d)\b/g, (_, h, m) => `${numberToWords(Number(h))}${m === '00' ? " o'clock" : Number(m) < 10 ? ` oh ${ONES[Number(m)]}` : ` ${numberToWords(Number(m))}`}`)
    .replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_, n) => ordinalToWords(Number(n)))
    .replace(/\b(1[1-9]\d\d|20\d\d)s\b/g, (_, y) => yearToWords(Number(y)).replace(/y$/, 'ie') + 's')
    .replace(/\b(1[1-9]\d\d|20\d\d)\b(?![.,]\d)/g, (_, y) => yearToWords(Number(y)))
    .replace(/(\d+(?:,\d{3})*)?\.(\d+)\b/g, (m0, w, f) => `${w ? numberToWords(Number(w.replace(/,/g, ''))) : 'zero'} point ${[...f].map((d) => ONES[Number(d)]).join(' ')}`)
    .replace(/\b\d{1,3}(?:,\d{3})+\b|\b\d+\b/g, (m0) => numberToWords(Number(m0.replace(/,/g, ''))))
    .replace(/(\S)%/g, '$1 percent').replace(/%/g, ' percent')
    .replace(/ & /g, ' and ')
    .replace(/ \+ /g, ' plus ')
    .replace(/(\w)-(?=\d)/g, '$1 ')
    .replace(/  +/g, ' ')
    .trim();
}

// ── dictionary lookup (misaki's Lexicon, without part-of-speech tags) ─────────

function restress(ps) {
  // Move each stress mark to just before the vowel that follows it.
  const out = [];
  let pending = '';
  for (const c of ps) {
    if (c === PRIMARY || c === SECONDARY) { pending = pending || c; continue; }
    if (pending && VOWELS.has(c)) { out.push(pending); pending = ''; }
    out.push(c);
  }
  return out.join('');
}

/** stress 0: demote to secondary; undefined: as stored. */
function applyStress(ps, stress) {
  if (ps == null || stress == null) return ps;
  if (stress === 0) {
    if (ps.includes(PRIMARY)) return ps.replace(/ˌ/g, '').replace(/ˈ/g, SECONDARY);
    if (!ps.includes(SECONDARY) && [...ps].some((c) => VOWELS.has(c))) return restress(SECONDARY + ps);
  }
  return ps;
}

/**
 * createG2P({ gold, silver, british, also }) → { phonemize(text) → string, word(w) → string|null }
 * gold / silver: misaki's {us,gb}_{gold,silver}.json objects (word → phonemes | { DEFAULT, … }).
 * also: a further dictionary tried before any guessing — the British G2P passes the American
 * gold one, which knows words the British lexicon lacks ("orchestrator").
 */
export function createG2P({ gold, silver = {}, british = false, also = {} }) {
  const ed_ = british ? 'ɪ' : 'ᵻ';

  function raw(word) {
    const v = Object.hasOwn(gold, word) ? gold[word] : Object.hasOwn(silver, word) ? silver[word] : Object.hasOwn(also, word) ? also[word] : undefined;
    if (v == null) return null;
    return typeof v === 'string' ? v : v.DEFAULT ?? null;
  }
  // misaki "grows" each dictionary with lower / Capitalized variants; look them up instead.
  function entry(word) {
    return raw(word)
      ?? (word.length > 1 && word === word.toLowerCase() ? raw(word[0].toUpperCase() + word.slice(1)) : null)
      ?? (word.length > 1 && word[0] === word[0].toUpperCase() && word.slice(1) === word.slice(1).toLowerCase() ? raw(word.toLowerCase()) : null)
      ?? (word.length > 1 && word === word.toUpperCase() ? raw(word.toLowerCase()) : null);
  }
  const known = (w) => entry(w) != null;

  /** Letter by letter: "NPM" → ˌɛnpˌiˈɛm (misaki's get_NNP). */
  function spell(word) {
    const letters = [...word].filter((c) => /[A-Za-z]/.test(c)).map((c) => raw(c.toUpperCase()));
    if (!letters.length || letters.some((p) => p == null)) return null;
    const ps = applyStress(letters.join(''), 0);
    const i = ps.lastIndexOf(SECONDARY);
    return i < 0 ? ps : ps.slice(0, i) + PRIMARY + ps.slice(i + 1);
  }

  function s_(stem) {
    if (!stem) return null;
    const last = stem.at(-1);
    if ('ptkfθ'.includes(last)) return `${stem}s`;
    if ('szʃʒʧʤ'.includes(last)) return `${stem}${ed_}z`;
    return `${stem}z`;
  }
  function stemS(w) {
    if (w.length < 3 || !w.endsWith('s')) return null;
    let stem;
    if (!w.endsWith('ss') && known(w.slice(0, -1))) stem = w.slice(0, -1);
    else if ((w.endsWith("'s") || (w.length > 4 && w.endsWith('es') && !w.endsWith('ies'))) && known(w.slice(0, -2))) stem = w.slice(0, -2);
    else if (w.length > 4 && w.endsWith('ies') && known(`${w.slice(0, -3)}y`)) stem = `${w.slice(0, -3)}y`;
    else return null;
    return s_(entry(stem));
  }
  function ed(stem) {
    if (!stem) return null;
    const last = stem.at(-1);
    if ('pkfθʃsʧ'.includes(last)) return `${stem}t`;
    if (last === 'd') return `${stem}${ed_}d`;
    if (last !== 't') return `${stem}d`;
    if (british || stem.length < 2) return `${stem}ɪd`;
    if (US_TAUS.has(stem.at(-2))) return `${stem.slice(0, -1)}ɾᵻd`;
    return `${stem}ᵻd`;
  }
  function stemEd(w) {
    if (w.length < 4 || !w.endsWith('d')) return null;
    let stem;
    if (!w.endsWith('dd') && known(w.slice(0, -1))) stem = w.slice(0, -1);
    else if (w.length > 4 && w.endsWith('ed') && !w.endsWith('eed') && known(w.slice(0, -2))) stem = w.slice(0, -2);
    else return null;
    return ed(entry(stem));
  }
  function ing(stem) {
    if (!stem) return null;
    if (!british && stem.length > 1 && stem.at(-1) === 't' && US_TAUS.has(stem.at(-2))) return `${stem.slice(0, -1)}ɾɪŋ`;
    return `${stem}ɪŋ`;
  }
  function stemIng(w) {
    if (w.length < 5 || !w.endsWith('ing')) return null;
    let stem;
    if (w.length > 5 && known(w.slice(0, -3))) stem = w.slice(0, -3);
    else if (known(`${w.slice(0, -3)}e`)) stem = `${w.slice(0, -3)}e`;
    else if (w.length > 5 && /([bcdgklmnprstvxz])\1ing$|cking$/.test(w) && known(w.slice(0, -4))) stem = w.slice(0, -4);
    else return null;
    return ing(applyStress(entry(stem), 0.5));
  }

  /** Two dictionary words glued together ("outofdictionary" is too far; "worktree" is not). */
  function compound(w) {
    const lw = w.toLowerCase();
    for (let i = lw.length - 3; i >= 3; i -= 1) {
      const a = entry(lw.slice(0, i));
      const b = a && entry(lw.slice(i));
      if (b) return `${a}${applyStress(b, 0)}`;
    }
    return null;
  }

  // A rough English letter-to-sound pass for what nothing else covers (names, jargon).
  const LTS = [
    ['tion', 'ʃən'], ['sion', 'ʒən'], ['ture', 'ʧəɹ'], ['ough', 'ɔ'], ['augh', 'ɔ'], ['eigh', 'A'], ['igh', 'I'],
    ['tch', 'ʧ'], ['sch', 'sk'], ['ch', 'ʧ'], ['sh', 'ʃ'], ['th', 'θ'], ['ph', 'f'], ['wh', 'w'], ['ck', 'k'], ['ng', 'ŋ'],
    ['qu', 'kw'], ['kn', 'n'], ['wr', 'ɹ'], ['ee', 'i'], ['ea', 'i'], ['ie', 'i'], ['oo', 'u'], ['ou', 'W'], ['ow', 'O'],
    ['oa', 'O'], ['oi', 'Y'], ['oy', 'Y'], ['ai', 'A'], ['ay', 'A'], ['au', 'ɔ'], ['aw', 'ɔ'], ['ew', 'ju'],
    ['er', 'əɹ'], ['ir', 'ɜɹ'], ['ur', 'ɜɹ'], ['ar', 'ɑɹ'], ['or', 'ɔɹ'],
  ];
  const LONG = { a: 'A', e: 'i', i: 'I', o: 'O', u: 'ju' };
  const SHORT = { a: 'æ', e: 'ɛ', i: 'ɪ', o: 'ɑ', u: 'ʌ' };
  const CONS = { b: 'b', d: 'd', f: 'f', h: 'h', j: 'ʤ', k: 'k', l: 'l', m: 'm', n: 'n', p: 'p', r: 'ɹ', s: 's', t: 't', v: 'v', w: 'w', x: 'ks', z: 'z', g: 'ɡ' };
  function sound(w) {
    const s = w.toLowerCase().replace(/[^a-z]/g, '');
    if (!s) return null;
    let out = '';
    let i = 0;
    let stressed = false;
    const mark = () => { if (!stressed) { out += PRIMARY; stressed = true; } };
    while (i < s.length) {
      const rule = LTS.find(([g]) => s.startsWith(g, i));
      if (rule) {
        if (VOWELS.has(rule[1][0]) || /^[aeiouy]/.test(rule[0])) mark();
        out += rule[1];
        i += rule[0].length;
        continue;
      }
      const c = s[i];
      const next = s[i + 1];
      if ('aeiou'.includes(c)) {
        const magicE = next && !'aeiou'.includes(next) && s[i + 2] === 'e' && i + 3 === s.length;
        if (c === 'e' && i === s.length - 1 && out) { i += 1; continue; }           // silent final e
        if (c === 'a' && i === s.length - 1 && stressed) { out += 'ə'; i += 1; continue; }   // unstressed final a
        mark();
        out += magicE ? LONG[c] : SHORT[c];
      } else if (c === 'y') {
        if (i === 0) out += 'j';
        else { if (i === s.length - 1 && !stressed) mark(); out += i === s.length - 1 ? 'i' : 'ɪ'; }
      } else if (c === 'c') {
        out += next && 'eiy'.includes(next) ? 's' : 'k';
      } else if (c === 'q') {
        out += 'k';
      } else if (CONS[c] && c !== next) {
        out += CONS[c];
      }
      i += 1;
    }
    return out || null;
  }

  function word(w) {
    if (w === 'a' || w === 'A') return 'ɐ';
    if (w === 'I') return `${SECONDARY}I`;
    if (w === 'an' || w === 'An') return 'ɐn';
    if (w === 'the' || w === 'The') return 'ðə';                  // ði before a vowel: see phonemize()
    const direct = entry(w);
    if (direct != null) return direct;
    if (w.endsWith("s'") && known(`${w.slice(0, -2)}'s`)) return entry(`${w.slice(0, -2)}'s`);
    const lw = w.toLowerCase();
    for (const fn of [stemS, stemEd, stemIng]) {
      const p = fn(w) ?? (lw !== w ? fn(lw) : null);
      if (p) return p;
    }
    if (/^[A-Z]{2,5}$/.test(w) || (w.length <= 3 && /^[a-z]+$/.test(w))) return spell(w);   // NPM, npm, API
    if (/^[A-Z]{2,5}s$/.test(w)) return s_(spell(w.slice(0, -1)));                        // APIs
    return compound(w) ?? sound(w) ?? spell(w);
  }

  /** Split camelCase, snake_case, kebab-case and letter/digit runs into speakable parts. */
  function parts(w) {
    return w.split(/[-_/]+/).flatMap((p) => p.match(/[A-Z]{2,}(?=[A-Z][a-z]|\b|\d)|[A-Z]?[a-z']+|[A-Z]+|\d+/g) || []);
  }

  function wordPhonemes(w) {
    // Whole word first (GitHub is in the dictionary); split only what is not.
    const split = /[-_/]/.test(w) || (/[a-z][A-Z]/.test(w) && !known(w));
    const direct = split ? null : word(w);
    if (direct) return direct;
    return parts(w).map((p) => (/^\d+$/.test(p) ? phonemize(numberToWords(Number(p))) : word(p))).filter(Boolean).join(' ');
  }

  function phonemize(text) {
    const tokens = normalizeText(text).match(/[A-Za-z][A-Za-z'\-_/]*[A-Za-z]|[A-Za-z]|\d+|[;:,.!?—…"“”()]/g) || [];
    let out = '';
    for (const t of tokens) {
      if (PUNCT.has(t)) { out = out.replace(/ $/, '') + t + ' '; continue; }
      let ps = /^\d+$/.test(t) ? phonemize(numberToWords(Number(t))) : wordPhonemes(t);
      if (!ps) continue;
      out += `${ps} `;
    }
    // "the" before a vowel sound is ði, otherwise ðə (misaki's future_vowel, simplified).
    return out.replace(/(?<=^|\s)ðə (?=[ˈˌ]?[AIOWYiuæɑɒɔəɛɜɪʊʌᵻ])/gu, 'ði ').trim();
  }

  return { phonemize, word: (w) => wordPhonemes(w) };
}
