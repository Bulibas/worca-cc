// test/ask-panel-mcp.test.mjs — the per-chat MCP picker (MCP registry §9.4, Appendix B 10): the composer chip
// `MCP · N`, level 1 (a switch + a › drill button per set in play), level 2 (per membership; skipped rows
// disabled with their reason), the choices (held by the composer and sent with every message, PATCHed in order
// once a thread exists), the notice link.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makePanel, key } from './helpers/ask-panel-harness.mjs';

const TID = 'ask_00000001';
const copy = (setId, setName, name, serverId) => ({ name, copy: name, setId, setName, serverId, projects: [], description: '', renamedFrom: null, provisional: false });
const PREVIEW = {   // Appendix B 10: pinned billing, an open worktree on shop, the acme/platform Team set
  sets: [
    { id: 'general', name: 'General', group: 'general', routes: [], members: 2, started: 2 },
    { id: 'billing', name: 'Billing', group: 'set', routes: [{ project: 'billing-00000001', route: 'pinned' }], members: 3, started: 2 },
    { id: 'shop', name: 'Shop', group: 'set', routes: [{ project: 'shop-00000002', route: 'worktree' }], members: 2, started: 2 },
    { id: 'team-acme-platform-9333', name: 'Team · acme/platform', group: 'team', routes: [{ project: 'billing-00000001', route: 'pinned' }], members: 3, started: 1 },
  ],
  copies: [
    copy('general', 'General', 'jira', 'plugin:acme-tools/jira'), copy('general', 'General', 'playwright', 'manual:playwright'),
    copy('billing', 'Billing', 'postgres-ro_billing', 'manual:postgres-ro'), copy('billing', 'Billing', 'sentry_billing', 'plugin:acme-tools/sentry'),
    copy('shop', 'Shop', 'postgres-ro_shop', 'manual:postgres-ro'), copy('shop', 'Shop', 'sentry_shop', 'plugin:acme-tools/sentry'),
    copy('team-acme-platform-9333', 'Team · acme/platform', 'datadog_team-platfor', 'policy:acme/platform/datadog'),
  ],
  skipped: [
    { setId: 'billing', setName: 'Billing', serverId: 'plugin:acme-tools/jira', copy: 'jira_billing', reason: 'missing:token', why: 'API token not set' },
  ],
  started: 7,
};

function handler(state) {
  return (url, opts) => {
    const method = ((opts || {}).method || 'GET').toUpperCase();
    if (url === '/api/ask/mcp-preview') {
      state.previews.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => state.preview };
    }
    if (url === '/api/ask/threads' && method === 'POST') return { ok: true, status: 201, json: async () => ({ thread: { id: TID, title: null, createdAt: 't', updatedAt: 't', model: null, effort: null, sessionId: null, context: null, totals: {} } }) };
    if (url === `/api/ask/threads/${TID}` && method === 'PATCH') { state.patches.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ thread: { id: TID } }) }; }
    if (url === `/api/ask/threads/${TID}` && method === 'GET' && state.snap) return { ok: true, status: 200, json: async () => state.snap };
    if (url === `/api/ask/threads/${TID}/messages` && method === 'POST') { state.bodies.push(JSON.parse(opts.body)); return { ok: true, status: 202, json: async () => ({ userMessageId: 'askm_u0000001', assistantMessageId: 'askm_00000001' }) }; }
    return { ok: true, status: 200, json: async () => ({}) };
  };
}
const setup = (over = {}) => {
  const state = { previews: [], patches: [], bodies: [], preview: PREVIEW, snap: null, ...over };
  const ctx = makePanel({ fetchHandler: handler(state), getPageContext: () => ({ view: 'projects', projectKey: 'billing-00000001' }), ...(over.panel || {}) });
  return { state, ctx };
};
const settle = async (ctx) => { for (let i = 0; i < 6; i++) await ctx.tick(); };
const btn = (ctx) => ctx.doc.querySelector('[data-ask-mcp-btn]');
const pop = (ctx) => ctx.doc.querySelector('.ask-pop-mcp');

