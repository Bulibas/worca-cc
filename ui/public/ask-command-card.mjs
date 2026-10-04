// ui/public/ask-command-card.mjs
// Ask agent mode (#574): one command Ask ran, live in the chat. A pure DOM factory (doc injected), like
// ask-run-card.mjs: the panel owns hydration (GET …/commands/:blockId) and the ask-command frames.
export const COMMAND_CARD_TYPE = 'command';

function h(doc, tag, cls, text) {
  const el = doc.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

export function pillOf(v) {
  if (!v || v.status === 'running') return { text: 'running', family: 'peach' };
  if (v.status === 'stopped') return { text: v.stoppedBy === 'ask:cap' ? 'stopped (30-min cap)' : 'stopped', family: 'amber' };
  if (v.status === 'interrupted') return { text: 'interrupted', family: 'amber' };
  if (v.exitCode == null) return { text: 'ended', family: 'amber' };
  return { text: `exit ${v.exitCode}`, family: v.exitCode === 0 ? 'green' : 'red' };
}

export function createCommandCard({ doc, card, onStop }) {
  const el = h(doc, 'div', 'ask-card ask-cmd');
  el.dataset.blockId = card.blockId;
  const head = h(doc, 'div', 'ask-cmd-head');
  const pill = h(doc, 'span', 'ask-cmd-pill st-peach', 'running');
  const stop = h(doc, 'button', 'ask-cmd-stop', 'Stop');            // styled like .ask-rc-open (there is no .btn-sm)
  stop.type = 'button';
  stop.setAttribute('aria-label', 'Stop this command');
  stop.addEventListener('click', () => { stop.disabled = true; onStop(card.sessionId); });
  head.append(h(doc, 'span', 'ask-cmd-kicker', 'Command'), pill, h(doc, 'span', 'ask-cmd-folder', card.folder || ''), h(doc, 'span', 'ask-rc-spacer'), stop);
  const line = h(doc, 'div', 'ask-cmd-line', `$ ${card.command}`);
  const warning = h(doc, 'div', 'ask-cmd-warning', card.warning || '');
  warning.hidden = !card.warning;
  const out = h(doc, 'pre', 'ask-cmd-out');
  el.append(head, line, warning, out);
  let view = null;
  return {
    el,
    update(v) {
      view = v;
      const p = pillOf(v);
      pill.textContent = p.text;
      pill.className = `ask-cmd-pill st-${p.family}`;
      const live = !v || v.status === 'running';
      stop.hidden = !live;
      if (!live) stop.disabled = false;
      out.textContent = v && v.tail ? v.tail : '';
      out.hidden = !out.textContent;
      out.scrollTop = out.scrollHeight;
      el.classList.toggle('is-live', live);
    },
    get view() { return view; },
    destroy() { el.remove(); },
  };
}
