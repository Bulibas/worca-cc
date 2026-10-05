// test/mcp-store.test.mjs — MCP registry storage discipline (design §4.2, §4.5): implicit General, reads that
// never write, schema > 1 refused, orphan sweep before any allocation, the lock (never nested, FIFO, busy), 0600.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, statSync, chmodSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { freshHomes, plain, file, put, disk } from './helpers/mcp-store-fixtures.mjs';
import { checkRows } from './helpers/rows.mjs';
import { readMcpStore, withMcpLock, createSet, mcpDir, McpStoreError } from '../src/core/mcp/store.mjs';

freshHomes(after);
// freshHomes gives each test its own home; each row of a merged test takes its own too,
// under the same root (useTempHome removes it), so no row reads an earlier row's files.
const rowHome = () => { process.env.WORCA_HOME = mkdtempSync(join(dirname(process.env.WORCA_HOME), 'h-')); };

test('a fresh home reads an implicit General and writes nothing', async () => {
  const s = await readMcpStore();
  assert.deepEqual(plain(s), {
    newer: false, bases: {}, manual: {}, policy: {}, sets: { general: { name: 'General', members: [] } },
    retired: [], teams: {}, projects: {}, secrets: {}, tests: {},
  });
  assert.equal(Object.getPrototypeOf(s.sets), null);
  assert.equal(existsSync(mcpDir()), false);
});

test('createSet: id, slug and name persisted; an empty General is never written; name rules', async () => {
  assert.deepEqual(await createSet(' Billing '), { id: 'billing', name: 'Billing', slug: 'billing' });
  assert.deepEqual(disk('sets'), { schema: 1, sets: { billing: { name: 'Billing', slug: 'billing', members: [] } }, retired: [], teams: {}, projects: {} });
  const refused = [['', 400], ['x'.repeat(41), 400], ['Team · mine', 400], ['team · mine', 400], ['billing', 409], ['GENERAL', 409]];
  for (const [name, status] of refused) {
    await assert.rejects(createSet(name), (e) => e instanceof McpStoreError && e.status === status, name);
  }
});

test('0600 on all four files', { skip: process.platform === 'win32' }, async () => {
  await withMcpLock(async (tx) => { for (const n of ['servers', 'sets', 'secrets', 'tests']) await tx.write(n); });
  for (const n of ['servers', 'sets', 'secrets', 'tests']) assert.equal(statSync(file(n)).mode & 0o777, 0o600, n);
});

test('schema: > 1 (number or text) reads nothing and writes nothing; a schema that is not a number or text never makes a read throw', async () => {
  await checkRows([
    { name: 'a file with schema > 1: nothing is read, nothing is written', run: async () => {
      rowHome();
      put('sets', { sets: { billing: { name: 'Billing', slug: 'billing', members: [] } } });
      put('tests', { schema: 2, tests: {} });
      const s = await readMcpStore();
      assert.equal(s.newer, true);
      assert.deepEqual(plain(s.sets), { general: { name: 'General', members: [] } });
      await assert.rejects(createSet('Shop'), { status: 409, message: 'MCP registry files need a newer Worca' });
      assert.deepEqual(Object.keys(disk('sets').sets), ['billing']);
      put('sets', { schema: 2, sets: [] }); // a newer file's own shape is not damage
      await assert.rejects(createSet('Shop'), { status: 409, message: 'MCP registry files need a newer Worca' });
    } },
    { name: 'a schema that is not a number or text never makes a read throw', run: async () => {
      rowHome();
      for (const schema of [{}, [{}], { valueOf: 1 }]) {
        put('tests', { schema, tests: {} });
        assert.equal((await readMcpStore()).newer, false, JSON.stringify(schema));
      }
      put('tests', { schema: '2', tests: {} });
      assert.equal((await readMcpStore()).newer, true);
    } },
  ]);
});