test('chip: MCP · N right after the scope pill, advanced level; N = copies starting next turn; hidden when no set in play has a member', async () => {
  const { state, ctx } = setup();
  ctx.panel.open();
  await settle(ctx);
  const b = btn(ctx);
  assert.equal(ctx.doc.querySelector('[data-ask-scope-btn]').nextElementSibling, b);
  assert.equal(b.dataset.minLevel, 'advanced');
  assert.equal(b.hidden, false);
  assert.equal(b.textContent.trim(), 'MCP · 7');
  assert.deepEqual(state.previews[0], { context: { view: 'projects', projectKey: 'billing-00000001', pinned: false }, mcpOff: { sets: [], members: [] }, model: 'claude-opus-5-5' },
    'the same scopedContext(getPageContext()) the send uses, the held choices and the composer\'s model');
  state.preview = { sets: [{ id: 'general', name: 'General', group: 'general', routes: [], members: 0, started: 0 }], copies: [], skipped: [], started: 0 };
  ctx.panel.close(); ctx.panel.open();
  await settle(ctx);
  assert.equal(b.hidden, true, 'nothing in play has a member');
  ctx.panel.destroy();
});

test('level 1: one row per set in the preview\'s order — role none holding a menuitemcheckbox switch and a menuitem drill button; the footer links Settings', async () => {
  const { ctx } = setup();
  ctx.panel.open();
  await settle(ctx);
  btn(ctx).click();
  await settle(ctx);
  const rows = [...pop(ctx).querySelectorAll('.ask-mcp-row')];
  assert.equal(rows.length, 4);
  for (const r of rows) {
    assert.equal(r.getAttribute('role'), 'none');
    assert.equal(r.children[0].getAttribute('role'), 'menuitemcheckbox');
    assert.equal(r.children[0].getAttribute('aria-checked'), 'true');
    assert.equal(r.children[1].getAttribute('role'), 'menuitem');
  }
  assert.deepEqual(rows.map((r) => r.children[1].querySelector('.ask-model-name').textContent),
    ['General', 'Billing · pinned', 'Shop · open worktree', 'Team · acme/platform']);
  assert.deepEqual(rows.map((r) => r.children[1].querySelector('.ask-pop-row-value').textContent), ['2/2', '2/3', '2/2', '1/3']);
  assert.match(pop(ctx).textContent, /Manage in Settings › MCP servers/);
  // the keyboard walks the switches too (menuItems() is widened to menuitemcheckbox)
  assert.equal(ctx.doc.activeElement, rows[0].children[0], 'the first switch takes focus on open');
  rows[0].children[1].focus();
  key(ctx.window, rows[0].children[1], 'ArrowDown');
  assert.equal(ctx.doc.activeElement, rows[1].children[0], 'a drill button → the next row\'s switch');
  ctx.panel.destroy();
});

test('level 2: ‹ back row, one row per membership (copy + switch; "name provisional" §4.4, withheld tools §5.6); a skipped membership is a disabled row with its reason, problems apart from choices (§5.7); footer names the set', async () => {
  const { ctx } = setup({ preview: { ...PREVIEW,
    copies: PREVIEW.copies.map((c) => (c.name === 'sentry_billing' ? { ...c, provisional: true } : c)),
    skippedTools: [{ name: 'postgres-ro_billing', tool: 'run_query', reason: 'tool-name-too-long:run_query' }],
    skipped: [   // out of order on purpose: rows sort by the name each shows
      { setId: 'billing', setName: 'Billing', serverId: 'manual:gone', copy: null, reason: 'missing-server', why: 'the server is no longer installed' },
      { setId: 'billing', setName: 'Billing', serverId: 'manual:linear', copy: 'linear_billing', reason: 'off', why: 'off' },
      ...PREVIEW.skipped],
  } });
  ctx.panel.open();
  await settle(ctx);
  btn(ctx).click();
  await settle(ctx);
  pop(ctx).querySelectorAll('.ask-mcp-row')[1].children[1].click();          // drill into Billing
  const p = pop(ctx);
  assert.equal(p.querySelector('[data-ask-pane-back]').textContent, '‹ Billing');
  const members = [...p.querySelectorAll('.ask-mcp-row')].map((r) => [r.querySelector('.ask-mcp-copy').textContent, r.querySelector('[role="menuitemcheckbox"]').getAttribute('aria-checked')]);
  assert.deepEqual(members, [['postgres-ro_billing · tool-name-too-long:run_query', 'true'], ['sentry_billing · name provisional', 'true']]);
  assert.equal(p.querySelector('.ask-mcp-row [role="menuitemcheckbox"]').getAttribute('aria-label'), 'postgres-ro_billing · tool-name-too-long:run_query', 'the switch label carries the row note');
  const skipped = [...p.querySelectorAll('.ask-mcp-member.is-skipped')].map((b) => [b.textContent, b.disabled, b.classList.contains('is-problem')]);
  assert.deepEqual(skipped, [
    ['jira_billingAPI token not set', true, true],
    ['linear_billingoff', true, false],                                     // a choice (§5.7): muted
    ['manual:gonethe server is no longer installed', true, true],           // no copy name: its id stands in
  ]);
  assert.match(p.textContent, /Manage Billing in Settings › MCP servers/);
  p.querySelector('[data-ask-pane-back]').click();
  assert.equal(pop(ctx).querySelectorAll('.ask-mcp-row').length, 4, 'back to level 1');
  ctx.panel.destroy();
});

