// test/helpers/app-timers.mjs
import { setImmediate as realImmediate } from 'node:timers';
/** Mock app.js's call-time timers AFTER boot (a setInterval created at module eval, like
 *  _timerTick, stays real: drive it with window.__np.timerTick()). `now` keeps Date on the wall
 *  clock (the mock's default is 0). Never call a setTimeout-based settle() while this is on, and
 *  dispatch 'hashchange' yourself after setting location.hash (jsdom fires it from a timer). */
export function useAppTimers(t, { now = Date.now() } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  const settle = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => realImmediate(r)); };
  return { settle, async advance(ms) { t.mock.timers.tick(ms); await settle(); } };
}
