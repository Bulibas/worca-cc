// src/core/skills-registry/inspect.mjs
// One skill folder, inspected (skills registry design §2b-8, §3.2 hash, §3.3, §5 import consent): its files with
// sizes and exec bits, the limits, the content hash, the SKILL.md frontmatter, and the findings an import preview
// shows before consent. Never runs anything, never reads through a symlink that leaves the folder, reads at most
// SKILL_LIMITS bytes, walks at most SKILL_LIMITS.files + 1 files and SKILL_LINKS_AND_FOLDERS_MAX + 1 links and
// folders. Sync: the catalog inspects on every spawn.

import { readdirSync, statSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, basename, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseYaml, parseDocument, visit, isAlias, isScalar, Scalar } from 'yaml';
import { FRONTMATTER_RE } from '../frontmatter.mjs';
import { hasTokenShape } from '../mcp-secrets.mjs';
import { SKILL_NAME_RE, SKILL_NAME_MAX, RESERVED_SKILL_NAMES } from './ids.mjs';
import { SKILL_HOOKS_TEXT } from './texts.mjs';

export const SKILL_LIMITS = { files: 300, fileBytes: 1048576, totalBytes: 8388608 };
/** Links and folders one skill folder may hold. Neither is a file, so SKILL_LIMITS never counts them; past this many
 *  the walk stops and the skill is invalid, which bounds every walk, problem list and catalog fingerprint. */
export const SKILL_LINKS_AND_FOLDERS_MAX = 1000;

/** Why `name` cannot name a skill folder, or null (Agent Skills names: §2b-9). */
export function skillNameProblem(name) {
  // A request body can carry any JSON value: one that is not text is never templated (`{"toString":0}` throws).
  if (typeof name !== 'string') return `name must be text, not ${name === null ? 'null' : Array.isArray(name) ? 'a list' : typeof name}`;
  if (name.length > SKILL_NAME_MAX || !SKILL_NAME_RE.test(name)) {
    return `name "${clip(name)}": use lowercase letters, digits and single hyphens (at most ${SKILL_NAME_MAX} characters)`;
  }
  return RESERVED_SKILL_NAMES.includes(name) ? `name "${name}" is reserved` : null;
}
export function isValidSkillFolderName(name) { return skillNameProblem(name) === null; }