test('choices: held before a thread exists and sent with the first message; PATCHed once it exists; every change re-previews', async () => {
  const { state, ctx } = setup();
  ctx.panel.open();
  await settle(ctx);
  btn(ctx).click();
  await settle(ctx);
  pop(ctx).querySelectorAll('.ask-mcp-row')[1].children[0].click();          // Billing off
  await settle(ctx);
  assert.equal(state.patches.length, 0, 'no thread yet');
  assert.deepEqual(state.previews.at(-1).mcpOff, { sets: ['billing'], members: [] });
  assert.equal(pop(ctx).querySelectorAll('.ask-mcp-row')[1].children[0].getAttribute('aria-checked'), 'false');
  pop(ctx).querySelectorAll('.ask-mcp-row')[2].children[1].click();          // drill into Shop
  pop(ctx).querySelector('.ask-mcp-row [role="menuitemcheckbox"]').click();  // postgres-ro_shop off
  await settle(ctx);
  assert.deepEqual(state.previews.at(-1).mcpOff, { sets: ['billing'], members: ['shop|manual:postgres-ro'] });
  btn(ctx).click();                                                          // close the picker
  assert.equal(pop(ctx), null);
  ctx.doc.querySelector('textarea.ask-input').value = 'hello';
  ctx.doc.querySelector('[data-ask-send]').click();
  await settle(ctx);
  assert.deepEqual(state.bodies[0].mcpOff, { sets: ['billing'], members: ['shop|manual:postgres-ro'] }, 'the first message stores them');
  btn(ctx).click(); await settle(ctx);
  pop(ctx).querySelectorAll('.ask-mcp-row')[1].children[0].click();          // Billing back on — the thread exists now
  await settle(ctx);
  assert.deepEqual(state.patches.at(-1), { mcpOff: { sets: [], members: ['shop|manual:postgres-ro'] } });
  assert.equal(state.previews.at(-1).threadId, TID);
  ctx.panel.destroy();
});

test('choices follow the thread: a stored mcp_off restores the switches; New chat clears them', async () => {
  const snap = { thread: { id: TID, title: 'T', createdAt: 't', updatedAt: 't', model: null, effort: null, sessionId: null, context: null, totals: {}, mcpOff: { sets: ['shop'], members: [] } },
    messages: [], attachments: [], runLinks: [], worktrees: [], inFlight: null };
  const { state, ctx } = setup({ snap });
  ctx.storage.setItem('worca-cc.ask.thread', TID);
  ctx.panel.open();
  await settle(ctx);
  assert.deepEqual(state.previews.at(-1).mcpOff, { sets: ['shop'], members: [] });
  btn(ctx).click(); await settle(ctx);
  assert.equal(pop(ctx).querySelectorAll('.ask-mcp-row')[2].children[0].getAttribute('aria-checked'), 'false', 'Shop is off in this chat');
  ctx.doc.querySelector('[data-ask-new-btn]').click();
  await settle(ctx);
  assert.deepEqual(state.previews.at(-1).mcpOff, { sets: [], members: [] });
  assert.equal(state.previews.at(-1).threadId, undefined);
  ctx.panel.destroy();
});