test('orphans are ignored on read and swept by the next locked write, before it allocates; Team secrets stay with their state', async () => {
  const TEAM = 'team-acme-platform-9333';
  const GH = 'policy:acme/platform/github';
  put('sets', { sets: {}, teams: { 'acme/platform': { id: TEAM, slug: 'team-platfor', name: 'Team · acme/platform',
    members: { [GH]: { enabled: true, values: {}, seeded: {}, consent: 'h' } } } } });
  put('secrets', { sets: {
    billing: { 'manual:pg': { password: { value: 'old-secret', updatedAt: 't' } } },
    // gone: a Forget or uninstall interrupted after its sets.json write — its token must never come back
    [TEAM]: { [GH]: { token: { value: 'tok', updatedAt: 't' } }, 'policy:acme/platform/gone': { token: { value: 'old', updatedAt: 't' } } },
  } });
  put('tests', { tests: { 'general|manual:pg': { ok: true }, [`${TEAM}|policy:acme/platform/gone`]: { ok: true }, [`${TEAM}|${GH}`]: { ok: true } } });
  const s = await readMcpStore();
  assert.deepEqual(Object.keys(s.secrets), [TEAM]);
  assert.deepEqual(Object.keys(s.secrets[TEAM]), [GH]);
  assert.deepEqual(Object.keys(s.tests), [`${TEAM}|${GH}`]);
  assert.ok(disk('secrets').sets.billing, 'a read never writes');
  await createSet('Billing');
  await withMcpLock(async (tx) => { tx.snapshot.sets.billing.members.push({ server: 'manual:pg', enabled: true, values: {} }); await tx.write('sets'); });
  const after = await readMcpStore();
  assert.equal(after.secrets.billing, undefined, 'the new set never inherits the orphan secret');
  assert.deepEqual(Object.keys(disk('secrets').sets), [TEAM]);
  assert.deepEqual(Object.keys(disk('secrets').sets[TEAM]), [GH]);
  assert.deepEqual(Object.keys(disk('tests').tests), [`${TEAM}|${GH}`]);
});

test('the lock is never nested: a store operation inside withMcpLock rejects at once', { timeout: 5000 }, async () => {
  await assert.rejects(withMcpLock(() => createSet('Inner')), /never nest/);
  let later;
  let kept;
  await withMcpLock((tx) => { kept = tx; later = new Promise((r) => setTimeout(() => r(createSet('Later')), 20)); });
  assert.equal((await later).id, 'later', 'work fn left scheduled runs as a new operation once the lock is released');
  await assert.rejects(kept.write('sets'), /after the lock was released/);
});

test('the lock: FIFO in-process, busy after the timeout', async () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  await Promise.all(names.map((n) => createSet(n)));
  assert.deepEqual(Object.keys(disk('sets').sets), names);
  writeFileSync(join(mcpDir(), '.lock'), JSON.stringify({ pid: process.ppid, token: 'x', at: new Date().toISOString() }));
  let ran = false;
  await assert.rejects(withMcpLock(() => { ran = true; }, { timeoutMs: 150 }), (e) => e instanceof McpStoreError && e.status === 503 && e.message === 'MCP registry is busy');
  assert.equal(ran, false);
});

test('hand-edited or corrupt files never throw on read; a locked write refuses a damaged file, then drops junk entries', async () => {
  put('sets', { sets: { billing: 5, shop: { name: 'Shop', slug: 'shop', members: [null, { server: 'manual:a', enabled: true, values: {} }] } },
    teams: { 'acme/x': 'oops' }, retired: 'x' });
  put('servers', { bases: [] });
  writeFileSync(file('secrets'), 'not json{');
  const s = await readMcpStore();
  assert.deepEqual(plain(s.sets), { shop: { name: 'Shop', slug: 'shop', members: [{ server: 'manual:a', enabled: true, values: {} }] }, general: { name: 'General', members: [] } });
  assert.deepEqual([plain(s.teams), s.retired, plain(s.bases), plain(s.secrets)], [{}, [], {}, {}]);
  const fixed = [['secrets', { sets: {} }], ['servers', { bases: {} }],
    ['sets', { sets: { billing: 5, shop: { name: 'Shop', slug: 'shop', members: [null] } }, teams: { 'acme/x': 'oops' }, retired: [] }]];
  for (const [name, obj] of fixed) { // each damaged file stops every locked write until it is fixed
    await assert.rejects(createSet('Billing'), { status: 409, message: `MCP registry file mcp/${name}.json is damaged — fix it or remove it` });
    put(name, obj);
  }
  assert.equal((await createSet('Billing')).id, 'billing');
  assert.deepEqual(Object.keys(disk('sets').sets), ['shop', 'billing']);
  assert.deepEqual([disk('sets').teams, disk('sets').sets.shop.members], [{}, []]); // junk below the top level is dropped
});

