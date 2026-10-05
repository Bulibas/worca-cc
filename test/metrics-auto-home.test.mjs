// test/metrics-auto-home.test.mjs
// autoMetricsHome: the create wizard no longer asks for a metrics home; POST /api/workspaces
// adopts the ONE member that already records, and leaves it unset in every other case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoMetricsHome } from '../src/core/metrics/sync.mjs';
import { checkRows } from './helpers/rows.mjs';

const m = (path, o = {}) => ({ path, hasOrigin: true, recordsLocally: true, error: null, ...o });
const scanOf = (members) => async () => ({ members });

test('autoMetricsHome: exactly one recording member, else null (none, several, no origin, discovery error, throwing scan)', async () => {
  await checkRows([
    { name: 'exactly one recording member → that member', run: async () => {
      assert.equal(await autoMetricsHome(['/a', '/b'], { scan: scanOf([m('/a'), m('/b', { recordsLocally: false })]) }), '/a');
    } },
    { name: 'none or several recording members → null (the card\'s Choose… decides)', run: async () => {
      assert.equal(await autoMetricsHome(['/a', '/b'], { scan: scanOf([m('/a', { recordsLocally: false }), m('/b', { recordsLocally: false })]) }), null);
      assert.equal(await autoMetricsHome(['/a', '/b'], { scan: scanOf([m('/a'), m('/b')]) }), null);
    } },
    { name: 'a member without origin, with a discovery error, or a scan that throws never yields a home', run: async () => {
      assert.equal(await autoMetricsHome(['/a'], { scan: scanOf([m('/a', { hasOrigin: false })]) }), null);
      assert.equal(await autoMetricsHome(['/a'], { scan: scanOf([m('/a', { error: 'could not read this repository' })]) }), null);
      assert.equal(await autoMetricsHome(['/a', '/nogit'], { scan: async () => { throw Object.assign(new Error('member is not a git repository'), { code: 'BAD_REQUEST' }); } }), null);
    } },
  ]);
});
