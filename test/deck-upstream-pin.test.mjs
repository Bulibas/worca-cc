// test/deck-upstream-pin.test.mjs
// The OpenDeck files under assets/deck-kit/ are a byte-for-byte vendored release,
// never edited here (a fix goes upstream and returns via `npm run deck:vendor`).
// UPSTREAM.json pins each one; this fails the moment a local edit or a partial
// upgrade makes a file disagree with its pin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { VENDORED, VENDORED_NARRATION } from '../tools/vendor-opendeck.mjs';
import { checkRows } from './helpers/rows.mjs';

const KIT = join(fileURLToPath(new URL('..', import.meta.url)), 'assets', 'deck-kit');
const pin = JSON.parse(readFileSync(join(KIT, 'UPSTREAM.json'), 'utf8'));
const NARRATION = join(KIT, '..', 'deck-narration');
const sha = (f, dir = KIT) => createHash('sha256').update(readFileSync(join(dir, f))).digest('hex');

test('vendored OpenDeck kit and narration files match their UPSTREAM.json pins and VERSION', async () => {
  await checkRows([
    { name: 'every vendored OpenDeck file matches its UPSTREAM.json pin', run: () => {
      assert.deepEqual(Object.keys(pin.files).sort(), [...VENDORED].sort());
      for (const f of VENDORED) {
        assert.equal(sha(f), pin.files[f], `${f} was edited locally — fix it upstream, then \`npm run deck:vendor -- --tag v<version>\``);
      }
    } },
    // The Audio Studio engine is a SECOND vendored set, staged only for the audio step. It must stay
    // out of deck-kit/ (which is copied flat into every deck and inlined into every export).
    { name: 'the narration set is pinned too, and kept out of the kit folder every deck copies', run: () => {
      assert.deepEqual(Object.keys(pin.narration).sort(), [...VENDORED_NARRATION].sort());
      for (const f of VENDORED_NARRATION) {
        assert.equal(sha(f, NARRATION), pin.narration[f], `${f} was edited locally — fix it upstream, then \`npm run deck:vendor\``);
        assert.ok(!existsSync(join(KIT, f)), `${f} must not sit in deck-kit/ — every deck would inline it`);
      }
    } },
    { name: 'the kit VERSION is the pinned OpenDeck release', run: () => {
      assert.equal(readFileSync(join(KIT, 'VERSION'), 'utf8').trim(), pin.version);
      assert.match(readFileSync(join(KIT, 'CONTRACT.md'), 'utf8'), new RegExp(`Kit version: \\*\\*${pin.version.replace(/\./g, '\\.')}\\*\\*`));
    } },
  ]);
});
