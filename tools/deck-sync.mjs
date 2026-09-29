#!/usr/bin/env node
// scripts/deck-sync.mjs — refresh docs/why-worca/'s flat kit copies from the
// canonical assets/deck-kit/. deck-export.js fetches its siblings by relative
// path, so the deck folder must keep flat copies; test/deck-kit-sync.test.mjs
// fails CI when they drift.
import { copyFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KIT = join(REPO_ROOT, 'assets', 'deck-kit');
const TARGETS = [join(REPO_ROOT, 'docs', 'why-worca')];
export const SYNCED_FILES = ['deck-stage.js', 'deck-enhance.js', 'deck-export.js'];
const NARRATION = join(REPO_ROOT, 'assets', 'deck-narration');
// narration-script.js is the deck's OWN content (docs/why-worca carries its own), so only the engine is synced.
export const SYNCED_NARRATION = ['deck-narration.js'];

export async function syncDeckKit({ kit = KIT, targets = TARGETS } = {}) {
  const copied = [];
  for (const dir of targets) {
    for (const f of SYNCED_FILES) {
      await copyFile(join(kit, f), join(dir, f));
      copied.push(join(dir, f));
    }
  }
  // docs/why-worca is a narrated deck, so it needs the narration files too.
  for (const dir of targets) {
    for (const f of SYNCED_NARRATION) {
      await copyFile(join(NARRATION, f), join(dir, f));
      copied.push(join(dir, f));
    }
  }
  return copied;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const copied = await syncDeckKit();
  for (const p of copied) console.log(`synced ${p}`);
}