test('refresh: an ask-worktrees change, the page (Auto), the scope; a join notice\'s "MCP" opens the picker', async () => {
  const notice = { kind: 'notice', text: "shop's MCP servers (sentry_shop, postgres-ro_shop) join from the next message", mcp: true };
  const snap = { thread: { id: TID, title: 'T', createdAt: 't', updatedAt: 't', model: null, effort: null, sessionId: null, context: null, totals: {} },
    messages: [{ id: 'askm_00000001', threadId: TID, seq: 1, role: 'assistant', text: 'done', blocks: [notice], status: 'done', createdAt: 't' }],
    attachments: [], runLinks: [], worktrees: [], inFlight: null };
  const { state, ctx } = setup({ snap });
  ctx.storage.setItem('worca-cc.ask.thread', TID);
  ctx.panel.open();
  await settle(ctx);
  let n = state.previews.length;
  ctx.panel.pushServerFrame({ type: 'ask-worktrees', threadId: TID, worktrees: [{ worktreeId: 'wt_00000001', projectKey: 'shop-00000002', ref: 'main', commit: 'abc1234', path: '/w', createdAt: 't' }] });
  ctx.flush(); await settle(ctx);
  assert.equal(state.previews.length, n + 1, 'an opened worktree re-previews');
  n = state.previews.length;
  ctx.window.dispatchEvent(new ctx.window.Event('hashchange'));
  await settle(ctx);
  assert.equal(state.previews.length, n + 1, 'in Auto, a page change re-previews');
  n = state.previews.length;
  ctx.doc.querySelector('[data-ask-scope-btn]').click();
  await settle(ctx);
  [...ctx.doc.querySelectorAll('.ask-scope-item')].find((i) => /Auto/.test(i.textContent)).click();
  await settle(ctx);
  assert.equal(state.previews.length, n + 1, 'a scope choice re-previews');
  const link = ctx.doc.querySelector('.ask-notice .ask-notice-mcp');
  assert.equal(link.textContent, 'MCP');
  link.click();
  await settle(ctx);
  assert.ok(pop(ctx), 'the picker is open');
  ctx.panel.destroy();
});

test('a slower, older preview never overwrites a newer one', async () => {
  let release; const late = new Promise((r) => { release = r; });
  let n = 0;
  const state = { previews: [], patches: [], bodies: [], preview: PREVIEW, snap: null };
  const base = handler(state);
  const ctx = makePanel({ fetchHandler: (url, opts) => {
    if (url === '/api/ask/mcp-preview' && ++n === 1) return late.then(() => ({ ok: true, status: 200, json: async () => ({ ...PREVIEW, started: 1 }) }));
    return base(url, opts);
  } });
  ctx.panel.open();
  await settle(ctx);
  ctx.panel.close(); ctx.panel.open();
  await settle(ctx);
  assert.equal(btn(ctx).textContent.trim(), 'MCP · 7');
  release();
  await settle(ctx);
  assert.equal(btn(ctx).textContent.trim(), 'MCP · 7', 'the stale response was dropped');
  ctx.panel.destroy();
});

test('a model pick re-previews with the new model (it sets the §5.6 tool-name limit)', async () => {
  const CAT = { models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: ['high'], custom: false }, { id: 'claude-haiku-4-5', label: 'Haiku 4.5', efforts: ['high'], custom: false }], efforts: ['high'] };
  const state = { previews: [], patches: [], bodies: [], preview: PREVIEW, snap: null };
  const base = handler(state);
  const ctx = makePanel({ fetchHandler: (url, opts) => (url === '/api/ask/models' ? { ok: true, status: 200, json: async () => CAT } : base(url, opts)) });
  ctx.panel.open();
  await settle(ctx);
  ctx.doc.querySelector('[data-ask-model-btn]').click();
  await settle(ctx);
  [...ctx.doc.querySelectorAll('.ask-pop-model [role="menuitem"]')].find((i) => /Haiku/.test(i.textContent)).click();
  await settle(ctx);
  assert.equal(state.previews.at(-1).model, 'claude-haiku-4-5');
  ctx.panel.destroy();
});

test('a catalog that repairs the composer model re-previews with the repaired model (it sets the §5.6 tool-name limit)', async () => {
  // The backend default (D8) is not the cold-start pick: the first preview leaves before the catalog lands.
  const CAT = { models: [{ id: 'claude-haiku-4-5', label: 'Haiku 4.5', efforts: ['high'], custom: false }], efforts: ['high'], default: { model: 'claude-haiku-4-5', effort: 'high' } };
  const state = { previews: [], patches: [], bodies: [], preview: PREVIEW, snap: null };
  const base = handler(state);
  const ctx = makePanel({ fetchHandler: (url, opts) => (url === '/api/ask/models' ? { ok: true, status: 200, json: async () => CAT } : base(url, opts)) });
  ctx.panel.open();
  await settle(ctx);
  assert.equal(state.previews[0].model, 'claude-opus-5-5', 'precondition: the first preview left with the cold-start model');
  assert.equal(state.previews.at(-1).model, 'claude-haiku-4-5', 'the repaired model re-previews');
  ctx.panel.destroy();
});

