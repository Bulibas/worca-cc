// test/ui-schedule-sheet-sync.test.mjs
// Sync before run (#527, plan D16): the schedule sheet's Sync block is opt-in. Only a caller that
// passes `sync` gets it, and the result carries only the controls the person actually set, so a
// scheduled workspace run never overrides a member's own onDiverged / beforeRun.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const sheetPath = fileURLToPath(new URL('../ui/public/schedule-sheet.mjs', import.meta.url));
const tick = (n = 1) => new Promise((r) => setTimeout(r, n));

async function open(opts) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  const { window } = dom;
  for (const k of ['window', 'document', 'Node', 'HTMLElement', 'Event', 'KeyboardEvent']) {
    try { Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true }); } catch {}
  }
  const mod = await import(pathToFileURL(sheetPath).href + `?b=${Date.now()}_${Math.random()}`);
  const done = mod.openScheduleSheet(opts);
  await tick(2);
  return { doc: window.document, window, done, mod };
}
const later = () => new Date(Date.now() + 3 * 3600_000).toISOString();
const SINGLE = { show: true, beforeRun: null, shownBeforeRun: true, onDiverged: 'origin' };
const options = (sel) => [...sel.options].map((o) => o.value);

test('with sync: toggling both controls puts both in the result', async () => {
  const { doc, window, done } = await open({ mode: 'create', initial: { scheduledFor: later() }, sync: SINGLE });
  const sw = doc.getElementById('sched-sync-auto');
  const sel = doc.getElementById('sched-sync-diverged');
  assert.ok(sw && sel, 'the Sync block is rendered');
  assert.equal(sw.checked, true, 'opens on what the form switch shows');
  assert.deepEqual(options(sel), ['origin', 'fail'], 'no "Project setting" when the project value is known');
  assert.equal(sel.value, 'origin');
  sw.checked = false; sw.dispatchEvent(new window.Event('change', { bubbles: true }));
  sel.value = 'fail'; sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  doc.querySelector('.sched-ok').click();
  const out = await done;
  assert.ok(out.scheduledFor);
  assert.deepEqual(out.sync, { beforeRun: false, onDiverged: 'fail' });
});

test('with sync and nothing touched (form switch untouched too): no sync key', async () => {
  const { doc, done } = await open({ mode: 'create', initial: { scheduledFor: later() }, sync: SINGLE });
  doc.querySelector('.sched-ok').click();
  const out = await done;
  assert.ok(out.scheduledFor);
  assert.equal('sync' in out, false);
});

test('the form switch was touched (sync.beforeRun boolean): it is carried even if the sheet is not', async () => {
  const { doc, done } = await open({ mode: 'create', initial: { scheduledFor: later() },
    sync: { show: true, beforeRun: false, shownBeforeRun: false, onDiverged: 'origin' } });
  assert.equal(doc.getElementById('sched-sync-auto').checked, false);
  doc.querySelector('.sched-ok').click();
  assert.deepEqual((await done).sync, { beforeRun: false });
});

test('reopening: initial.sync wins over the form and is carried again', async () => {
  const { doc, done } = await open({ mode: 'create', initial: { scheduledFor: later(), sync: { beforeRun: true, onDiverged: 'fail' } },
    sync: { show: true, beforeRun: null, shownBeforeRun: false, onDiverged: 'origin' } });
  assert.equal(doc.getElementById('sched-sync-auto').checked, true);
  assert.equal(doc.getElementById('sched-sync-diverged').value, 'fail');
  doc.querySelector('.sched-ok').click();
  assert.deepEqual((await done).sync, { beforeRun: true, onDiverged: 'fail' });
});

test('without the option: no Sync block and no sync key (every result shape unchanged)', async () => {
  const { doc, done } = await open({ mode: 'create', initial: { scheduledFor: later() } });
  assert.equal(doc.getElementById('sched-sync-auto'), null);
  assert.equal(doc.getElementById('sched-sync-diverged'), null);
  doc.querySelector('.sched-ok').click();
  assert.equal('sync' in (await done), false);
});

test('show:false (Simple level / hidden row): no block, no key', async () => {
  const { doc, done } = await open({ mode: 'create', initial: { scheduledFor: later() }, sync: { ...SINGLE, show: false, beforeRun: false } });
  assert.equal(doc.getElementById('sched-sync-auto'), null);
  doc.querySelector('.sched-ok').click();
  assert.equal('sync' in (await done), false);
});

test('workspace (onDiverged null), sheet untouched: select opens on Project setting, result has no sync key', async () => {
  const { doc, done } = await open({ mode: 'create', initial: { scheduledFor: later() },
    sync: { show: true, beforeRun: null, shownBeforeRun: true, onDiverged: null } });
  const sel = doc.getElementById('sched-sync-diverged');
  assert.deepEqual(options(sel), ['', 'origin', 'fail']);
  assert.equal(sel.value, '');
  assert.equal(sel.options[0].textContent, 'Project setting');
  doc.querySelector('.sched-ok').click();
  assert.equal('sync' in (await done), false);
});

test('workspace: picking a policy carries it; picking Project setting again carries nothing', async () => {
  const a = await open({ mode: 'create', initial: { scheduledFor: later() }, sync: { show: true, beforeRun: null, shownBeforeRun: true, onDiverged: null } });
  const sel = a.doc.getElementById('sched-sync-diverged');
  sel.value = 'origin'; sel.dispatchEvent(new a.window.Event('change', { bubbles: true }));
  a.doc.querySelector('.sched-ok').click();
  assert.deepEqual((await a.done).sync, { onDiverged: 'origin' });
  const b = await open({ mode: 'create', initial: { scheduledFor: later() }, sync: { show: true, beforeRun: null, shownBeforeRun: true, onDiverged: null } });
  const s2 = b.doc.getElementById('sched-sync-diverged');
  s2.value = 'fail'; s2.dispatchEvent(new b.window.Event('change', { bubbles: true }));
  s2.value = ''; s2.dispatchEvent(new b.window.Event('change', { bubbles: true }));
  b.doc.querySelector('.sched-ok').click();
  assert.equal('sync' in (await b.done), false);
});

test('a recurring result carries sync too', async () => {
  const { doc, window, done } = await open({ mode: 'create', sync: SINGLE });
  doc.querySelector('button[data-preset="daily"]').click();
  const sw = doc.getElementById('sched-sync-auto');
  sw.checked = false; sw.dispatchEvent(new window.Event('change', { bubbles: true }));
  doc.querySelector('.sched-ok').click();
  const out = await done;
  assert.ok(out.repeat);
  assert.deepEqual(out.sync, { beforeRun: false });
});

test('the Auto-sync switch row beats `.field > label` (flex, not a block label)', async () => {
  const { doc, window, done } = await open({ mode: 'create', initial: { scheduledFor: later() }, sync: SINGLE });
  const row = doc.getElementById('sched-sync-auto').closest('label');
  assert.ok(row.classList.contains('switch-row'));
  assert.ok(row.parentElement.classList.contains('field'), 'a direct child of .field, so `.field > label` claims it');
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  await done;
  // `.field > label` (0,1,1) sets display:block and beats `.switch-row` (0,1,0): the switch
  // span then collapses (no track) and its knob lands on the text. A qualified rule must win.
  const css = readFileSync(fileURLToPath(new URL('../ui/public/style.css', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(([, sel]) => sel.split(',').some((x) => x.trim() === '.field > label.switch-row'));
  assert.ok(rule, 'a `.field > label.switch-row` rule exists');
  assert.match(rule[2], /display:\s*flex/);
  assert.match(rule[2], /margin-bottom:\s*0/);
});
