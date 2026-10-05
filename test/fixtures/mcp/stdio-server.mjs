// A tiny stdio MCP server for the Test route (no SDK): answers initialize and tools/list.
//   ok [envFile]      answer; with envFile, first write the env it was started with as JSON
//   slow <ms>         answer initialize after <ms>, tools/list at once
//   leak              answer initialize with an error that quotes FIXTURE_TOKEN
//   hang <pidFile>    start a grandchild, write "<pid> <grandchild pid>", never answer
//   flood             write 11 MB to stdout with no newline, never answer
//   noisy             print FIXTURE_TOKEN after 3000 characters of stderr on one line, then exit
//   cursor            answer tools/list with 1000 tools and a nextCursor, forever
//   closein           close stdin unread and stay alive (every write to it fails: EPIPE); answer initialize (id 0) blind
import { spawn } from 'node:child_process';
import { closeSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [mode, file] = process.argv.slice(2);
if (mode === 'slow' && !(Number(file) > 0)) throw new Error(`slow needs a delay in ms, got ${file}`);
if (mode === 'ok' && file) writeFileSync(file, JSON.stringify(process.env));
if (mode === 'flood') process.stdout.write('x'.repeat(11 * 1024 * 1024));
if (mode === 'noisy') process.stderr.write(`${'n'.repeat(3000)}${process.env.FIXTURE_TOKEN}${'m'.repeat(1990)}\n`, () => process.exit(1));
if (mode === 'hang') {
  const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
  writeFileSync(file, `${process.pid} ${gc.pid}`);
}
const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
if (mode === 'closein') {
  closeSync(0);
  setTimeout(() => send({ id: 0, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } }), 300);
  setInterval(() => {}, 1e9);
}
if (mode !== 'closein') createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (mode === 'hang' || mode === 'flood' || msg.id === undefined) return;
  const answer = () => {
    if (msg.method === 'initialize') {
      if (mode === 'leak') return send({ id: msg.id, error: { code: -32000, message: `bad token ${process.env.FIXTURE_TOKEN}` } });
      return send({ id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } });
    }
    if (msg.method === 'tools/list' && mode === 'cursor') {
      return send({ id: msg.id, result: { tools: Array.from({ length: 1000 }, (_, i) => ({ name: `t${i}`, inputSchema: { type: 'object' } })), nextCursor: 'again' } });
    }
    if (msg.method === 'tools/list') {
      return send({ id: msg.id, result: { tools: [{ name: 'search_issues', inputSchema: { type: 'object' } }, { name: 'get_issue', inputSchema: { type: 'object' } }] } });
    }
    send({ id: msg.id, error: { code: -32601, message: 'no such method' } });
  };
  if (mode === 'slow' && msg.method === 'initialize') setTimeout(answer, Number(file)); else answer();
});