test('keyboard: a toggle and the preview that follows keep focus on the same switch', async () => {
  const { ctx } = setup();
  ctx.panel.open();
  await settle(ctx);
  btn(ctx).click();
  await settle(ctx);
  const shop = () => pop(ctx).querySelectorAll('.ask-mcp-row')[2].children[0];
  shop().focus();
  key(ctx.window, shop(), ' ');                                              // Shop off: re-renders now and when the preview lands
  await settle(ctx);
  assert.equal(ctx.doc.activeElement, shop(), 'focus stays on the toggled switch');
  key(ctx.window, ctx.doc.activeElement, ' ');                               // a second Space undoes it, not General
  await settle(ctx);
  assert.equal(shop().getAttribute('aria-checked'), 'true');
  assert.equal(pop(ctx).querySelectorAll('.ask-mcp-row')[0].children[0].getAttribute('aria-checked'), 'true');
  const input = ctx.doc.querySelector('textarea.ask-input');
  input.focus();
  ctx.window.dispatchEvent(new ctx.window.Event('hashchange'));             // a preview lands while the user types
  await settle(ctx);
  assert.equal(ctx.doc.activeElement, input, 'a landing preview never pulls focus into the picker');
  ctx.panel.destroy();
});

test('level 2: a member this chat switched off (skipped chat-off) stays a live switch and turns back on', async () => {
  const { state, ctx } = setup();
  ctx.panel.open();
  await settle(ctx);
  btn(ctx).click();
  await settle(ctx);
  pop(ctx).querySelectorAll('.ask-mcp-row')[1].children[1].click();          // drill into Billing
  const sw = () => [...pop(ctx).querySelectorAll('.ask-mcp-row')].find((r) => r.querySelector('.ask-mcp-copy')?.textContent === 'sentry_billing')?.querySelector('[role="menuitemcheckbox"]');
  state.preview = { ...PREVIEW, started: 6, copies: PREVIEW.copies.filter((c) => c.name !== 'sentry_billing'),
    skipped: [...PREVIEW.skipped, { setId: 'billing', setName: 'Billing', serverId: 'plugin:acme-tools/sentry', copy: 'sentry_billing', reason: 'chat-off', why: 'switched off for this chat' }] };
  sw().click();                                                              // off; the preview now reports it chat-off
  await settle(ctx);
  assert.ok(sw(), 'still a switch row');
  assert.equal(sw().disabled, false);
  assert.equal(sw().getAttribute('aria-checked'), 'false');
  sw().click();                                                              // back on
  await settle(ctx);
  assert.deepEqual(state.previews.at(-1).mcpOff, { sets: [], members: [] });
  ctx.panel.destroy();
});

test('level 2: with its whole set off in this chat, a member switch is disabled, reads off and says why', async () => {
  const { ctx } = setup();
  ctx.panel.open();
  await settle(ctx);
  btn(ctx).click();
  await settle(ctx);
  pop(ctx).querySelectorAll('.ask-mcp-row')[1].children[0].click();          // Billing off
  await settle(ctx);
  pop(ctx).querySelectorAll('.ask-mcp-row')[1].children[1].click();          // drill into Billing
  const sws = [...pop(ctx).querySelectorAll('.ask-mcp-row [role="menuitemcheckbox"]')];
  assert.equal(sws.length, 2);
  for (const sw of sws) {
    assert.equal(sw.disabled, true);
    assert.equal(sw.getAttribute('aria-checked'), 'false');
    assert.equal(sw.title, 'Billing is off in this chat');
  }
  ctx.panel.destroy();
});

test('choices: a refused first message (429) leaves no thread-stored choice behind — the resend carries them again', async () => {
  let n = 0;
  const state = { previews: [], patches: [], bodies: [], preview: PREVIEW, snap: null };
  const base = handler(state);
  const ctx = makePanel({ fetchHandler: (url, opts) => {
    if (url === `/api/ask/threads/${TID}/messages` && ++n === 1) return { ok: false, status: 429, json: async () => ({ error: 'at most 3 turns may run at once' }) };
    return base(url, opts);
  }, getPageContext: () => ({ view: 'projects', projectKey: 'billing-00000001' }) });
  ctx.panel.open();
  await settle(ctx);
  btn(ctx).click(); await settle(ctx);
  pop(ctx).querySelectorAll('.ask-mcp-row')[1].children[0].click();          // Billing off, held (no thread yet)
  btn(ctx).click();
  for (const text of ['first', 'again']) {
    ctx.doc.querySelector('textarea.ask-input').value = text;
    ctx.doc.querySelector('[data-ask-send]').click();
    await settle(ctx);
  }
  assert.deepEqual(state.bodies[0].mcpOff, { sets: ['billing'], members: [] }, 'the resend carries the choices the picker shows');
  ctx.panel.destroy();
});

