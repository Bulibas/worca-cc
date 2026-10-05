// test/ask-title-options.test.mjs
// P1/T2: generateTitle forwards the Ask Worca hardening options to runClaude —
// and forwards NOTHING new when they are absent (pipeline title calls unchanged).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkRows } from './helpers/rows.mjs';
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateTitle } from '../src/core/title.mjs';

const POSIX_SHIM = { skip: process.platform === 'win32' ? 'fake claude shim is a POSIX shell script (no .exe stand-in on Windows)' : false };

let prevMock, prevOrch;
beforeEach(() => {
  prevMock = process.env.WORCA_MOCK; prevOrch = process.env.ORCH_MOCK;
  delete process.env.WORCA_MOCK; delete process.env.ORCH_MOCK;
});
afterEach(() => {
  if (prevMock === undefined) delete process.env.WORCA_MOCK; else process.env.WORCA_MOCK = prevMock;
  if (prevOrch === undefined) delete process.env.ORCH_MOCK; else process.env.ORCH_MOCK = prevOrch;
});

async function fakeBin(dir, outFile) {
  const bin = join(dir, 'fake-claude.sh');
  await writeFile(bin, '#!/bin/sh\n' +
    `for a in "$@"; do printf '%s\\0' "$a" >> ${JSON.stringify(outFile)}; done\n` +
    `printf '%s\\n' '{"type":"result","result":"Fix Login Bug"}'\n` +
    'exit 0\n', 'utf8');
  await chmod(bin, 0o755);
  return bin;
}
function splitArgv(dump) { const parts = dump.split('\0'); parts.pop(); return parts; }

// One generateTitle spawn per call shape: the hardened ask call carries every option at
// once, the legacy call none of them.
test('ask title call: --tools "" + strict-mcp/setting-sources/slash flags, --mcp-config and permissionMode dontAsk reach the spawned argv; the title still comes back', POSIX_SHIM, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'worca-ask-title-'));
  const out = join(dir, 'argv.txt');
  const bin = await fakeBin(dir, out);
  const title = await generateTitle('fix login bug in auth module', {
    cwd: dir, bin, tools: [], strictMcpConfig: true, settingSources: ['project'], disableSlashCommands: true,
    mcpConfigPath: join(dir, 'mcp-empty.json'), permissionMode: 'dontAsk',
  });
  const argv = splitArgv(await readFile(out, 'utf8'));
  await checkRows([
    { name: 'hardened call: --tools "" + the three flags reach the spawned argv; the title still comes back', run: () => {
      assert.equal(title, 'Fix Login Bug');
      assert.equal(argv[argv.indexOf('--tools') + 1], '');
      assert.ok(argv.includes('--strict-mcp-config'));
      assert.equal(argv[argv.indexOf('--setting-sources') + 1], 'project');
      assert.ok(argv.includes('--disable-slash-commands'));
      assert.equal(argv[argv.indexOf('--effort') + 1], 'low', 'existing effort unchanged');
      assert.ok(!argv.includes('--allowedTools'), 'allowedTools: [] still emits no --allowedTools');
    } },
    { name: 'mcpConfigPath is forwarded when given', run: () => {
      assert.equal(argv[argv.indexOf('--mcp-config') + 1], join(dir, 'mcp-empty.json'));
    } },
    { name: 'generateTitle forwards permissionMode when given (the ask call passes dontAsk)', run: () => {
      const i = argv.indexOf('--permission-mode');
      assert.notEqual(i, -1);
      assert.equal(argv[i + 1], 'dontAsk');
    } },
  ]);
  await rm(dir, { recursive: true, force: true });
});

test('legacy title call: none of the new flags and the acceptEdits permission mode', POSIX_SHIM, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'worca-ask-title-'));
  const out = join(dir, 'argv.txt');
  const bin = await fakeBin(dir, out);
  await generateTitle('fix login bug', { cwd: dir, bin });
  const argv = splitArgv(await readFile(out, 'utf8'));
  await checkRows([
    { name: 'legacy call: none of the new flags appear', run: () => {
      for (const flag of ['--tools', '--strict-mcp-config', '--setting-sources', '--disable-slash-commands', '--mcp-config']) {
        assert.ok(!argv.includes(flag), `${flag} must not appear for a legacy caller`);
      }
    } },
    { name: 'generateTitle without permissionMode keeps the legacy acceptEdits argv', run: () => {
      const i = argv.indexOf('--permission-mode');
      assert.equal(argv[i + 1], 'acceptEdits');
    } },
  ]);
  await rm(dir, { recursive: true, force: true });
});
