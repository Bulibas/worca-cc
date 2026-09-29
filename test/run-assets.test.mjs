// test/run-assets.test.mjs
// Agents declare `requiresAssets`; the engine stages those folders into the RUN
// FOLDER before the first node runs. This exists because the deck kit had no
// staging at all — the builder prompt said "cp from the project checkout" while
// the kit ships inside worca, so a run whose project was an unrelated repo only
// found it by globbing the filesystem under permissive guardrails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isValidAssetName, collectRequiredAssets, stageAssets } from '../src/core/run-assets.mjs';

test('isValidAssetName rejects the path-segment escapes', () => {
  for (const ok of ['deck-kit', 'a', 'A.b_c-1']) assert.equal(isValidAssetName(ok), true, ok);
  for (const bad of ['..', '.', '../x', 'a/b', 'a\\b', '', null, 42, 'a b']) {
    assert.equal(isValidAssetName(bad), false, String(bad));
  }
});

test('collectRequiredAssets unions across agents, sorted and deduped', () => {
  const registry = {
    a: { requiresAssets: ['deck-kit'] },
    b: { requiresAssets: ['deck-kit', 'brand'] },
    c: {},                                   // no field at all
    d: { requiresAssets: [] },
  };
  assert.deepEqual(collectRequiredAssets(registry, ['a', 'b', 'c', 'd']), ['brand', 'deck-kit']);
  assert.deepEqual(collectRequiredAssets(registry, []), []);
  assert.deepEqual(collectRequiredAssets(undefined, ['a']), []);
});

test('stageAssets copies the folder tree into the run folder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worca-assets-root-'));
  const target = await mkdtemp(join(tmpdir(), 'worca-assets-target-'));
  try {
    await mkdir(join(root, 'assets', 'deck-kit', 'nested'), { recursive: true });
    await writeFile(join(root, 'assets', 'deck-kit', 'build-standalone.mjs'), 'export const v = 1;\n');
    await writeFile(join(root, 'assets', 'deck-kit', 'nested', 'x.txt'), 'deep\n');

    assert.deepEqual(await stageAssets(['deck-kit'], { root, target }), ['deck-kit']);
    assert.deepEqual((await readdir(join(target, 'deck-kit'))).sort(), ['build-standalone.mjs', 'nested']);
    assert.equal(await readFile(join(target, 'deck-kit', 'nested', 'x.txt'), 'utf8'), 'deep\n');
  } finally { await rm(root, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }); }
});

test('staging overwrites an agent edit from a previous cycle — the shipped asset is canonical', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worca-assets-root-'));
  const target = await mkdtemp(join(tmpdir(), 'worca-assets-target-'));
  try {
    await mkdir(join(root, 'assets', 'kit'), { recursive: true });
    await writeFile(join(root, 'assets', 'kit', 'f.js'), 'canonical\n');
    await mkdir(join(target, 'kit'), { recursive: true });
    await writeFile(join(target, 'kit', 'f.js'), 'an agent scribbled here\n');

    await stageAssets(['kit'], { root, target });
    assert.equal(await readFile(join(target, 'kit', 'f.js'), 'utf8'), 'canonical\n');
  } finally { await rm(root, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }); }
});

test('stageAssets throws rather than staging a partial set', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worca-assets-root-'));
  const target = await mkdtemp(join(tmpdir(), 'worca-assets-target-'));
  try {
    await mkdir(join(root, 'assets', 'real'), { recursive: true });
    await writeFile(join(root, 'assets', 'real', 'f'), 'x');
    await assert.rejects(() => stageAssets(['real', 'missing'], { root, target }), /not found/);
    await assert.rejects(() => stageAssets(['../escape'], { root, target }), /not a valid asset name/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }); }
});

test('the shipped deck agents declare the kit, so a run can never depend on finding it', async () => {
  const reg = JSON.parse(await readFile(new URL('../agents/deckBuilder.meta.json', import.meta.url), 'utf8'));
  // deck-narration is staged (never copied into a deck) so the optional deckAudio card finds the
  // Audio Studio engine; only a run that asks for audio ever uses it.
  assert.deepEqual(reg.requiresAssets, ['deck-kit', 'deck-narration']);
  for (const key of ['deckAudit', 'deckExport']) {
    const m = JSON.parse(await readFile(new URL(`../agents/${key}.meta.json`, import.meta.url), 'utf8'));
    assert.deepEqual(m.requiresAssets, ['deck-kit'], `${key} must declare the kit`);
  }
});

// Plugin layers contribute agents to the registry (agent-registry pluginAgentLayers)
// and normalizeAgentMeta validates only the NAME of a requiresAssets entry — so a
// plugin-shipped agent declaring one threw "asset not found at <worca>/assets/<name>"
// and failed the whole run at setup, with no way for the plugin to satisfy it.
// Skills already get a plugin layer (pluginSkillDirs); assets now do too.
test('stageAssets resolves an asset from a plugin layer when worca has none', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worca-assets-root-'));
  const plug = await mkdtemp(join(tmpdir(), 'worca-assets-plug-'));
  const target = await mkdtemp(join(tmpdir(), 'worca-assets-target-'));
  try {
    await mkdir(join(root, 'assets'), { recursive: true });                 // worca ships nothing
    await mkdir(join(plug, 'assets', 'brand-kit'), { recursive: true });
    await writeFile(join(plug, 'assets', 'brand-kit', 'palette.json'), '{"accent":"#f50"}', 'utf8');

    const staged = await stageAssets(['brand-kit'], {
      root, target, pluginDirs: [{ plugin: 'acme', dir: join(plug, 'assets') }],
    });

    assert.deepEqual(staged, ['brand-kit']);
    assert.equal(JSON.parse(await readFile(join(target, 'brand-kit', 'palette.json'), 'utf8')).accent, '#f50');
  } finally {
    for (const d of [root, plug, target]) await rm(d, { recursive: true, force: true });
  }
});

test("worca's own asset wins over a plugin of the same name", async () => {
  const root = await mkdtemp(join(tmpdir(), 'worca-assets-root2-'));
  const plug = await mkdtemp(join(tmpdir(), 'worca-assets-plug2-'));
  const target = await mkdtemp(join(tmpdir(), 'worca-assets-target2-'));
  try {
    await mkdir(join(root, 'assets', 'deck-kit'), { recursive: true });
    await writeFile(join(root, 'assets', 'deck-kit', 'VERSION'), 'shipped', 'utf8');
    await mkdir(join(plug, 'assets', 'deck-kit'), { recursive: true });
    await writeFile(join(plug, 'assets', 'deck-kit', 'VERSION'), 'hijacked', 'utf8');

    await stageAssets(['deck-kit'], { root, target, pluginDirs: [{ plugin: 'acme', dir: join(plug, 'assets') }] });

    assert.equal((await readFile(join(target, 'deck-kit', 'VERSION'), 'utf8')).trim(), 'shipped',
      'a plugin cannot shadow a kit worca ships');
  } finally {
    for (const d of [root, plug, target]) await rm(d, { recursive: true, force: true });
  }
});

test('a genuinely missing asset still names every place it was looked for', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worca-assets-root3-'));
  const target = await mkdtemp(join(tmpdir(), 'worca-assets-target3-'));
  try {
    await mkdir(join(root, 'assets'), { recursive: true });
    await assert.rejects(
      () => stageAssets(['nope'], { root, target, pluginDirs: [{ plugin: 'acme', dir: '/does/not/exist' }] }),
      (e) => /not found/.test(e.message) && e.message.includes('assets/nope'),
    );
  } finally {
    for (const d of [root, target]) await rm(d, { recursive: true, force: true });
  }
});