test('choices: toggle PATCHes go one at a time, in order — the stored value is the last choice', async () => {
  const snap = { thread: { id: TID, title: 'T', createdAt: 't', updatedAt: 't', model: null, effort: null, sessionId: null, context: null, totals: {}, mcpOff: null },
    messages: [], attachments: [], runLinks: [], worktrees: [], inFlight: null };
  const held = [];
  const state = { previews: [], patches: [], bodies: [], preview: PREVIEW, snap };
  const base = handler(state);
  const ctx = makePanel({ fetchHandler: (url, opts) => {
    if (url === `/api/ask/threads/${TID}` && ((opts || {}).method || 'GET').toUpperCase() === 'PATCH') {
      state.patches.push(JSON.parse(opts.body));
      return new Promise((r) => held.push(() => r({ ok: true, status: 200, json: async () => ({ thread: { id: TID } }) })));
    }
    return base(url, opts);
  }, getPageContext: () => ({ view: 'projects', projectKey: 'billing-00000001' }) });
  ctx.storage.setItem('worca-cc.ask.thread', TID);
  ctx.panel.open();
  await settle(ctx);
  btn(ctx).click(); await settle(ctx);
  const sw = (i) => pop(ctx).querySelectorAll('.ask-mcp-row')[i].children[0];
  sw(0).click(); await settle(ctx);                                          // General off
  sw(1).click(); sw(2).click(); await settle(ctx);                           // Billing, Shop off while that PATCH is out
  assert.equal(state.patches.length, 1, 'one PATCH in flight at a time');
  while (held.length) { held.shift()(); await settle(ctx); }
  assert.deepEqual(state.patches.map((p) => p.mcpOff.sets), [['general'], ['general', 'billing'], ['general', 'billing', 'shop']]);
  ctx.panel.destroy();
});

test('a failed preview says so in the open picker', async () => {
  const { state, ctx } = setup();
  ctx.panel.open();
  await settle(ctx);
  btn(ctx).click();
  await settle(ctx);
  state.preview = null;                                                      // the next preview answers no body
  ctx.window.dispatchEvent(new ctx.window.Event('hashchange'));
  await settle(ctx);
  assert.match(pop(ctx).textContent, /Could not load the MCP servers — reopen to retry\./);
  ctx.panel.destroy();
});

test('keyboard: a preview landing keeps focus on the Manage footer', async () => {
  const { ctx } = setup();
  ctx.panel.open();
  await settle(ctx);
  btn(ctx).click();
  await settle(ctx);
  key(ctx.window, ctx.doc.activeElement, 'End');
  assert.match(ctx.doc.activeElement.textContent, /^Manage in Settings/);
  ctx.window.dispatchEvent(new ctx.window.Event('hashchange'));             // in Auto: a page change re-previews
  await settle(ctx);
  assert.match(ctx.doc.activeElement.textContent, /^Manage in Settings/, 'still on the footer');
  ctx.panel.destroy();
});

test('a failed preview keeps the chip, so the picker can be reopened to retry', async () => {
  const { state, ctx } = setup();
  ctx.panel.open();
  await settle(ctx);
  btn(ctx).click();
  await settle(ctx);
  state.preview = null;                                                      // the next preview fails
  ctx.window.dispatchEvent(new ctx.window.Event('hashchange'));
  await settle(ctx);
  assert.match(pop(ctx).textContent, /reopen to retry/);
  assert.equal(btn(ctx).hidden, false, 'the chip the message tells the user to reopen is still there');
  assert.equal(btn(ctx).textContent.trim(), 'MCP · ?');
  state.preview = PREVIEW;
  btn(ctx).click(); btn(ctx).click();                                        // close, reopen: a fresh preview
  await settle(ctx);
  assert.equal(pop(ctx).querySelectorAll('.ask-mcp-row').length, 4);
  assert.equal(btn(ctx).textContent.trim(), 'MCP · 7');
  ctx.panel.destroy();
});

