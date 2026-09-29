#!/usr/bin/env node
// tools/vendor-opendeck.mjs — bring assets/deck-kit/'s OpenDeck files up to a
// released OpenDeck version, and re-pin them.
//
// assets/deck-kit/ holds two layers. The OpenDeck layer (VENDORED below) is a
// byte-for-byte copy of a release and is never edited here — a fix goes upstream
// and comes back through this script. The pipeline layer (deck-pipeline.js,
// deck-audit.js, CONTRACT.md) is ours and is not touched. UPSTREAM.json records
// the version and a SHA-256 per vendored file; test/deck-upstream-pin.test.mjs
// fails when a file no longer matches.
//
//   node tools/vendor-opendeck.mjs --tag v1.3.0            # fetch from GitHub
//   node tools/vendor-opendeck.mjs --from ~/dev/opendeck   # a local checkout
//   node tools/vendor-opendeck.mjs --tag v1.3.0 --check    # verify only
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const KIT = join(REPO_ROOT, 'assets', 'deck-kit');
export const VENDORED = ['deck-stage.js', 'deck-enhance.js', 'deck-export.js', 'build-standalone.mjs'];
// A SECOND asset set, staged only for runs that ask for narration (the audio step
// declares `requiresAssets: ['deck-narration']`). Kept out of deck-kit/ on
// purpose: everything in deck-kit/ is copied flat into every deck and inlined into
// every export, and the Audio Studio is 68 KB nobody who declined audio wants.
export const NARRATION_KIT = join(REPO_ROOT, 'assets', 'deck-narration');
export const VENDORED_NARRATION = ['deck-narration.js', 'narration-script.js'];
const UPSTREAM_PATH = 'skills/opendeck/assets';
const RAW = 'https://raw.githubusercontent.com/open-deck-org/opendeck';

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function fetchFile({ tag, from }, name) {
  if (from) return readFile(join(from.replace(/^~/, homedir()), UPSTREAM_PATH, name));
  const res = await fetch(`${RAW}/${tag}/${UPSTREAM_PATH}/${name}`);
  if (!res.ok) throw new Error(`${tag}/${name}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function vendor({ tag, from, check = false, kit = KIT, narration = NARRATION_KIT } = {}) {
  if (!tag && !from) throw new Error('pass --tag vX.Y.Z or --from <opendeck checkout>');
  const files = {};
  const narrationFiles = {};
  await mkdir(narration, { recursive: true });
  for (const [names, dir, into] of [[VENDORED, kit, files], [VENDORED_NARRATION, narration, narrationFiles]]) {
    for (const name of names) {
      const buf = await fetchFile({ tag, from }, name);
      into[name] = sha256(buf);
      if (check) {
        const local = await readFile(join(dir, name));
        if (!local.equals(buf)) throw new Error(`${name} differs from upstream ${tag || from}`);
      } else {
        await writeFile(join(dir, name), buf);
      }
    }
  }
  const version = tag ? tag.replace(/^v/, '') : (await fetchFile({ from }, '../../../.claude-plugin/plugin.json').then((b) => JSON.parse(b).version));
  if (!check) {
    await writeFile(join(kit, 'UPSTREAM.json'), JSON.stringify({ source: 'https://github.com/open-deck-org/opendeck', version, path: UPSTREAM_PATH, files, narration: narrationFiles }, null, 2) + '\n');
    await writeFile(join(kit, 'VERSION'), version + '\n');
  }
  return { version, files, narration: narrationFiles };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const out = await vendor({ tag: arg('--tag'), from: arg('--from'), check: process.argv.includes('--check') });
  console.log(`${process.argv.includes('--check') ? 'verified' : 'vendored'} OpenDeck ${out.version}`);
  console.log('run `npm run deck:sync` to refresh docs/why-worca/');
}
