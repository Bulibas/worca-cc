// test/ui-control-skins.test.mjs — the browser's own controls, skinned.
//
// window.confirm / window.prompt have no call sites left — every dialog goes
// through confirmModal() / promptModal().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const appjs = read('../ui/public/app.js');

test('no window.confirm / window.prompt call sites remain', () => {
  // Comments may still mention them; a CALL is what must be gone.
  const calls = appjs.match(/window\.(confirm|prompt)\s*\(/g) || [];
  assert.deepEqual(calls, [], `still calling ${calls.join(', ')}`);
});
