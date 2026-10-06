// test/helpers/stop-and-settle.mjs — stop the server's in-process runs a test started but does not assert on.
export async function stopAndSettle(runs, pick = () => true, { timeoutMs = 30_000 } = {}) {
  const picked = [...runs.entries()].filter(([, e]) => pick(e));
  for (const [, e] of picked) if (!e.settled) { try { e.orch?.stop?.('test'); } catch { /* over */ } }
  let timer;
  const deadline = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`stopAndSettle: ${picked.length} run(s) unsettled`)), timeoutMs); });
  try { await Promise.race([Promise.all(picked.map(([, e]) => Promise.resolve(e.launch).catch(() => {}))), deadline]); }
  finally { clearTimeout(timer); }
  for (const [id] of picked) runs.delete(id);
}