test('choices: a reconnect resync of the same thread keeps the choices the picker holds (their PATCH may not have landed)', async () => {
  const snap = { thread: { id: TID, title: 'T', createdAt: 't', updatedAt: 't', model: null, effort: null, sessionId: null, context: null, totals: {}, mcpOff: null },
    messages: [], attachments: [], runLinks: [], worktrees: [], inFlight: null };
  const held = [];
  const state = { previews: [], patches: [], bodies: [], preview: PREVIEW, snap };
  const base = handler(state);
  const ctx = makePanel({ fetchHandler: (url, opts) => {
    if (url === `/api/ask/threads/${TID}` && ((opts || {}).method || 'GET').toUpperCase() === 'PATCH') {
      state.patches.push(JSON.parse(opts.body));
      return new Promise((r) => held.push(() => r({ ok: true, status: 200, json: async () => ({ thread: { id: TID } }) })));
    }
    return base(url, opts);
  }, getPageContext: () => ({ view: 'projects', projectKey: 'billing-00000001' }) });
  ctx.storage.setItem('worca-cc.ask.thread', TID);
  ctx.panel.open();
  await settle(ctx);
  btn(ctx).click(); await settle(ctx);
  pop(ctx).querySelectorAll('.ask-mcp-row')[1].children[0].click();          // Billing off; its PATCH has not landed
  await settle(ctx);
  ctx.panel.onHello([]);                                                     // a reconnect: resync → loadThread of the same thread
  await settle(ctx); ctx.flush(); await settle(ctx);
  assert.deepEqual(state.previews.at(-1).mcpOff, { sets: ['billing'], members: [] }, 'the resync kept the held choice');
  ctx.doc.querySelector('textarea.ask-input').value = 'hi';
  ctx.doc.querySelector('[data-ask-send]').click();
  await settle(ctx);
  assert.deepEqual(state.bodies.at(-1).mcpOff, { sets: ['billing'], members: [] });
  while (held.length) { held.shift()(); await settle(ctx); }
  ctx.panel.destroy();
});

test('choices: a queued toggle PATCH still goes to the thread it was made in after New chat and a send', async () => {
  const snap = { thread: { id: TID, title: 'T', createdAt: 't', updatedAt: 't', model: null, effort: null, sessionId: null, context: null, totals: {}, mcpOff: null },
    messages: [], attachments: [], runLinks: [], worktrees: [], inFlight: null };
  const TID_B = 'ask_00000002';
  const held = []; const urls = [];
  const state = { previews: [], patches: [], bodies: [], preview: PREVIEW, snap };
  const base = handler(state);
  const ctx = makePanel({ fetchHandler: (url, opts) => {
    const method = ((opts || {}).method || 'GET').toUpperCase();
    if (/^\/api\/ask\/threads\/ask_[0-9a-f]{8}$/.test(url) && method === 'PATCH') {
      urls.push(url);
      return new Promise((r) => held.push(() => r({ ok: true, status: 200, json: async () => ({ thread: {} }) })));
    }
    if (url === '/api/ask/threads' && method === 'POST') return { ok: true, status: 201, json: async () => ({ thread: { id: TID_B, title: null, createdAt: 't', updatedAt: 't', model: null, effort: null, sessionId: null, context: null, totals: {} } }) };
    if (url === `/api/ask/threads/${TID_B}/messages` && method === 'POST') return { ok: true, status: 202, json: async () => ({ userMessageId: 'askm_u0000002', assistantMessageId: 'askm_00000002' }) };
    return base(url, opts);
  }, getPageContext: () => ({ view: 'projects', projectKey: 'billing-00000001' }) });
  ctx.storage.setItem('worca-cc.ask.thread', TID);
  ctx.panel.open();
  await settle(ctx);
  btn(ctx).click(); await settle(ctx);
  pop(ctx).querySelectorAll('.ask-mcp-row')[0].children[0].click(); await settle(ctx);   // General off (its PATCH held)
  pop(ctx).querySelectorAll('.ask-mcp-row')[1].children[0].click(); await settle(ctx);   // Billing off (queued behind it)
  ctx.doc.querySelector('[data-ask-new-btn]').click(); await settle(ctx);               // New chat
  ctx.doc.querySelector('textarea.ask-input').value = 'hi';
  ctx.doc.querySelector('[data-ask-send]').click(); await settle(ctx);                  // creates thread B
  while (held.length) { held.shift()(); await settle(ctx); }
  assert.deepEqual(urls, [`/api/ask/threads/${TID}`, `/api/ask/threads/${TID}`], 'both toggles PATCH the thread they were made in');
  ctx.panel.destroy();
});