test('hand edits below the top level (incl. secret / Test leaves of the wrong type) read as absent; the next locked write drops them', async () => {
  await checkRows([
    { name: 'hand edits below the top level read as absent; the next locked write drops them', run: async () => {
      rowHome();
      const TEAM = 'team-acme-platform-9333';
      put('servers', { bases: { 'manual:a': 'a', 'manual:b': 7 }, manual: { a: null, b: { type: 'stdio', command: 'node', fields: [], description: '' } },
        policy: { 'acme/platform/x': { hash: 'h' } } });
      put('sets', {
        sets: { shop: { name: 'Shop', slug: 'shop', members: [{ server: 'manual:b', enabled: true, values: 'oops' }] } },
        teams: { 'acme/platform': { id: TEAM, slug: 'team-platfor', name: 'Team · acme/platform',
          members: { 'manual:b': 'bad', 'manual:c': { enabled: true, values: 5, seeded: null, consent: null } } } },
        projects: { 'a-1a2b3c4d': null, 'b-1a2b3c4d': { sets: 'shop', includeGeneral: 'yes' }, 'c-1a2b3c4d': { sets: ['shop', 5], includeGeneral: false } },
        retired: ['old', 3],
      });
      put('secrets', { sets: { shop: { 'manual:b': 'x' }, [TEAM]: { 'manual:c': { token: 5, key: { value: 'v', updatedAt: 't' } } } } });
      put('tests', { tests: { 'shop|manual:b': 'x' } });
      const s = await readMcpStore();
      assert.deepEqual([plain(s.bases), plain(s.manual), plain(s.policy)],
        [{ 'manual:a': 'a' }, { b: { type: 'stdio', command: 'node', fields: [], description: '' } }, {}]);
      assert.deepEqual(plain(s.sets.shop.members), [{ server: 'manual:b', enabled: true, values: {} }]);
      assert.deepEqual(plain(s.teams['acme/platform'].members), { 'manual:c': { enabled: true, values: {}, seeded: {}, consent: null } });
      const projects = { 'b-1a2b3c4d': { sets: [] }, 'c-1a2b3c4d': { sets: ['shop'], includeGeneral: false } };
      assert.deepEqual(plain(s.projects), projects);
      assert.deepEqual(s.retired, ['old']);
      const teamSecrets = { [TEAM]: { 'manual:c': { key: { value: 'v', updatedAt: 't' } } } };
      assert.deepEqual([plain(s.secrets), plain(s.tests)], [teamSecrets, {}]);
      await withMcpLock(async (tx) => { await tx.write('sets'); await tx.write('servers'); });
      assert.deepEqual([disk('secrets').sets, disk('tests').tests], [teamSecrets, {}]); // swept before fn ran
      assert.deepEqual(disk('sets').projects, projects);
      assert.deepEqual([disk('servers').bases, disk('servers').policy], [{ 'manual:a': 'a' }, {}]);
      put('sets', { sets: { odd: { name: {}, slug: 'odd', members: [] }, bare: { slug: 'bare', members: [] } } });
      assert.deepEqual([(await readMcpStore()).sets.odd.name, (await readMcpStore()).sets.bare.name], ['odd', 'bare']);
      assert.equal((await createSet('Shop')).id, 'shop'); // name checks never trip on a hand-edited name
    } },
    { name: 'a secret or Test result with a leaf of the wrong type reads as absent, and the next locked write drops it', run: async () => {
      rowHome();
      const member = (server) => ({ server, enabled: true, values: {} });
      put('sets', { sets: { general: { name: 'General', members: ['pg', 'a', 'b', 'c', 'd'].map((n) => member(`manual:${n}`)) } } });
      put('secrets', { sets: { general: { 'manual:pg': {
        a: { value: { $env: {} }, updatedAt: 't' }, b: { value: 5, updatedAt: 't' }, c: { value: 'ok-1', updatedAt: {} }, d: { value: '', updatedAt: 't' },
        keep: { value: 'kept-1', updatedAt: 't' }, env: { value: { $env: 'MCP_X' }, updatedAt: 't' } } } } });
      const ok = { at: 't', ok: true, tools: ['query'], error: null, fingerprint: 'f' };
      put('tests', { tests: { 'general|manual:pg': { ...ok, tools: [{}] }, 'general|manual:a': { ...ok, at: {} }, 'general|manual:b': { ...ok, fingerprint: 5 },
        'general|manual:c': { ...ok, error: {} }, 'general|manual:d': ok } });
      const s = await readMcpStore();
      assert.deepEqual(Object.keys(s.secrets.general['manual:pg']).sort(), ['env', 'keep']);
      assert.deepEqual(Object.keys(s.tests), ['general|manual:d']);
      await withMcpLock(async () => {});
      assert.deepEqual(Object.keys(disk('secrets').sets.general['manual:pg']).sort(), ['env', 'keep']);
      assert.deepEqual(disk('tests').tests, { 'general|manual:d': ok });
    } },
  ]);
});