// Inline `!`cmd`` and fenced ```! blocks: the two forms Claude Code runs when it renders a skill (and replaces
// with a placeholder under disableSkillShellExecution). The inline pattern is the CLI's own; the fenced one matches
// the same spans as the CLI's /```!\s*\n?[\s\S]*?\n?```/ (from ```! to the next ```) without its `\s*` before a
// lazy `[\s\S]*?`, which is quadratic: a 64 KB unclosed fence cost seconds of CPU on the event loop, 1 MB minutes.
const FENCED_SHELL_RE = /```![\s\S]*?```/g;
const INLINE_SHELL_RE = /(?<=^|\s)!`[^`]+`/gm;
const PLUGIN_ROOT_RE = /\$\{CLAUDE_PLUGIN_(?:ROOT|DATA)\}/;
const EXPANSION_RE = /\$\{([^}\s]{0,64})/g;
// Substitutions Claude Code itself makes in a skill: not a finding (the plugin-root pair has its own kind).
const KNOWN_SUBSTITUTIONS = new Set(['CLAUDE_SKILL_DIR', 'CLAUDE_SESSION_ID', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA']);

const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const unquote = (v) => (v.length >= 2 && /^(["']).*\1$/s.test(v) ? v.slice(1, -1) : v);
const clip = (s) => (s.length > 120 ? `${s.slice(0, 119)}…` : s);

/**
 * The value of a top-level `key:` of a frontmatter block: a plain or quoted scalar (continued on indented lines),
 * a block scalar (`|` keeps lines, `>` folds them), or a `- item` list (joined with ", "). null when absent.
 * The shared reader (frontmatter.mjs parseFrontmatter) keeps single-line scalars only; skill descriptions are
 * often block scalars.
 */
function fmField(yaml, key) {
  const lines = yaml.split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith(key) && /^[ \t]*:/.test(l.slice(key.length)));
  if (at < 0) return null;
  const head = lines[at].slice(lines[at].indexOf(':') + 1).trim();
  const body = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() && !/^[ \t]/.test(l)) break;
    body.push(l.trim());
  }
  while (body.length && !body[body.length - 1]) body.pop();
  if (/^[>|][+-]?$/.test(head)) return head[0] === '|' ? body.join('\n') : body.filter(Boolean).join(' ');
  const items = body.filter(Boolean);
  if (!head && items.length && items.every((l) => l.startsWith('- '))) return items.map((l) => unquote(l.slice(2).trim())).join(', ');
  return unquote([head, ...items].filter(Boolean).join(' '));
}

// What Claude Code takes from a SKILL.md frontmatter (2.1.292, its frontmatter reader): `hooks` and `shell` feed the
// consent badges and `name` the name check, so they are read the way it reads them. It drops a BOM; cuts the block
// from the first `---` line to the next `---` anywhere, even inside a line (CLI_FRONTMATTER_RE, tried only when a
// second `---` exists, which keeps it linear); parses it with Bun.YAML — merge keys (`<<`) merged (by bunObject: the
// `yaml` package's own merge is off), a duplicate key's last value kept (YAML_OPTIONS), a lone CR a line break, every
// key named by its JS text (bunObject); when that throws, parses it once more after quoting each plain `key: value`
// line whose value holds YAML syntax and turning leading tabs into spaces (cliRetryText, its own retry); reads a
// document that is not a map as {}; and names the skill by String(name), untrimmed, when it is set and at most
// CLI_NAME_MAX characters long. The `yaml` package and Bun do not refuse the same blocks (Bun takes a `!<!>` tag, two
// merge keys in one map and any number of aliases, and refuses an escaped lone surrogate), and the retry can read other
// keys than the first parse (a quoted anchor line moves an alias to an earlier anchor), so Worca cannot know which text
// Claude Code reads: it reads both (cliFrontmatter), shows a badge either reading declares, and checks a name only when
// the two cannot name the skill differently. A block over FRONTMATTER_PARSE_MAX, one that parses neither way, one whose
// two readings name the skill differently, or one Bun reads in a way the `yaml` package cannot follow (a throw) is
// unknown: it shows both badges (a false badge, never a hidden one), and its name cannot be checked, so the skill is
// invalid (the line reader still gives the name, for display; no real SKILL.md comes near). The cap bounds the CPU on
// the event loop (the `yaml` package's error path costs ~50 ms per 16 KB; the CLI caps no plugin skill's block, and
// real ones are a few KB).
const CLI_FRONTMATTER_RE = /^---\s*\n([\s\S]*?)---\s*\n?/;
const FRONTMATTER_PARSE_MAX = 16384;
// resolveKnownTags off: Bun leaves YAML 1.1's explicit tags (!!binary, !!timestamp, !!set, !!omap, !!pairs) as text or a
// plain collection, where the `yaml` package decoded `!!binary shell: zsh` into a key of bytes that no reading named shell.
const YAML_OPTIONS = { logLevel: 'error', merge: false, uniqueKeys: false, resolveKnownTags: false };
const MERGE_DEPTH_MAX = 64;
const CLI_NAME_MAX = 256;
// The keys P1 takes from Claude Code's reading. Two keys of one map read as one of them (`name:` and `[name]:`) are
// ordered where Worca cannot follow: a `mapAsMap` Map keeps a key at its first place, Bun keeps the pairs in order.
const CLI_KEYS = new Set(['name', 'hooks', 'shell']);

/**
 * The object Bun.YAML builds from a parsed map (`mapAsMap`), where the `yaml` package's own would differ: a key is
 * named by its JS text, so `[hooks]:` and `? [hooks]` are "hooks" (the `yaml` package names them "[ hooks ]"); a key
 * whose text is `<<` merges however it is quoted (`"<<": *a`), and each source is merged in full first — the `yaml`
 * package's merge (off in YAML_OPTIONS) merges a plain `<<` only and copied a source's own `"<<"` key raw, so a later
 * source's was dropped with every key it merged. Non-map sources are ignored, as Bun ignores them. Own keys win over
 * merged ones, earlier merge sources over later ones. Each map is read once (a bomb of aliases stays linear);
 * a merge chain deeper than MERGE_DEPTH_MAX, one that loops, or two keys of one map read as one of CLI_KEYS throws (the
 * block is then unknown).
 */
function bunObject(doc) {
  const done = new Map();
  const read = (map, depth) => {
    if (done.has(map)) return done.get(map);
    if (depth > MERGE_DEPTH_MAX) throw new Error('merge chain too deep');
    const own = Object.create(null);
    const sources = [];
    for (const [k, v] of map) {
      if (k === '<<') { sources.push(...(Array.isArray(v) ? v : [v]).filter((s) => s instanceof Map)); continue; }
      const key = String(k);
      if (Object.hasOwn(own, key) && CLI_KEYS.has(key)) throw new Error(`two keys read as ${key}`);
      own[key] = v;
    }
    for (const s of sources) {
      const merged = read(s, depth + 1);
      for (const key of Object.keys(merged)) if (!Object.hasOwn(own, key)) own[key] = merged[key];
    }
    done.set(map, own);
    return own;
  };
  return read(doc, 0);
}

/**
 * One text read as Bun.YAML reads it → { obj, broken }, with the `yaml` package (`mapAsMap`: keys keep their type, for
 * bunObject; its own merge off). `broken`: the `yaml` package reports a syntax error, an alias has no anchor before it,
 * or a double-quoted scalar's escapes leave a lone surrogate half (Bun refuses it, the `yaml` package keeps it); `obj`
 * is the reading of what did parse (an alias without an anchor reads as null), or null when even that cannot be built
 * (more aliases than the `yaml` package's cap, which Bun does not have). Throws for what Bun reads and the `yaml`
 * package cannot follow: a map holding two merge keys (plain or quoted `<<`, or an alias to one — with duplicate
 * keys allowed the `yaml` package keeps only the last, where Bun merges both), and bunObject's refusals. A lone CR is a
 * line break, as in Bun (to the `yaml` package it is text: in a comment, it hid the next key). An alias used as a key is
 * resolved through one pass over the anchors, in document order (each Alias.resolve re-walks the document: 16 KB of
 * `*k :` lines cost 3.5 s on the event loop).
 */
function bunRead(src) {
  const doc = parseDocument(src.replace(/\r(?!\n)/g, '\n'), YAML_OPTIONS);
  let broken = doc.errors.length > 0;
  const anchored = new Map();
  const target = new Map();
  visit(doc, (_, node) => {
    if (isAlias(node)) target.set(node, anchored.get(node.source));
    else if (node?.anchor) anchored.set(node.anchor, node);
  });
  visit(doc, {
    Map(_, map) {
      let merges = 0;
      for (const { key } of map.items) {
        const k = isAlias(key) ? target.get(key) : key;
        if (isScalar(k) && k.value === '<<' && ++merges > 1) throw new Error('two merge keys in one map');
      }
    },
    Scalar(_, s) {
      if (s.type === 'QUOTE_DOUBLE' && typeof s.value === 'string' && !s.value.isWellFormed()) broken = true;
    },
    Alias(_, a) {
      if (target.get(a)) return undefined;
      broken = true;
      return new Scalar(null);
    },
  });
  let js;
  try { js = doc.toJS({ mapAsMap: true }); } catch { return { obj: null, broken: true }; }
  return { obj: js instanceof Map ? bunObject(js) : {}, broken };
}
const CLI_RETRY_SYNTAX_RE = /[{}[\]*&#!|>%@`]|: /;
const CLI_RETRY_LINE_RE = /^([a-zA-Z_-]+):\s+(\S.*)$/;
function cliRetryText(y) {
  return y.split('\n').map((line) => {
    const m = CLI_RETRY_LINE_RE.exec(line);
    if (!m) return line;
    const [, key, value] = m;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return line;
    if (value.startsWith('[') && value.endsWith(']')) {
      try { if (Array.isArray(parseYaml(value, YAML_OPTIONS))) return line; } catch { /* quoted below */ }
    }
    return CLI_RETRY_SYNTAX_RE.test(value) ? `${key}: "${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` : line;
  }).join('\n').replace(/^\t+/gm, (tabs) => '  '.repeat(tabs.length));
}

