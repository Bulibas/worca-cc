// src/core/actions/ports.mjs — free-port allocation for `auto` port variables.
import net from 'node:net';

export const DEFAULT_PORT_RANGE = Object.freeze({ low: 4400, high: 4499 });
const okPort = (n) => Number.isSafeInteger(n) && n >= 1024 && n <= 65535;

export function parsePortRange(s = {}, { strict = false } = {}) {
  const low = s.portLow ?? DEFAULT_PORT_RANGE.low;
  const high = s.portHigh ?? DEFAULT_PORT_RANGE.high;
  const bad = !okPort(low) || !okPort(high) ? 'ports must be whole numbers from 1024 to 65535'
    : low > high ? 'the low port must not be above the high port' : null;
  if (bad) { if (strict) throw new Error(bad); return { ...DEFAULT_PORT_RANGE }; }
  return { low, high };
}

// An address family this host does not have (no IPv6 in many containers) cannot hold the port.
const NO_SUCH_ADDRESS = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);

function bindOnce(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', (e) => resolve(NO_SUCH_ADDRESS.has(e?.code)));
    const opts = host ? { port, host, exclusive: true } : { port, exclusive: true };
    srv.listen(opts, () => srv.close(() => resolve(true)));
  });
}

/**
 * True when `port` is free right now. The issue asks for a loopback bind. That is not enough:
 * - Most dev servers listen on the wildcard address.
 * - Vite and Storybook bind `localhost`, which is `::1` on macOS with Node ≥ 17.
 * Under SO_REUSEADDR (Node's POSIX default) a bind to one address can succeed while another
 * address holds the port. So IPv4 loopback, IPv6 loopback and the wildcard are all probed.
 */
export async function probePort(port) {
  return (await bindOnce(port, '127.0.0.1')) && (await bindOnce(port, '::1')) && (await bindOnce(port, null));
}

export async function allocatePort({ range = DEFAULT_PORT_RANGE, held = new Set(), probe = probePort } = {}) {
  for (let p = range.low; p <= range.high; p++) {
    if (held.has(p)) continue;
    if (await probe(p)) return p;
  }
  const e = new Error(`no free port between ${range.low} and ${range.high}; widen the range in Settings › Runs › Actions`);
  e.code = 'PORTS_EXHAUSTED';
  throw e;
}
