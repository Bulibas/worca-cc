// test/ui-graph-imports.test.mjs — the layering guard: the browser modules under
// ui/public/graph reach the shared core only, never src/core (server code must not
// ship to the browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = fileURLToPath(new URL('../ui/public/graph/', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.mjs'));

test('the browser modules never import from src/core (no cross-layer leak)', () => {
  for (const f of files) {
    const src = readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/src\/core\//.test(src), `${f} must not import from src/core`);
  }
});