/**
 * The frontmatter objects Claude Code may read from a SKILL.md text → { main, other } ({ main: {}, other: null } when
 * it reads none), or null when unknown. Claude Code reads the first text when Bun takes it, else the retry: `main` is
 * the one the `yaml` package's verdict picks, `other` the reading of the other text (null when there is none), since
 * Bun's verdict may differ. Unknown: neither text parses, the first text cannot even be read in part, or a throw (what
 * Bun reads and the `yaml` package cannot follow, or anything the `yaml` package throws).
 */
function cliFrontmatter(text) {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const m = t.indexOf('---', 3) < 0 ? null : CLI_FRONTMATTER_RE.exec(t);
  if (!m) return { main: {}, other: null };
  if (m[1].length > FRONTMATTER_PARSE_MAX) return null;
  try {
    const first = bunRead(m[1]);
    const retried = cliRetryText(m[1]);
    const retry = retried === m[1] ? first : bunRead(retried);
    const [main, other] = first.broken ? [retry, first] : [first, retry];
    if (main.broken || main.obj === null || (first.broken && first.obj === null)) return null;
    return { main: main.obj, other: other === main ? null : other.obj };
  } catch {
    return null;
  }
}

/** The SKILL.md frontmatter fields a skill registry reads, or null when the text has no frontmatter. */
export function skillMdFields(text) { return frontmatterOf(text)?.fields ?? null; }

