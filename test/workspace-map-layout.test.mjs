// test/workspace-map-layout.test.mjs — the Map tab's pure layout (spec D17, index P6):
// pairsOf folds effective edges into drawn pairs (rejected and missing never drawn), layoutMap
// puts providers left of consumers and keeps cycles in one layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutMap, pairsOf, MAP_LAYOUT } from '../src/shared/workspace-map/layout.mjs';
import { edgeId, manualEdgeId } from '../src/shared/workspace-map/ids.mjs';
import { checkRows } from './helpers/rows.mjs';

const AT = '2026-09-25T11:00:00.000Z';
const M = (key, level = 'rich') => ({ key, name: key.toUpperCase(), coverage: { level } });
// Real ids (x_ / m_ + 12 hex), like the GET /map payload. MAN = P1 v2's synthetic manual edge (confidence null).
const E = (from, to, kind, extra = {}) => ({ id: edgeId(from, to, kind, `${kind}:${to}`), from, to, kind, display: `${kind} ${to}`, confidence: 'exact', state: 'auto', ...extra });
const MAN = (from, to, kind, extra = {}) => E(from, to, kind, { id: manualEdgeId(from, to, kind, `${kind} ${to}`, AT), norm: null, confidence: null, sources: ['manual'], state: 'manual', ...extra });

test('pairsOf: one pair per (from, to); rejected/missing never drawn; confirmed wins; unknown kinds -> other; garbage skipped', async () => {
  await checkRows([
    { name: 'pairsOf: one pair per (from, to); rejected and missing edges are never drawn; a manual edge has no confidence', run: () => {
      const pairs = pairsOf([
        E('web', 'api', 'http'),
        E('web', 'api', 'http', { id: edgeId('web', 'api', 'http', 'http:GET /b'), display: 'GET /b', confidence: 'heuristic' }),
        E('web', 'api', 'topic', { confidence: 'verified' }),
        E('web', 'lib', 'pkg', { state: 'rejected' }),
        E('api', 'lib', 'pkg', { state: 'missing', confidence: 'verified' }),
        MAN('api', 'lib', 'db', { confidence: 'verified' }),   // P1 v1 stamped manual edges 'verified': still no confidence
      ]);
      assert.deepEqual(pairs, [
        { from: 'api', to: 'lib', kinds: ['db'], confidence: null, count: 1, state: 'manual' },
        { from: 'web', to: 'api', kinds: ['http', 'topic'], confidence: 'exact', count: 3, state: 'auto' },
      ]);
    } },
    { name: 'pairsOf: a confirmed edge makes the pair confirmed; unknown kinds count as other; garbage is skipped', run: () => {
      const pairs = pairsOf([E('a', 'b', 'grpc', { state: 'confirmed', confidence: 'inferred' }), E('a', 'b', 'weird'), E('a', 'b', 'weird', { id: edgeId('a', 'b', 'weird', 'weird:b2') }), null, 7, { from: 'a' }, E('a', 'a', 'http')]);
      assert.deepEqual(pairs, [{ from: 'a', to: 'b', kinds: ['other', 'grpc'], confidence: 'exact', count: 3, state: 'confirmed' }]);
      assert.deepEqual(pairsOf(null), []);
    } },
  ]);
});

test('layoutMap: providers sit left of their consumers; nodes carry coverage level and layer', () => {
  const members = [M('web'), M('api', 'partial'), M('lib', 'none'), M('solo')];
  const pairs = pairsOf([E('web', 'api', 'http'), E('api', 'lib', 'pkg'), E('web', 'lib', 'pkg')]);
  const out = layoutMap({ members, pairs, order: null });
  const at = Object.fromEntries(out.nodes.map((n) => [n.key, n]));
  for (const p of pairs) assert.ok(at[p.to].x + at[p.to].w <= at[p.from].x, `${p.to} left of ${p.from}`);
  assert.equal(at.lib.layer, 0); assert.equal(at.api.layer, 1); assert.equal(at.web.layer, 2);
  assert.equal(at.api.level, 'partial'); assert.equal(at.lib.level, 'none');
  assert.equal(out.edges.length, 3);
  const e = out.edges.find((x) => x.from === 'web' && x.to === 'api');
  assert.match(e.d, /^M[\d.]+ [\d.]+ C/);
  const nums = e.d.match(/-?[\d.]+/g).map(Number);
  assert.equal(nums[0], at.web.x, 'the path leaves the consumer on its left side');
  assert.equal(nums[nums.length - 2], at.api.x + at.api.w, 'and ends on the provider\'s right side');
  assert.ok(out.width >= at.web.x + MAP_LAYOUT.NODE_W + MAP_LAYOUT.PAD);
  assert.ok(out.height >= MAP_LAYOUT.NODE_H + 2 * MAP_LAYOUT.PAD);
});