test('a damaged file (sets/servers/secrets that does not parse, a top-level key of the wrong type) aborts every locked write and is kept; reads still work; a leading BOM is no damage', async () => {
  await checkRows([
    { name: 'a leading BOM is no damage; a secrets.json that does not parse aborts every locked write and is kept', run: async () => {
      rowHome();
      const secrets = { schema: 1, sets: { billing: { 'manual:a': { k: { value: 'tokA', updatedAt: 't' } }, 'manual:b': { k: { value: 'tokB', updatedAt: 't' } } } } };
      put('sets', { sets: { billing: { name: 'Billing', slug: 'billing', members: [
        { server: 'manual:a', enabled: true, values: {} }, { server: 'manual:b', enabled: true, values: {} }] } } });
      put('secrets', secrets);
      for (const n of ['sets', 'secrets']) writeFileSync(file(n), String.fromCharCode(0xfeff) + readFileSync(file(n), 'utf8'));
      assert.equal((await readMcpStore()).secrets.billing['manual:b'].k.value, 'tokB');
      await withMcpLock((tx) => tx.write('secrets')); // rewritten from the snapshot: whole
      assert.deepEqual(disk('secrets'), secrets);
      assert.equal((await createSet('Shop')).id, 'shop');
      const typo = JSON.stringify(secrets).replace('"tokB"', '"tokB",');
      writeFileSync(file('secrets'), typo);
      await assert.rejects(createSet('Old'), { status: 409, message: 'MCP registry file mcp/secrets.json is damaged — fix it or remove it' });
      assert.equal(readFileSync(file('secrets'), 'utf8'), typo, 'secrets.json is left as it was');
    } },
    { name: 'a sets.json or servers.json that does not parse aborts every locked write; reads still work, nothing is swept', run: async () => {
      rowHome();
      put('secrets', { sets: { billing: { 'manual:pg': { password: { value: 'keep', updatedAt: 't' } } } } });
      const damaged = [['sets', '{ "schema": 1, "sets": {}, }'], ['servers', '[]']];
      for (const [name, text] of damaged) {
        put('sets', { sets: { billing: { name: 'Billing', slug: 'billing', members: [{ server: 'manual:pg', enabled: true, values: {} }] } }, retired: ['old'] });
        writeFileSync(file(name), text);
        assert.equal(typeof (await readMcpStore()).sets, 'object'); // a read never throws
        await assert.rejects(createSet('Old'), { status: 409, message: `MCP registry file mcp/${name}.json is damaged — fix it or remove it` });
        assert.equal(disk('secrets').sets.billing['manual:pg'].password.value, 'keep', name);
        assert.equal(readFileSync(file(name), 'utf8'), text, `${name}.json is left as it was`);
      }
    } },
    { name: 'a top-level key of the wrong type aborts every locked write; nothing under it is dropped', run: async () => {
      rowHome();
      const secrets = { schema: 1, sets: { billing: { 'manual:a': { k: { value: 'tokA', updatedAt: 't' } } } } };
      for (const patch of [{ retired: 'old' }, { teams: [] }, { sets: null }, { projects: [] }]) {
        put('sets', { sets: { billing: { name: 'Billing', slug: 'billing', members: [{ server: 'manual:a', enabled: true, values: {} }] } }, retired: ['old'], ...patch });
        put('secrets', secrets);
        await assert.rejects(createSet('Old'), { status: 409, message: 'MCP registry file mcp/sets.json is damaged — fix it or remove it' }, JSON.stringify(patch));
        assert.deepEqual(disk('secrets'), secrets, JSON.stringify(patch));
      }
      put('sets', {});
      for (const bad of [{ manual: [] }, { policy: 5 }, { bases: 'x' }]) {
        put('servers', bad);
        await assert.rejects(createSet('Old'), { status: 409, message: 'MCP registry file mcp/servers.json is damaged — fix it or remove it' }, JSON.stringify(bad));
      }
      put('servers', {});
      put('secrets', { sets: 'x' });
      await assert.rejects(createSet('Old'), { status: 409, message: 'MCP registry file mcp/secrets.json is damaged — fix it or remove it' });
    } },
  ]);
});