// The CLI names a skill by String(name), untrimmed, when it is set and at most CLI_NAME_MAX long (a list or a number
// too: `name: [other]` is "other"), else by its folder.
const cliName = (o) => (o?.name == null || String(o.name).length > CLI_NAME_MAX ? null : String(o.name));

// The other reading's name is let pass only when it is a `name:` line's value that the retry quoted as written
// (`name: s # note` reads "s # note" there, and only a first text Bun refuses would show that). A name that holds YAML
// syntax for another reason — an alias the retry's quoting moved to another anchor (`y: &n s` lost its anchor, so
// `"name": *n` read an earlier `&n [evil, "#"]`) — is a name the two readings give differently.
const retryQuoted = (y, name) => CLI_RETRY_SYNTAX_RE.test(name)
  && y.split('\n').some((line) => { const m = CLI_RETRY_LINE_RE.exec(line); return m !== null && m[1] === 'name' && m[2] === name; });

// → { fields, unknown } | null. `unknown`: Worca cannot read the block the way Claude Code does (cliFrontmatter null, or
// its two readings name the skill differently), so the name it shows is the line reader's guess and cannot be checked
// against the skill's name.
function frontmatterOf(text) {
  const m = typeof text === 'string' ? FRONTMATTER_RE.exec(text) : null;
  if (!m) return null;
  const y = m[1];
  const cli = cliFrontmatter(text);
  const alt = cli?.other ? cliName(cli.other) : null;
  const unknown = cli === null || (alt !== null && alt !== cliName(cli.main) && !retryQuoted(y, alt));
  const declares = (key) => unknown || Object.hasOwn(cli.main, key) || (cli.other !== null && Object.hasOwn(cli.other, key))
    || fmField(y, key) !== null;
  return { unknown, fields: {
    name: unknown ? fmField(y, 'name') : cliName(cli.main),
    description: fmField(y, 'description') ?? '',
    whenToUse: fmField(y, 'when_to_use') || null,
    allowedTools: fmField(y, 'allowed-tools'),
    hooks: declares('hooks'),
    shell: declares('shell'),
    disableModelInvocation: /^true$/i.test(fmField(y, 'disable-model-invocation') ?? ''),
  } };
}

