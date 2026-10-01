// test/mcp-materialize.test.mjs
// MCP registry §5.4 + §5.7 rows 6–10: one membership becomes its --mcp-config entry — refs only in
// the entry, values in env, stdio through the launcher — or a skip reason, first match wins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { materializeCopy } from '../src/core/mcp/registry.mjs';
import { secretEnvName } from '../src/core/mcp/identity.mjs';
import { testFingerprint } from '../src/core/mcp/store.mjs';

const CTX = { env: { MCP_ORG_TOKEN: 'org-token-from-env', MCP_EMPTY: '', MCP_BAD_URL: 'a/b?c' }, platform: 'linux',
  execPath: '/usr/bin/node', worcaRoot: '/opt/worca' };
const LAUNCH = '/opt/worca/src/core/mcp/launch.mjs';
const field = (key, o = {}) => ({ key, label: o.label ?? key, secret: !!o.secret, oauth: false, required: !!o.required,
  ...(o.default !== undefined ? { default: o.default } : {}) });
const entry = (def, o = {}) => ({ id: 'manual:srv', source: o.source ?? 'manual', name: 'srv', dir: o.dir ?? null,
  code: o.code ?? null, pluginEnabled: true, base: 'srv', provisional: false, def: { description: 'd', fields: [], ...def } });
const sec = (value, updatedAt = '2026-09-01T00:00:00Z') => ({ value, updatedAt });
function mat(def, { values = {}, secrets = {}, copy = 'srv_billing', name = copy, ctx = {}, ...o } = {}) {
  return materializeCopy({ entry: entry(def, o), values, secrets, copy, name }, { ...CTX, ...ctx });
}
const ref = (key) => `\${${secretEnvName('srv_billing', key)}}`;

const STDIO = {
  type: 'stdio', command: 'npx',
  args: ['-y', '@acme/server', { field: 'db' }, { field: 'opt', prefix: '--opt=' }],
  env: { TOKEN: { field: 'tok' }, MODE: 'ro', OPTIONAL: { field: 'opt' } },
  fields: [field('db', { required: true }), field('tok', { secret: true, required: true }), field('opt')],
};

