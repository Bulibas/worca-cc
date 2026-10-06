// test/cli-ui-signal.test.mjs
// B2: a stop sent to `worca ui` reaches the server it spawned. In a container tini signals only
// its direct child (tini -> entrypoint -> `worca ui`); before the fix that process died on
// SIGTERM at once and left ui/server.mjs running until the SIGKILL, so the server's shutdown (and
// the drain) never ran. The parent must forward the signal, wait, and exit with the server's code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli/worca-cc.mjs', import.meta.url));

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
    s.on('error', rej);
  });
}

async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`);
    return r.status;
  } catch { return null; }
}

test('SIGTERM to `worca ui` reaches the server: it shuts down gracefully and the CLI exits 143', { skip: process.platform === 'win32', timeout: 60000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'worca-cc-uisig-'));
  const port = await freePort();
  const child = spawn(process.execPath, [CLI, 'ui', '--port', String(port), '--mock'], {
    env: { ...process.env, WORCA_HOME: home, WORCA_DRAIN_TIMEOUT_MS: '2000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })));
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      up = (await health(port)) === 200;
      if (!up) await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(up, `the UI never answered:\n${log}`);
    child.kill('SIGTERM');   // the parent only, as tini does
    const { code, signal } = await exited;
    assert.equal(signal, null, 'the CLI handled the signal instead of dying of it');
    assert.equal(code, 143, log);
    assert.equal(await health(port), null, 'the server is gone too, not orphaned');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