test('layoutMap: a cycle shares one layer and its loop stays on the right of the column', () => {
  const out = layoutMap({ members: [M('a'), M('b'), M('c')], pairs: pairsOf([E('a', 'b', 'http'), E('b', 'a', 'http'), E('c', 'a', 'pkg')]), order: null });
  const at = Object.fromEntries(out.nodes.map((n) => [n.key, n]));
  assert.equal(at.a.layer, at.b.layer, 'a and b share a layer');
  assert.equal(at.a.x, at.b.x, 'one column');
  assert.ok(at.a.x + at.a.w <= at.c.x, 'the consumer c is to the right');
  const loop = out.edges.find((e) => e.from === 'a' && e.to === 'b');
  assert.ok(loop.d.startsWith(`M${at.a.x + at.a.w} `), 'a loop leaves from the right side');
  assert.ok(out.width >= at.c.x + at.c.w + MAP_LAYOUT.PAD + MAP_LAYOUT.LOOP_PAD, 'room for the bulge');
});

test('layoutMap: the map order is used when consistent, recomputed when a manual edge or a stale layer breaks it', async () => {
  const members = [M('a'), M('b'), M('solo')];
  await checkRows([
    { name: 'layoutMap: the map order is used when it fits the drawn pairs, recomputed when a manual edge breaks it', run: () => {
      const pairs = pairsOf([E('a', 'b', 'http')]);
      const kept = layoutMap({ members, pairs, order: [['b'], ['a'], ['solo']] });
      assert.equal(kept.nodes.find((n) => n.key === 'solo').layer, 2, 'a consistent order is kept as given');
      const flipped = pairsOf([E('a', 'b', 'http'), MAN('b', 'solo', 'pkg')]);
      const re = layoutMap({ members, pairs: flipped, order: [['b'], ['a'], ['solo']] });
      const at = Object.fromEntries(re.nodes.map((n) => [n.key, n]));
      for (const p of flipped) assert.ok(at[p.to].x + at[p.to].w <= at[p.from].x, `${p.to} left of ${p.from}`);
      const partial = layoutMap({ members, pairs, order: [['b']] });
      assert.equal(partial.nodes.length, 3, 'an order missing members is not used');
    } },
    { name: 'layoutMap: a stale order that puts a consumer and its provider in one layer (no cycle) is recomputed', run: () => {
      const pairs = pairsOf([E('a', 'b', 'http'), MAN('solo', 'b', 'other')]);
      const out = layoutMap({ members, pairs, order: [['b', 'solo'], ['a']] });
      const at = Object.fromEntries(out.nodes.map((n) => [n.key, n]));
      for (const p of pairs) assert.ok(at[p.to].x + at[p.to].w <= at[p.from].x, `${p.to} left of ${p.from}`);
    } },
  ]);
});

test('layoutMap: total on garbage — no members, unknown pair ends, duplicate keys', () => {
  assert.deepEqual(layoutMap({}), { width: 2 * MAP_LAYOUT.PAD, height: 2 * MAP_LAYOUT.PAD + MAP_LAYOUT.NODE_H, nodes: [], edges: [] });
  const out = layoutMap({ members: [M('a'), M('a'), { name: 'x' }, null], pairs: [{ from: 'a', to: 'ghost', kinds: ['http'] }], order: 'nope' });
  assert.equal(out.nodes.length, 1);
  assert.equal(out.edges.length, 0);
});