test('stdio: the launcher entry, secret refs only in env (as MCPCHILD_*), values in env, optional fields left out', () => {
  const r = mat(STDIO, { values: { db: 'postgres://ro@db/billing' }, secrets: { tok: sec('s3cret-token-1') } });
  assert.deepEqual(r.server, {
    type: 'stdio', command: '/usr/bin/node',
    args: [LAUNCH, '--copy', 'srv_billing', '--env', 'TOKEN,MODE', '--', 'npx', '-y', '@acme/server', 'postgres://ro@db/billing'],
    env: { MCPCHILD_TOKEN: ref('tok'), MCPCHILD_MODE: 'ro' },
  });
  assert.deepEqual(r.env, { [secretEnvName('srv_billing', 'tok')]: 's3cret-token-1' });
  assert.deepEqual(r.secretValues, ['s3cret-token-1']);
  const withOpt = mat(STDIO, { values: { db: 'x', opt: 'fast' }, secrets: { tok: sec('s3cret-token-1') }, name: 'srv_billing_w' });
  assert.deepEqual(withOpt.server.args, [LAUNCH, '--copy', 'srv_billing_w', '--env', 'TOKEN,MODE,OPTIONAL', '--', 'npx', '-y', '@acme/server', 'x', '--opt=fast']);
  assert.equal(withOpt.server.env.MCPCHILD_OPTIONAL, 'fast');
  assert.equal(withOpt.env[secretEnvName('srv_billing', 'tok')], 's3cret-token-1', 'env names use the copy name before a rename');
  const bare = mat({ type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp'] }, { copy: 'playwright' });
  assert.deepEqual(bare.server, { type: 'stdio', command: '/usr/bin/node', args: [LAUNCH, '--copy', 'playwright', '--', 'npx', '-y', '@playwright/mcp'] });
  assert.deepEqual(bare.env, {});
});

test('stdio: `node` runs as execPath; a plugin ./ command or argument resolves against the entry dir', () => {
  const dir = '/w/plugins/acme-tools/versions/3f9c21a';
  const r = mat({ type: 'stdio', command: 'node', args: ['./mcp/jira.mjs', './x', { field: 'p' }], fields: [field('p', { default: './kept' })] },
    { source: 'plugin', dir });
  assert.deepEqual(r.server.args.slice(4), ['/usr/bin/node', `${dir}/mcp/jira.mjs`, `${dir}/x`, './kept']);
  assert.deepEqual(mat({ type: 'stdio', command: './bin/srv' }, { source: 'plugin', dir }).server.args.at(-1), `${dir}/bin/srv`);
});

test('http/sse: url parts joined, non-secret values percent-encoded (a leading field is the base URL, as written), secret refs in path/query and headers', () => {
  const def = {
    type: 'http', url: ['https://api.example.com/', { field: 'org' }, '/mcp?key=', { field: 'key' }],
    headers: { Authorization: { field: 'tok', prefix: 'Bearer ' }, 'X-Org': { field: 'org' }, 'X-Opt': { field: 'opt' } },
    fields: [field('org', { required: true }), field('key', { secret: true, required: true }), field('tok', { secret: true, required: true }), field('opt')],
  };
  const r = mat(def, { values: { org: 'a b/c' }, secrets: { key: sec('k3y-value.xyz'), tok: sec('t0ken value!') } });
  assert.deepEqual(r.server, {
    type: 'http', url: `https://api.example.com/a%20b%2Fc/mcp?key=${ref('key')}`,
    headers: { Authorization: `Bearer ${ref('tok')}`, 'X-Org': 'a b/c' },
  });
  assert.deepEqual(r.secretValues.sort(), ['k3y-value.xyz', 't0ken value!']);
  assert.deepEqual(mat({ type: 'sse', url: 'http://127.0.0.1:8931/sse' }).server, { type: 'sse', url: 'http://127.0.0.1:8931/sse' });
  const whole = mat({ type: 'http', url: { field: 'u' }, fields: [field('u', { required: true })] }, { values: { u: 'https://h.example/mcp?a=1' } });
  assert.equal(whole.server.url, 'https://h.example/mcp?a=1', 'a whole-URL ref is not percent-encoded');
  const lead = (base, rest = ['/mcp']) => mat({ type: 'http', url: [{ field: 'base' }, ...rest],
    fields: [field('base', { required: true }), field('p', { required: true })] }, { values: { base, p: 'a b/c' } });
  assert.equal(lead('https://acme.example').server.url, 'https://acme.example/mcp', 'a leading field is the base URL: as written');
  assert.equal(lead('https://acme.example', ['/x/', { field: 'p' }]).server.url, 'https://acme.example/x/a%20b%2Fc', 'later values still encoded');
  assert.deepEqual(lead('http://evil.example'), { reason: 'invalid-url' }, 'the URL re-check still runs on it');
  const lone = mat({ type: 'http', url: ['https://h/', { field: 'v' }, '/mcp'], fields: [field('v', { required: true })] },
    { values: { v: `a${String.fromCharCode(0xD800)}b` } });
  assert.equal(lone.server.url, 'https://h/a%EF%BF%BDb/mcp', 'a lone surrogate never throws: made well-formed, then encoded');
  const host = (v) => mat({ type: 'http', url: [{ field: 'host', prefix: 'https://' }, '/mcp'], fields: [field('host', { required: true })] }, { values: { host: v } });
  assert.equal(host('deploy@mcp.acme.io').server.url, 'https://deploy@mcp.acme.io/mcp', 'a user name alone is no password');
});

test('effective values: set value, else the default; "" is no value; secrets only from secrets; unknown keys ignored', () => {
  const def = { type: 'stdio', command: 'srv', args: [{ field: 'a' }, { field: 'b' }, { field: 'c' }], env: { S: { field: 's' } },
    fields: [field('a', { default: 'da' }), field('b', { default: 'db' }), field('c'), field('s', { secret: true })] };
  const r = mat(def, { values: { a: 'va', b: '', s: 'plaintext-not-a-secret', gone: 'x' }, secrets: { gone: sec('old-secret-value') } });
  assert.deepEqual(r.server.args.slice(-3), ['srv', 'va', 'db']);
  assert.equal(r.server.env, undefined, 'a plaintext in values never fills a secret field');
  assert.deepEqual(r.env, {});
});

test('$env secrets: read from worca\'s env; a name outside MCP_* is env-denied; unset or empty is missing', () => {
  const def = { type: 'stdio', command: 'srv', env: { T: { field: 'tok' } }, fields: [field('tok', { secret: true, required: true })] };
  const ok = mat(def, { secrets: { tok: sec({ $env: 'MCP_ORG_TOKEN' }) } });
  assert.deepEqual(ok.env, { [secretEnvName('srv_billing', 'tok')]: 'org-token-from-env' });
  assert.deepEqual(mat(def, { secrets: { tok: sec({ $env: 'GH_TOKEN' }) } }), { reason: 'env-denied:GH_TOKEN' });
  assert.deepEqual(mat(def, { secrets: { tok: sec({ $env: 'MCP_UNSET' }) } }), { reason: 'missing:tok' });
  assert.deepEqual(mat(def, { secrets: { tok: sec({ $env: 'MCP_EMPTY' }) } }), { reason: 'missing:tok' });
});

const MISSING = { type: 'stdio', command: 'srv', env: { A: { field: 'a' }, T: { field: 'tok' } },
  fields: [field('a', { required: true }), field('tok', { secret: true, required: true })] };
const JOINED = (piece, o) => ({ type: 'stdio', command: 'srv', args: [piece], fields: [field('v', { required: true, ...o })] });
const URLDEF = (url, fields = []) => ({ type: 'http', url, fields });
const WIN = (resolved) => ({ ctx: { platform: 'win32', resolveCommand: () => resolved } });

test('skip reasons 6–10, each with the case that proves it', () => {
  const cases = [
    ['required non-secret unset', MISSING, { secrets: { tok: sec('s3cret-token-1') } }, 'missing:a'],
    ['required secret unset', MISSING, { values: { a: 'x' } }, 'missing:tok'],
    ['optional $env secret, variable unset', { type: 'stdio', command: 'srv', env: { T: { field: 'tok' } }, fields: [field('tok', { secret: true })] }, { secrets: { tok: sec({ $env: 'MCP_UNSET' }) } }, 'missing:tok'],
    ['prefix + value', JOINED({ field: 'v', prefix: 'x$' }), { values: { v: '{HOME}' } }, 'unsafe-text'],
    ['value + suffix', JOINED({ field: 'v', suffix: '{HOME}' }), { values: { v: 'abc$' } }, 'unsafe-text'],
    ['default + suffix', JOINED({ field: 'v', suffix: '{WORCA_HOME}' }, { default: 'v$' }), {}, 'unsafe-text'],
    ['a value holding ${', { type: 'stdio', command: 'srv', env: { E: { field: 'v' } }, fields: [field('v', { required: true })] }, { values: { v: 'a${HOME}' } }, 'unsafe-text'],
    ['URL literal ending $ + prefix starting {', URLDEF(['https://h/a$', { field: 'v', prefix: '{WORCA_HOME}' }], [field('v', { required: true })]), { values: { v: 'x' } }, 'unsafe-text'],
    ['whole-URL value holding ${', URLDEF({ field: 'u' }, [field('u', { required: true })]), { values: { u: 'https://h/${HOME}' } }, 'unsafe-text'],
    ['header prefix + value', { type: 'http', url: 'https://h/mcp', headers: { H: { field: 'v', prefix: '$' } }, fields: [field('v', { required: true })] }, { values: { v: '{X}' } }, 'unsafe-text'],
    ['a plugin dir holding ${ (the command)', { type: 'stdio', command: './bin/srv' }, { source: 'plugin', dir: '/w/${HOME}/p' }, 'unsafe-text'],
    ['a hand-edited slug holding ${ (the --copy name)', { type: 'stdio', command: 'npx', args: ['-y', 'x'] }, { copy: 'srv_${MCPSECRET_DEADBEEF}' }, 'unsafe-text'],
    ['a password spliced after a prefix (an args element)', JOINED({ field: 'v', prefix: '--db=postgresql://' }), { values: { v: 'deploy:hunter2secret@db.internal/billing' } }, 'unsafe-text'],
    ['a password spliced after a prefix (an env value)', { type: 'stdio', command: 'srv', env: { DATABASE_URL: { field: 'v', prefix: 'postgresql://' } }, fields: [field('v', { required: true })] }, { values: { v: 'deploy:hunter2secret@db.internal/billing' } }, 'unsafe-text'],
    ['a plain ?token= value spliced after a prefix (an env value)', { type: 'stdio', command: 'srv', env: { API_URL: { field: 'v', prefix: 'https://h.example/mcp?token=' } }, fields: [field('v', { required: true })] }, { values: { v: 'abc123plain' } }, 'unsafe-text'],
    ['a plain ?token= value spliced after a relative prefix (an args element)', JOINED({ field: 'v', prefix: 'mcp?token=' }), { values: { v: 'abc123plain' } }, 'unsafe-text'],
    ['a token shape spliced after a prefix (an args element)', JOINED({ field: 'v', prefix: 'ghp_' }), { values: { v: 'abcdefghij0123456789' } }, 'unsafe-text'],
    ['a value that spells the placeholder word (an args element)', JOINED({ field: 'v', prefix: '--db=postgresql://app:' }), { values: { v: 'hunter2mcpsecretref@db/x' } }, 'unsafe-text'],
    ['a password spliced after a prefix (a header value)', { type: 'http', url: 'https://h/mcp', headers: { 'X-Upstream': { field: 'v', prefix: 'https://' } }, fields: [field('v', { required: true })] }, { values: { v: 'deploy:hunter2secret@db.internal' } }, 'unsafe-text'],
    ['plain http to a remote host', URLDEF({ field: 'u' }, [field('u', { required: true })]), { values: { u: 'http://example.com/mcp' } }, 'invalid-url'],
    ['a leading base-URL field that is not a URL', URLDEF([{ field: 'u' }, '/mcp'], [field('u', { required: true })]), { values: { u: 'acme.example' } }, 'invalid-url'],
    ['secret in the host', URLDEF(['https://', { field: 's' }, '/mcp'], [field('s', { secret: true, required: true })]), { secrets: { s: sec('hostname') } }, 'invalid-url'],
    ['secret in the userinfo', URLDEF(['https://', { field: 's' }, '@h/mcp'], [field('s', { secret: true, required: true })]), { secrets: { s: sec('user') } }, 'invalid-url'],
    ['secret in the password', URLDEF(['https://u:', { field: 's' }, '@h/mcp'], [field('s', { secret: true, required: true })]), { secrets: { s: sec('pass') } }, 'invalid-url'],
    ['secret in the fragment', URLDEF(['https://h/mcp#', { field: 's' }], [field('s', { secret: true, required: true })]), { secrets: { s: sec('frag') } }, 'invalid-url'],
    ['URL-unsafe $env secret', URLDEF(['https://h/mcp?k=', { field: 's' }], [field('s', { secret: true, required: true })]), { secrets: { s: sec({ $env: 'MCP_BAD_URL' }) } }, 'invalid-url'],
    ['a URL starting with a field: a plain value in ?token=', URLDEF([{ field: 's' }, '://h\\v1?token=', { field: 't' }], [field('s', { required: true }), field('t', { required: true })]), { values: { s: 'https', t: 'pl41nt3xt' } }, 'invalid-url'],
    ['… and one that spells the placeholder word', URLDEF([{ field: 's' }, '://h\\v1?token=', { field: 't' }], [field('s', { required: true }), field('t', { required: true })]), { values: { s: 'https', t: 'pl41nt3xtmcpsecretref' } }, 'invalid-url'],
    ['a password spliced after a prefix (array url)', URLDEF([{ field: 'host', prefix: 'https://' }, '/mcp'], [field('host', { required: true })]), { values: { host: 'deploy:hunter2secret@mcp.acme.io' } }, 'invalid-url'],
    ['a password spliced after a prefix (whole-URL ref)', URLDEF({ field: 'host', prefix: 'https://', suffix: '/mcp' }, [field('host', { required: true })]), { values: { host: 'deploy:hunter2secret@mcp.acme.io' } }, 'invalid-url'],
    ['a token shape spliced after a prefix (url)', URLDEF(['https://s3.example/AKIA', { field: 'k' }], [field('k', { required: true })]), { values: { k: 'IOSFODNN7EXAMPLE' } }, 'unsafe-text'],
    ['a token shape across a leading base-URL field (url)', URLDEF([{ field: 'b' }, 'ghij0123456789'], [field('b', { required: true })]), { values: { b: 'https://h.example/ghu_abcdef' } }, 'unsafe-text'],
    ['win32: not on PATH', { type: 'stdio', command: 'npx' }, WIN(null), 'command-not-found'],
    ['win32: .ps1', { type: 'stdio', command: 'srv' }, WIN({ path: 'C:\\t\\srv.ps1', kind: 'ps1' }), 'win-shim-unsupported'],
    ['win32: & in an argument', { type: 'stdio', command: 'npx', args: ['-y', 'a&b'] }, WIN({ path: 'C:\\n\\npx.cmd', kind: 'shim' }), 'win-cmd-metachar'],
    ['win32: % from a value', { type: 'stdio', command: 'npx', args: [{ field: 'v' }], fields: [field('v', { required: true })] }, { ...WIN({ path: 'C:\\n\\npx.cmd', kind: 'shim' }), values: { v: '50%' } }, 'win-cmd-metachar'],
    ['win32: ! in the shim path', { type: 'stdio', command: 'npx' }, WIN({ path: 'C:\\a!b\\npx.cmd', kind: 'shim' }), 'win-cmd-metachar'],
  ];
  for (const [what, def, opts, reason] of cases) assert.deepEqual(mat(def, opts), { reason }, what);
});

test('a finished string passes §4.3\'s screen again: a user name alone, a secret ref as the password or a query value, token text beside a ref, a plugin\'s own dir — none is a plain secret', () => {
  const pg = mat(JOINED({ field: 'v', prefix: '--db=postgresql://' }), { values: { v: 'readonly@db.internal/billing' } });
  assert.equal(pg.server.args.at(-1), '--db=postgresql://readonly@db.internal/billing');
  const env = (piece) => mat({ type: 'stdio', command: 'srv', env: { U: piece }, fields: [field('s', { secret: true, required: true })] },
    { secrets: { s: sec('s3cret-pw-1') } }).server.env.MCPCHILD_U;
  assert.equal(env({ field: 's', prefix: 'postgresql://app:', suffix: '@db/x' }), `postgresql://app:${ref('s')}@db/x`);
  assert.equal(env({ field: 's', prefix: 'https://h.example/mcp?token=' }), `https://h.example/mcp?token=${ref('s')}`);
  const hdr = mat({ type: 'http', url: 'https://h/mcp', headers: { 'X-Upstream': { field: 'v', prefix: 'https://' } }, fields: [field('v', { required: true })] },
    { values: { v: 'deploy@db.internal' } });
  assert.equal(hdr.server.headers['X-Upstream'], 'https://deploy@db.internal');
  // no token runs through a secret ref (the placeholder word once completed `xoxr-` + ref, and `eyJ` + ref + `.`)
  assert.equal(env({ field: 's', prefix: 'xoxr-' }), `xoxr-${ref('s')}`);
  assert.equal(env({ field: 's', prefix: 'xox', suffix: 'r-abcdefghij' }), `xox${ref('s')}r-abcdefghij`, 'nor is a ref nothing');
  const jwt = mat(URLDEF(['https://h/p/eyJ', { field: 's' }, '.x'], [field('s', { secret: true, required: true })]), { secrets: { s: sec('s3cret-pw-1') } });
  assert.equal(jwt.server.url, `https://h/p/eyJ${ref('s')}.x`);
  // a plugin's resolved dir is Worca's install (or linked) path, no typed text
  const dir = '/w/plugins/sk-analytics-toolkit/versions/3f9c21a';
  assert.equal(mat({ type: 'stdio', command: 'node', args: ['./server.mjs'] }, { source: 'plugin', dir }).server.args.at(-1), `${dir}/server.mjs`);
  // in a url with no secret ref the placeholder word is a value's own text, a host like any other
  const word = mat(URLDEF([{ field: 'b' }, '/mcp'], [field('b', { required: true })]), { values: { b: 'https://mcpsecretref.example' } });
  assert.equal(word.server.url, 'https://mcpsecretref.example/mcp');
});

test('check order: env-denied → missing → unsafe-text → invalid-url → Windows', () => {
  const def = { type: 'http', url: 'http://example.com/mcp', headers: { H: { field: 'v', suffix: '{X}' } },
    fields: [field('v', { required: true }), field('need', { required: true }), field('s', { secret: true })] };
  const all = { values: { v: '$' }, secrets: { s: sec({ $env: 'HOME' }) } };
  assert.deepEqual(mat(def, all), { reason: 'env-denied:HOME' });
  assert.deepEqual(mat(def, { values: all.values }), { reason: 'missing:need' });
  assert.deepEqual(mat(def, { values: { v: '$', need: 'x' } }), { reason: 'unsafe-text' });
  assert.deepEqual(mat(def, { values: { v: 'fine', need: 'x' } }), { reason: 'invalid-url' });
  const win = { type: 'stdio', command: 'srv', args: [{ field: 'v', prefix: '$' }], fields: [field('v', { required: true })] };
  assert.deepEqual(mat(win, { ...WIN(null), values: { v: '{X}' } }), { reason: 'unsafe-text' });
});

test('loopback http and https pass the URL re-check', () => {
  for (const url of ['http://127.0.0.1:8080/mcp', 'http://localhost/mcp', 'http://[::1]:3000/mcp', 'https://mcp.sentry.dev/mcp']) {
    assert.equal(mat(URLDEF(url)).server.url, url);
  }
});

test('win32: an .exe runs directly, a .cmd/.bat shim through --win-shim, `node` never looks up PATH', () => {
  const exe = mat({ type: 'stdio', command: 'uv', args: ['run'] }, WIN({ path: 'C:\\t\\uv.EXE', kind: 'exe' }));
  assert.deepEqual(exe.server.args, [LAUNCH, '--copy', 'srv_billing', '--', 'C:\\t\\uv.EXE', 'run']);
  const shim = mat({ type: 'stdio', command: 'npx', args: ['-y', 'a b'] }, WIN({ path: 'C:\\Program Files\\nodejs\\npx.CMD', kind: 'shim' }));
  assert.deepEqual(shim.server.args, [LAUNCH, '--copy', 'srv_billing', '--win-shim', '--', 'C:\\Program Files\\nodejs\\npx.CMD', '-y', 'a b']);
  const node = mat({ type: 'stdio', command: 'node', args: ['s.mjs'] }, { ctx: { platform: 'win32', resolveCommand: () => { throw new Error('looked up'); } } });
  assert.deepEqual(node.server.args.slice(-2), ['/usr/bin/node', 's.mjs']);
});

test('fingerprint: the §4.5 fingerprint over the definition, plugin code, effective values and secret ages', () => {
  const def = { type: 'stdio', command: 'srv', env: { T: { field: 'tok' } },
    fields: [field('a', { default: 'da' }), field('b'), field('tok', { secret: true, required: true })] };
  const secrets = { tok: sec('s3cret-token-1', '2026-09-02T00:00:00Z') };
  const r = mat(def, { secrets, code: '3f9c21a' });
  const full = { description: 'd', fields: [], ...def };
  assert.equal(r.fingerprint, testFingerprint({ def: full, code: '3f9c21a', values: { a: 'da' }, secrets: { tok: '2026-09-02T00:00:00Z' } }));
  for (const other of [
    mat(def, { secrets, code: 'linked' }),
    mat(def, { secrets, code: '3f9c21a', values: { b: 'x' } }),
    mat(def, { secrets: { tok: sec('s3cret-token-1', '2026-09-03T00:00:00Z') }, code: '3f9c21a' }),
    mat({ ...def, command: 'srv2' }, { secrets, code: '3f9c21a' }),
  ]) assert.notEqual(other.fingerprint, r.fingerprint);
});
