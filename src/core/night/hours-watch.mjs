// src/core/night/hours-watch.mjs — the away hours starting or ending BY THEMSELVES (wording §3.9).
// tick() compares the user-level status with the last one; a change of the status, "I'm here",
// the hours or the zone is a click or an edit, never an edge, so it only moves the baseline.
// Readers are injected (ui/server.mjs wires the real ones; tests pass fakes). Never throws.
import { describeAwayMode, zoneOf } from '../../shared/away-mode/describe.mjs';
import { nightState, windowStartMs } from './activation.mjs';

const TERMINAL = new Set(['done', 'stopped', 'error']);
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * @param {{readStatus:()=>{config:object, toggle:string, hereSince:number|null}, now?:()=>number, localZone?:string|null,
 *   liveRuns:()=>Array<{projectDir:string, status:string, night?:object}>, effective:(dir:string)=>{config:object},
 *   answeredSince:(ms:number)=>{answered:number, flagged:number}, onEdge:(e:{edge:'start'|'end', count:number, chat:boolean, text:string})=>void}} deps
 */
export function createAwayHoursWatch({ readStatus, now = Date.now, localZone = null, liveRuns, effective, answeredSince, onEdge }) {
  let last = null;
  const emit = (e) => { try { onEdge(e); } catch { /* a listener must never stop the watch */ } };

  function runsAnswered(st, t) {
    let n = 0;
    for (const r of liveRuns() || []) {
      if (!r || TERMINAL.has(String(r.status)) || !r.night) continue;
      try {
        const { config } = effective(r.projectDir);
        const s = nightState({ config: { ...config, timeZone: zoneOf(config, localZone) }, toggle: st.toggle, hereSince: st.hereSince,
          optIn: r.night.optIn === true, override: r.night.override || 'auto', now: t });
        if (s.active) n += 1;
      } catch { /* one run must not stop the count */ }
    }
    return n;
  }

  return {
    tick() {
      try {
        const st = readStatus(); const t = now();
        const tz = zoneOf(st.config, localZone);
        const status = describeAwayMode({ config: st.config, toggle: st.toggle, hereSince: st.hereSince, now: t, localZone }).status;
        const key = JSON.stringify([st.toggle, st.hereSince ?? null, st.config.window ?? null, tz]);
        const prev = last;
        const start = status === 'away-hours' ? windowStartMs(st.config.window, tz, t) : null;
        last = { status, key, start };
        if (!prev || prev.key !== key) return;                       // the baseline, or a click / an edit
        if (prev.status === 'here' && status === 'away-hours') {
          const n = runsAnswered(st, t);
          const [from, to] = st.config.window.split('-');
          emit({ edge: 'start', count: n, chat: n > 0, text: `Away hours started (${from} to ${to}). ${n ? `worca now answers questions on ${plural(n, 'run')}.` : 'No run is answered by worca right now.'}` });
        } else if (prev.status === 'away-hours' && status === 'here') {
          const { answered, flagged } = answeredSince(prev.start);
          emit({ edge: 'end', count: answered, chat: answered > 0, text: answered
            ? `Away hours ended. worca answered ${plural(answered, 'question')} while you were away${flagged ? `; ${flagged} to check` : ''}.`
            : 'Away hours ended. worca answered nothing while you were away.' });
        }
      } catch { /* unreadable settings: no status this tick */ }
    },
  };
}