/** skillMdFields of `<absDir>/SKILL.md`; null when it is missing, unreadable, not a regular file (a link, a pipe, a
 *  device: never followed — a SKILL.md linked to /dev/zero or a FIFO would block the server), over 1 MB, or has no
 *  frontmatter. */
export function readSkillMd(absDir) {
  try {
    const file = join(absDir, 'SKILL.md');
    const st = lstatSync(file);
    if (!st.isFile() || st.size > SKILL_LIMITS.fileBytes) return null;
    return skillMdFields(readFileSync(file, 'utf8'));
  } catch { return null; }
}

/**
 * §3.2 content hash: sha256 over the files sorted by path, each `path NUL x NUL sha256(bytes) LF`, where x is 1
 * when any exec bit is set (mode & 0o111), else 0. One bit, not the raw bits: the library rewrites modes to
 * 0600/0700, and the hash of an imported skill must equal its stage's.
 * @param {Array<{path:string, mode:number, sha256:string}>} files
 */
export function skillHash(files) {
  const h = createHash('sha256');
  for (const f of [...files].sort(byPath)) h.update(`${f.path}\0${f.mode & 0o111 ? 1 : 0}\0${f.sha256}\n`);
  return h.digest('hex');
}

// A dangling symlink escapes when its text resolves outside the root (plugin-manifest.mjs findEscapingSymlinks'
// rule). A live one is judged by its realpath, so a chain of in-folder links cannot lead out.
function escapes(root, linkPath) {
  let target;
  try { target = readlinkSync(linkPath); } catch { return true; }
  const abs = isAbsolute(target) ? resolve(target) : resolve(dirname(linkPath), target);
  return abs !== root && !abs.startsWith(root + sep);
}

/** Walk `root` (sorted, depth first, `.git` ignored): file records, walk problems and findings. Bounded by
 *  SKILL_LIMITS and SKILL_LINKS_AND_FOLDERS_MAX: a farm of links or empty folders stops it too. */
