import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClaude, MOCK_WRITER_ROLES } from '../src/core/claude-runner.mjs';

const run = (prompt, cwd) => runClaude({ prompt, cwd, mock: true, onEvent() {} });

test('deck-builder mock writes the manifest and the deck folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'worca-mock-deck-'));
  try {
    const out = join(dir, 'deck-manifest.md');
    await run(`MOCK_ROLE: deck-builder\nMOCK_CYCLE: 1\nMOCK_OUT: ${out}`, dir);
    assert.match(await readFile(out, 'utf8'), /^# Deck manifest/);
    const deck = (await readdir(join(dir, 'deck'))).sort();
    assert.deepEqual(deck, ['deck-audit.js', 'deck-enhance.js', 'deck-export.js', 'deck-stage.js', 'deck.html', 'proof.html']);
    assert.match(await readFile(join(dir, 'deck', 'deck.html'), 'utf8'), /<deck-stage width="1920" height="1080">/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('deck-export mock writes the two single-file deliverables and a clean verdict', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'worca-mock-export-'));
  try {
    // deck.html must exist first: the export step derives the standalone from it.
    await run(`MOCK_ROLE: deck-builder\nMOCK_CYCLE: 1\nMOCK_OUT: ${join(dir, 'deck-manifest.md')}`, dir);
    const md = join(dir, 'deck-export-cycle1.md'), json = join(dir, 'deck-export-cycle1.json');
    await run(`MOCK_ROLE: deck-export\nMOCK_CYCLE: 1\nMOCK_OUT: ${md}\nMOCK_JSON: ${json}`, dir);

    // deck.html needs its companions beside it and cannot be sent to anyone, so a
    // run that produces only it has produced nothing openable. A run once finished
    // "clean" having produced neither of these.
    assert.match(await readFile(join(dir, 'deck', 'deck.pdf'), 'latin1'), /^%PDF-/);
    const standalone = await readFile(join(dir, 'deck', 'deck.standalone.html'), 'utf8');
    assert.doesNotMatch(standalone, /<script src="[^"]+\.js"><\/script>/, 'standalone still loads a companion script');
    assert.deepEqual(JSON.parse(await readFile(json, 'utf8')).issues, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('deck-audit mock: cycle 1 blocks with one major, cycle 2 is clean; shots exist either way', async () => {
  for (const cycle of [1, 2]) {
    const dir = await mkdtemp(join(tmpdir(), 'worca-mock-audit-'));
    try {
      const md = join(dir, `deck-audit-cycle${cycle}.md`), json = join(dir, `deck-audit-cycle${cycle}.json`);
      await run(`MOCK_ROLE: deck-audit\nMOCK_CYCLE: ${cycle}\nMOCK_OUT: ${md}\nMOCK_JSON: ${json}`, dir);
      const v = JSON.parse(await readFile(json, 'utf8'));
      assert.equal(v.issues.some((i) => i.severity === 'major'), cycle === 1);
      const shots = (await readdir(join(dir, 'shots'))).sort();
      assert.deepEqual(shots, ['s01.png', 's02.png', 's03.png']);
      const png = await readFile(join(dir, 'shots', 's01.png'));
      assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('the two deck roles are in MOCK_WRITER_ROLES', () => {
  assert.ok(MOCK_WRITER_ROLES.has('deck-builder') && MOCK_WRITER_ROLES.has('deck-audit'));
});

// A graph wiring neither the verdict nor the report port allocates neither
// MOCK_JSON nor MOCK_OUT, and `dirname(undefined)` is a TypeError out of
// node:path — a crashed mock step rather than a diagnosable message. The
// deck-builder mock already degrades; these two now match it.
test('the deck verifier mocks degrade when no output path was allocated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'worca-mock-deck-bare-'));
  try {
    for (const role of ['deck-audit', 'deck-export']) {
      const out = await run(`MOCK_ROLE: ${role}\nMOCK_CYCLE: 1`, dir);
      assert.match(out.text, /no MOCK_JSON or MOCK_OUT given/, role);
      assert.equal(out.exitCode, 0, `${role} degrades rather than failing the step`);
    }
    assert.deepEqual(await readdir(dir), [], 'and nothing was written');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