test('choices: a toggle made while a message POST is out is PATCHed again after the 202 (the route stores the body it read)', async () => {
  const snap = { thread: { id: TID, title: 'T', createdAt: 't', updatedAt: 't', model: null, effort: null, sessionId: null, context: null, totals: {}, mcpOff: null },
    messages: [], attachments: [], runLinks: [], worktrees: [], inFlight: null };
  let release;
  const order = [];
  const state = { previews: [], patches: [], bodies: [], preview: PREVIEW, snap };
  const base = handler(state);
  const ctx = makePanel({ fetchHandler: (url, opts) => {
    const method = ((opts || {}).method || 'GET').toUpperCase();
    if (url === `/api/ask/threads/${TID}/messages` && method === 'POST') {
      order.push(['POST', JSON.parse(opts.body).mcpOff]);
      return new Promise((r) => { release = () => r({ ok: true, status: 202, json: async () => ({ userMessageId: 'askm_u0000001', assistantMessageId: 'askm_00000001' }) }); });
    }
    if (url === `/api/ask/threads/${TID}` && method === 'PATCH') order.push(['PATCH', JSON.parse(opts.body).mcpOff]);
    return base(url, opts);
  }, getPageContext: () => ({ view: 'projects', projectKey: 'billing-00000001' }) });
  ctx.storage.setItem('worca-cc.ask.thread', TID);
  ctx.panel.open();
  await settle(ctx);
  ctx.doc.querySelector('textarea.ask-input').value = 'hi';
  ctx.doc.querySelector('[data-ask-send]').click(); await settle(ctx);      // the POST is out with every server on
  btn(ctx).click(); await settle(ctx);
  pop(ctx).querySelectorAll('.ask-mcp-row')[1].children[0].click(); await settle(ctx);   // Billing off while it is out
  order.push(['202']);
  release(); await settle(ctx);
  assert.deepEqual(order, [
    ['POST', { sets: [], members: [] }], ['PATCH', { sets: ['billing'], members: [] }],
    ['202'], ['PATCH', { sets: ['billing'], members: [] }],
  ], 'the latest choice is the last write, whatever order the route and the first PATCH land in');
  ctx.panel.destroy();
});

test('keyboard: ‹ back returns focus to the drill button of the set it left', async () => {
  const { ctx } = setup();
  ctx.panel.open();
  await settle(ctx);
  btn(ctx).click();
  await settle(ctx);
  const shopDrill = pop(ctx).querySelectorAll('.ask-mcp-row')[2].children[1];
  shopDrill.focus();
  key(ctx.window, shopDrill, 'Enter');                                       // into Shop
  assert.equal(ctx.doc.activeElement.textContent, '‹ Shop');
  key(ctx.window, ctx.doc.activeElement, 'Enter');                           // ‹ Shop
  assert.equal(ctx.doc.activeElement.dataset.mcpKey, 'drill:shop');
  ctx.panel.destroy();
});

test('level 2: the switch rows come first, then the disabled rows (Appendix B 10); a landed preview with no sets is not "Loading…"', async () => {
  const { state, ctx } = setup();
  ctx.panel.open();
  await settle(ctx);
  btn(ctx).click();
  await settle(ctx);
  pop(ctx).querySelectorAll('.ask-mcp-row')[1].children[1].click();          // drill into Billing
  const kinds = [...pop(ctx).children].filter((n) => n.classList.contains('ask-mcp-row') || n.classList.contains('is-skipped'))
    .map((n) => (n.classList.contains('is-skipped') ? 'skipped' : 'switch'));
  assert.deepEqual(kinds, ['switch', 'switch', 'skipped']);
  btn(ctx).click();                                                          // close
  state.preview = { sets: [], copies: [], skipped: [], skippedTools: [], started: 0, newer: true };
  btn(ctx).click(); await settle(ctx);                                       // reopen (e.g. from a notice): the preview lands empty
  assert.match(pop(ctx).textContent, /No MCP servers in play\./);
  assert.doesNotMatch(pop(ctx).textContent, /Loading/);
  ctx.panel.destroy();
});
