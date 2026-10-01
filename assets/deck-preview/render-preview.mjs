#!/usr/bin/env node
// assets/deck-preview/render-preview.mjs — the visual-system preview for the approve-system form.
//
//   node <pipelineDir>/deck-preview/render-preview.mjs --spec <pipelineDir>/preview/system.json \
//        [--out <pipelineDir>/preview] [--rel-base <pipelineDir>] [--ask <questions file>] [--no-chrome]
//
// Reads the spec, writes system-sheet / compositions / samples as .html and, when a Chrome is
// found, .png into --out; writes the approve-system form data to <out>/approve-system.data.json
// and, with --ask, the whole {"form":"approve-system","data":…} payload to that file.
// PNG paths in the data are relative to --rel-base (default: the parent of --out, i.e. the
// pipeline dir), which is where the host resolves ask files.
// Exit 0 on success even without Chrome (the form then shows its tables only); exit 2 on a bad
// spec or bad arguments, with one problem per stderr line. Zero npm dependencies; Node 18+.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { checkSpec, formData, IMAGE_FIELDS, previewPages } from './preview-html.mjs';
import { findChrome, screenshot } from './chrome.mjs';

function parseArgs(argv) {
  const out = { chrome: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--no-chrome') out.chrome = false;
    else if (['--spec', '--out', '--rel-base', '--ask'].includes(a) && argv[i + 1]) { out[a.slice(2)] = argv[i + 1]; i += 1; }
    else throw new Error(`unknown or incomplete argument: ${a}`);
  }
  if (!out.spec) throw new Error('--spec <system.json> is required');
  return out;
}

function fail(lines) {
  for (const l of lines) process.stderr.write(`render-preview: ${l}\n`);
  process.exit(2);
}

let args;
try { args = parseArgs(process.argv.slice(2)); } catch (e) { fail([e.message]); }
const specPath = resolve(args.spec);
const outDir = resolve(args.out || dirname(specPath));
const relBase = resolve(args['rel-base'] || dirname(outDir));
let spec;
try { spec = JSON.parse(readFileSync(specPath, 'utf8')); } catch (e) { fail([`cannot read ${specPath}: ${e.message}`]); }
const checked = checkSpec(spec);
if (!checked.ok) fail(checked.errors);

const toRel = (abs) => {
  const rel = relative(relBase, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) fail([`${abs} is not inside --rel-base ${relBase}`]);
  return rel.split(sep).join('/');
};

mkdirSync(outDir, { recursive: true });
const chrome = args.chrome ? findChrome() : null;
const images = {};
const problems = [];
for (const p of previewPages(spec)) {
  const htmlPath = join(outDir, `${p.name}.html`);
  const pngPath = join(outDir, `${p.name}.png`);
  writeFileSync(htmlPath, p.html);
  if (!chrome) continue;
  const shot = screenshot(chrome, { htmlPath, pngPath, width: p.width, height: p.height });
  if (shot.ok) images[IMAGE_FIELDS[p.name]] = toRel(pngPath);
  else problems.push(`${p.name}: ${shot.reason}`);
}
const any = Object.keys(images).length > 0;
const data = formData(spec, { images: any ? images : null, chrome: Boolean(chrome) });
const dataPath = join(outDir, 'approve-system.data.json');
writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`);
if (args.ask) writeFileSync(resolve(args.ask), `${JSON.stringify({ form: 'approve-system', data })}\n`);
process.stdout.write(`${JSON.stringify({ ok: true, chrome, images: Object.values(images), problems, data: dataPath, ask: args.ask ? resolve(args.ask) : null })}\n`);