function walk(root) {
  const records = [];
  const problems = [];
  const findings = [];
  let total = 0;
  let others = 0;
  let stop = false;
  // Anything that cannot be read is a problem, never a throw (the catalog lists every skill, valid or not) and
  // never a silent gap in the files and the hash.
  const unreadable = (rel, e) => problems.push(`${rel}: cannot be read (${e?.code ?? 'error'})`);
  const add = (abs, rel, st) => {
    const rec = { path: rel, bytes: st.size, mode: st.mode & 0o111, sha256: '', text: null };
    records.push(rec);
    total += st.size;
    if (records.length > SKILL_LIMITS.files) { problems.push(`more than ${SKILL_LIMITS.files} files`); stop = true; return; }
    if (st.size > SKILL_LIMITS.fileBytes) { problems.push(`${rel}: larger than 1 MB`); return; }
    if (total > SKILL_LIMITS.totalBytes) return;
    let buf;
    try { buf = readFileSync(abs); } catch (e) { unreadable(rel, e); return; }
    rec.sha256 = sha256(buf);
    if (!buf.subarray(0, 8000).includes(0)) rec.text = buf.toString('utf8');
  };
  const visit = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) {
      unreadable(dir === root ? 'the skill folder' : `${dir.slice(root.length + 1).split(sep).join('/')}/`, e);
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (stop) return;
      if (e.name === '.git') continue;
      if ((e.isSymbolicLink() || e.isDirectory()) && ++others > SKILL_LINKS_AND_FOLDERS_MAX) {
        problems.push(`more than ${SKILL_LINKS_AND_FOLDERS_MAX} links and folders`);
        stop = true;
        return;
      }
      const abs = join(dir, e.name);
      const rel = abs.slice(root.length + 1).split(sep).join('/');
      if (e.isSymbolicLink()) {
        const flag = (text) => { problems.push(`${rel}: ${text}`); findings.push({ path: rel, kind: 'symlink', text }); };
        let real = null;
        try { real = realpathSync(abs); } catch { /* dangling */ }
        if (real === null) { flag(escapes(root, abs) ? 'symlink pointing outside the skill folder' : 'broken symlink'); continue; }
        if (real !== root && !real.startsWith(root + sep)) { flag('symlink pointing outside the skill folder'); continue; }
        let st;
        try { st = statSync(real); } catch (err) { unreadable(rel, err); continue; }
        if (!st.isFile()) { flag(st.isDirectory() ? 'symlink to a folder' : 'symlink to something that is not a file'); continue; }
        findings.push({ path: rel, kind: 'symlink', text: 'symlink inside the skill folder (imported as a copy)' });
        add(real, rel, st);
      } else if (e.isDirectory()) {
        if (e.name === '.claude-plugin') {
          const text = 'a skill cannot ship a .claude-plugin folder';
          problems.push(`${rel}/: ${text}`);
          findings.push({ path: `${rel}/`, kind: 'plugin-manifest', text });
          continue;
        }
        visit(abs);
      } else if (e.isFile()) {
        let st;
        try { st = statSync(abs); } catch (err) { unreadable(rel, err); continue; }
        add(abs, rel, st);
      }
    }
  };
  visit(root);
  if (total > SKILL_LIMITS.totalBytes) problems.push('larger than 8 MB in total');
  records.sort(byPath);
  return { records, problems, findings, total };
}

function shellBlocksOf(text) {
  const fenced = text.match(FENCED_SHELL_RE) || [];
  const inline = text.replace(FENCED_SHELL_RE, '').match(INLINE_SHELL_RE) || [];
  return [
    ...fenced.map((b) => clip(b.slice(4, -3).trim().split('\n')[0].trim())),
    ...inline.map((b) => clip(b.slice(2, -1).trim())),
  ];
}

// The first FINDINGS_PER_KIND findings of each kind, then one finding for the rest of that kind, where the first one
// left out was: 60 000 inline shell blocks fit in a 1 MB SKILL.md, and a preview must not grow to megabytes.
// Problems are never cut (the import's limit checks read them).
const FINDINGS_PER_KIND = 50;
function capFindings(findings) {
  const count = Object.create(null);
  const more = Object.create(null);
  const out = [];
  for (const f of findings) {
    const n = (count[f.kind] = (count[f.kind] ?? 0) + 1);
    if (n <= FINDINGS_PER_KIND) out.push(f);
    else if (n === FINDINGS_PER_KIND + 1) out.push((more[f.kind] = { path: f.path, kind: f.kind, text: '' }));
  }
  for (const kind of Object.keys(more)) more[kind].text = `… and ${count[kind] - FINDINGS_PER_KIND} more`;
  return out;
}