test('a tests.json that does not parse reads as empty and is replaced by the next write of it (Test results only)', async () => {
  put('tests', { tests: {} });
  writeFileSync(file('tests'), '{ "schema": 1, "tests": { ');
  assert.deepEqual(plain((await readMcpStore()).tests), {});
  await withMcpLock((tx) => tx.write('tests'));
  assert.deepEqual(disk('tests'), { schema: 1, tests: {} });
});

test('a server listed twice in a set reads once; a slug, Team id or Team name that is not text is computed again', async () => {
  const TEAM = 'team-acme-platform-9333';
  put('sets', {
    sets: {
      general: { name: 'General', slug: 5, members: [] },
      billing: { name: 'Billing', slug: {}, members: [
        { server: 'manual:a', enabled: true, values: { v: 'one' } }, { server: 'manual:a', enabled: true, values: { v: 'two' } }] },
    },
    teams: { 'acme/platform': { id: {}, name: 7, members: { 'manual:a': { enabled: true, values: {}, seeded: {}, consent: 'c' } } } },
  });
  put('secrets', { sets: { billing: { 'manual:a': { k: { value: 'tokA', updatedAt: 't' } } }, [TEAM]: { 'manual:a': { k: { value: 'tokT', updatedAt: 't' } } } } });
  const s = await readMcpStore();
  assert.deepEqual(plain(s.sets), { general: { name: 'General', members: [] },
    billing: { name: 'Billing', slug: 'billing', members: [{ server: 'manual:a', enabled: true, values: { v: 'one' } }] } });
  const { members, ...rec } = s.teams['acme/platform'];
  assert.deepEqual(rec, { id: TEAM, slug: 'team-platfor', name: 'Team · acme/platform' });
  assert.deepEqual(Object.keys(members), ['manual:a']);
  assert.equal(s.secrets[TEAM]['manual:a'].k.value, 'tokT');
  await createSet('Next'); // the next locked write persists what was computed; nothing is swept
  assert.deepEqual(disk('sets').sets.billing, plain(s.sets.billing));
  assert.deepEqual(Object.keys(disk('secrets').sets), ['billing', TEAM]);
  put('sets', { sets: { shop: { name: 'Shop', slug: '', members: [] } }, teams: { 'acme/platform': { id: TEAM, slug: '', name: 'Team · acme/platform', members: {} } } });
  const e = await readMcpStore(); // an empty slug is computed again too
  assert.deepEqual([e.sets.shop.slug, e.teams['acme/platform'].slug], ['shop', 'team-platfor']);
});

test('a set id a project assignment still names is never allocated again (a set removed by hand or read as junk)', async () => {
  put('sets', { sets: { billing: null }, projects: { 'app-1a2b3c4d': { sets: ['billing', 'shop'], includeGeneral: false } } });
  assert.equal((await createSet('Billing')).id, 'billing-2');
  assert.equal((await createSet('Shop')).id, 'shop-2');
});

test('a lock left by a crashed process does not block the next write', async () => {
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  await withMcpLock(async () => {}); // creates mcp/
  writeFileSync(join(mcpDir(), '.lock'), JSON.stringify({ pid: dead, token: 'x', at: new Date().toISOString() }));
  assert.equal((await createSet('After crash')).id, 'after-crash');
});

test('a file that exists but cannot be read aborts the write instead of being replaced by an empty one', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  put('sets', { sets: { general: { name: 'General', members: [{ server: 'manual:pg', enabled: true, values: {} }] } } });
  put('secrets', { sets: { general: { 'manual:pg': { password: { value: 'keep', updatedAt: 't' } } } } });
  chmodSync(file('secrets'), 0);
  try {
    assert.deepEqual(plain((await readMcpStore()).secrets), {}); // a read never throws
    await assert.rejects(withMcpLock((tx) => tx.write('secrets')), { code: 'EACCES' });
  } finally { chmodSync(file('secrets'), 0o600); }
  assert.equal(disk('secrets').sets.general['manual:pg'].password.value, 'keep');
});
