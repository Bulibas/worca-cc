// src/shared/away-mode/activation.mjs — Away mode activation math. Pure; `now` is passed in. Shared by server and browser. Zero imports.

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

/** Spend-cap anchor: spend since this moment counts against the night cap. `since` = when the
 *  current unattended stretch began (the first night-decided question since a human answer),
 *  null when none has begun. Inside the window: the window start, or an earlier stretch start.
 *  Outside it (grace, toggle, opt-in): the stretch alone — the attended day never counts. */
export function nightAnchorMs(config, now, since = null) {
  if (inWindow(config.window, config.timeZone, now)) {
    const windowStart = now + msUntilWindowStart(config.window, config.timeZone, now) - DAY;
    return since == null ? windowStart : Math.min(windowStart, since);
  }
  return since ?? now;
}

/**
 * Away mode precedence (plans/away-mode-design.md §3.1). `optIn` = the run was MARKED at start.
 * @returns {{eligible:boolean, active:boolean, graceOn:boolean, wakeOn:boolean}}
 *   graceOn: the by-day "waited N minutes" rule applies (marked runs only); wakeOn: arm for the next away-hours start.
 */
export function nightState({ config, toggle = 'auto', optIn = false, override = 'auto', now }) {
  const off = { eligible: false, active: false, graceOn: false, wakeOn: false };
  if (override === 'off') return off;                                        // 1. Never on this run
  if (override === 'on') return { eligible: true, active: true, graceOn: false, wakeOn: false };   // 2. Answer for me now
  if (toggle === 'off') return off;                                          // 3. Paused
  if (toggle === 'on') return { eligible: true, active: true, graceOn: false, wakeOn: false };     // 4. I'm away now: every run
  const allowed = config.enabled === true || optIn === true;
  if (!allowed) return off;
  const away = inWindow(config.window, config.timeZone, now);                // 5. inside away hours
  return { eligible: true, active: away, graceOn: optIn === true && config.graceMinutes != null, wakeOn: true };
}

/** Is this run allowed at all, ignoring the clock and the global status? Today's `eligible`.
 *  Used only for --yes ownership (run-harness `_nightOwnsAuto`), which this change keeps as it is. */
export function runAllowed({ config, optIn = false, override = 'auto' }) {
  if (override === 'off') return false;
  return override === 'on' || config.enabled === true || optIn === true;
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
