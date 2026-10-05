// test/wsmap-ids.test.mjs — workspace-map stable ids (wsmap P1).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hash64, entryId, edgeId, manualEdgeId } from '../src/shared/workspace-map/ids.mjs';

test('hash64 is FNV-1a 64 over UTF-8: published vectors and multi-byte input', () => {
  assert.equal(hash64(''), 'cbf29ce484222325');
  assert.equal(hash64('a'), 'af63dc4c8601ec8c');
  assert.equal(hash64('foobar'), '85944171f73967e8');
  assert.equal(hash64('é'), '0ac21707b7181e01', 'two UTF-8 bytes, not one UTF-16 unit');
  assert.equal(hash64('日本'), '121d7e35a6d3ce91');
  assert.match(hash64('x'.repeat(5000)), /^[0-9a-f]{16}$/);
});

test('entryId / edgeId / manualEdgeId: prefix + truncated hash of the pipe-joined parts', () => {
  assert.equal(entryId('billing-api', 'http', 'http:GET /invoices/{}'), 'e_1759e37440');
  assert.equal(edgeId('web', 'billing-api', 'http', 'http:GET /invoices/{}'), 'x_81ad6dd3b863');
  assert.equal(manualEdgeId('web', 'billing-api', 'http', 'GET /x', '2026-09-25T10:00:00.000Z'), 'm_ab24bf3e5b9e');
  assert.notEqual(edgeId('web', 'billing-api', 'http', 'http:GET /invoices/{}'), edgeId('billing-api', 'web', 'http', 'http:GET /invoices/{}'),
    'direction is part of the id');
});