function inspect(absDir, opts = {}) {
  const name = opts.name ?? basename(String(absDir));
  const problems = [];
  const nameProblem = skillNameProblem(name);
  if (nameProblem) problems.push(nameProblem);
  let root = null;
  try { root = realpathSync(absDir); if (!statSync(root).isDirectory()) root = null; } catch { root = null; }
  if (!root) {
    problems.push('skill folder not found');
    return {
      records: [],
      result: {
        name, description: '', whenToUse: null,
        frontmatter: { allowedTools: null, hooks: false, shell: false, disableModelInvocation: false, pluginRootRefs: false },
        files: [], bytes: 0, scripts: [], shellBlocks: 0, hash: skillHash([]), problems, findings: [],
      },
    };
  }
  const w = walk(root);
  problems.push(...w.problems);
  const findings = [...w.findings];
  const md = w.records.find((r) => r.path === 'SKILL.md');
  const read = md ? frontmatterOf(md.text) : null;
  const fm = read?.fields ?? null;
  if (!md) problems.push('SKILL.md is missing');
  else if (!fm) problems.push('SKILL.md has no frontmatter (a --- block with name and description)');
  else if (read.unknown) problems.push('SKILL.md frontmatter cannot be read the way Claude Code reads it (over 16 KB, or YAML Worca cannot parse), so its name cannot be checked');
  else if (typeof name === 'string' && fm.name && fm.name !== name) problems.push(`SKILL.md names the skill "${clip(fm.name)}", not "${clip(name)}"`);
  // §2a U1: hooks are not refused, they are shown — they run outside Worca's guardrails once the skill is used.
  if (fm?.hooks) findings.push({ path: 'SKILL.md', kind: 'hooks', text: SKILL_HOOKS_TEXT });
  const blocks = md?.text ? shellBlocksOf(md.text) : [];
  for (const text of blocks) findings.push({ path: 'SKILL.md', kind: 'shell-block', text });
  if (md?.text) {
    const seen = new Set();
    for (const m of md.text.matchAll(EXPANSION_RE)) {
      if (KNOWN_SUBSTITUTIONS.has(m[1]) || seen.has(m[1])) continue;
      seen.add(m[1]);
      findings.push({ path: 'SKILL.md', kind: 'expansion', text: clip(`\${${m[1]}`) });
    }
  }
  let pluginRootRefs = false;
  for (const r of w.records) {
    if (r.mode) findings.push({ path: r.path, kind: 'executable', text: 'executable' });
    if (r.text === null) continue;
    if (hasTokenShape(r.text)) findings.push({ path: r.path, kind: 'token', text: 'text shaped like an API token' });
    if (PLUGIN_ROOT_RE.test(r.text)) {
      pluginRootRefs = true;
      findings.push({ path: r.path, kind: 'plugin-root-ref', text: "uses ${CLAUDE_PLUGIN_ROOT} or ${CLAUDE_PLUGIN_DATA}: references its plugin's other files — may not work from a set" });
    }
  }
  findings.sort((a, b) => byPath(a, b) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  return {
    records: w.records,
    result: {
      name,
      description: fm?.description ?? '',
      whenToUse: fm?.whenToUse ?? null,
      frontmatter: {
        allowedTools: fm?.allowedTools ?? null, hooks: fm?.hooks ?? false, shell: fm?.shell ?? false,
        disableModelInvocation: fm?.disableModelInvocation ?? false, pluginRootRefs,
      },
      files: w.records.map((r) => ({ path: r.path, bytes: r.bytes, executable: r.mode !== 0 })),
      bytes: w.total,
      scripts: w.records.filter((r) => r.path.startsWith('scripts/') || r.mode !== 0 || r.text?.startsWith('#!')).map((r) => r.path),
      shellBlocks: blocks.length,
      hash: skillHash(w.records),
      problems,
      findings: capFindings(findings),
    },
  };
}

/**
 * Inspect one skill folder (the contract of skills registry design §8.1). `name` is the name the skill will have
 * (default: the folder's own name); a SKILL.md frontmatter `name` must equal it.
 * @returns {{ name, description, whenToUse, frontmatter:{ allowedTools, hooks, shell, disableModelInvocation,
 *   pluginRootRefs }, files:Array<{path, bytes, executable}>, bytes, scripts:string[], shellBlocks:number, hash,
 *   problems:string[], findings:Array<{path, kind, text}> }}
 */
export function inspectSkillDir(absDir, opts) { return inspect(absDir, opts).result; }

/** path → `<x>:<sha256>` (x as in skillHash) for every file of a skill folder: the update preview's diff input. */
export function skillFileDigests(absDir) {
  const out = Object.create(null);
  for (const r of inspect(absDir).records) out[r.path] = `${r.mode ? 1 : 0}:${r.sha256}`;
  return out;
}
