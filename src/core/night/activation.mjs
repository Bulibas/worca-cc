// src/core/night/activation.mjs
// Pure activation math. `now` is always passed in (the harness owns the clock seam).

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function parseWindow(w) {
  const m = typeof w === 'string' && /^(\d\d):(\d\d)-(\d\d):(\d\d)$/.exec(w);
  return m ? { start: +m[1] * 60 + +m[2], end: +m[3] * 60 + +m[4] } : null;
}

/** Minutes since local midnight (and seconds/ms) of `now` in zone `tz` (null → host zone). */
function localClock(now, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz || undefined, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  return { minutes: get('hour') * 60 + get('minute'), seconds: get('second'), ms: now % 1000 };
}

export function inWindow(w, tz, now) {
  const win = parseWindow(w);
  if (!win) return false;
  const { minutes } = localClock(now, tz);
  return win.start < win.end ? minutes >= win.start && minutes < win.end
    : minutes >= win.start || minutes < win.end;          // wraps midnight
}

/** ms until the next window START (a full day when it just started). */
export function msUntilWindowStart(w, tz, now) {
  const win = parseWindow(w);
  if (!win) return null;
  const { minutes, seconds, ms } = localClock(now, tz);
  let deltaMin = win.start - minutes;
  if (deltaMin <= 0) deltaMin += 24 * 60;
  return deltaMin * 60_000 - seconds * 1000 - ms;
}

/** Start of the current/most recent night (spend-cap anchor): the last window start, else now-12h. */
export function nightAnchorMs(config, now) {
  const next = msUntilWindowStart(config.window, config.timeZone, now);
  return next == null ? now - 12 * HOUR : now + next - DAY;
}

/**
 * @param {{config:object, toggle:'auto'|'on'|'off', optIn:boolean, override:'auto'|'on'|'off', now:number}} o
 * @returns {{eligible:boolean, active:boolean, graceOn:boolean, wakeOn:boolean}}
 *   graceOn: the grace-timeout trigger applies; wakeOn: the window-start trigger applies.
 */
export function nightState({ config, toggle = 'auto', optIn = false, override = 'auto', now }) {
  const eligible = override !== 'off' && (config.enabled === true || optIn === true || override === 'on');
  if (!eligible) return { eligible: false, active: false, graceOn: false, wakeOn: false };
  if (override === 'on') return { eligible, active: true, graceOn: config.graceMinutes != null, wakeOn: true };
  if (toggle === 'off') return { eligible, active: false, graceOn: false, wakeOn: false };
  const active = toggle === 'on' || inWindow(config.window, config.timeZone, now);
  return { eligible, active, graceOn: config.graceMinutes != null, wakeOn: true };
}

/** Delay before the decider may answer a question opened at `openedAt`; null = never (wait for the user). */
export function decideDelayMs({ state, config, openedAt, now }) {
  if (!state.eligible) return null;
  if (state.active) return 0;
  const cands = [];
  if (state.graceOn && config.graceMinutes != null) cands.push(Math.max(0, openedAt + config.graceMinutes * 60_000 - now));
  const w = state.wakeOn ? msUntilWindowStart(config.window, config.timeZone, now) : null;
  if (w != null) cands.push(w);
  return cands.length ? Math.min(...cands) : null;
}
