// test/composer-save-feedback.test.mjs — #555: with an injected `notify`, the composer's
// save dialog reports through feedback.mjs. Save is a withButton (Saving… → Saved), an
// empty name is a fieldError on the name input, a server refusal is a cardAlert above the
// dialog's button row, and a success closes the dialog and raises "Pipeline saved".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shell, API, RECT } from './helpers/composer-shell.mjs';
import { fixture, portsFn } from './helpers/graph-view-fixture.mjs';
import { checkRows } from './helpers/rows.mjs';

const composerPath = new URL('../ui/public/graph/composer.mjs', import.meta.url).href;

async function open({ api = {}, notify } = {}) {
  const s = shell();
  const { createComposer } = await import(composerPath);
  const c = createComposer(s.hostEls, {
    doc: s.doc, api: { ...API, ...api }, raf: s.raf, viewport: () => ({ ...RECT }), storage: null, portsFn, notify,
  });
  c.mount();
  c.loadTemplate(fixture());
  return { ...s, c };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function openDialog(s, name = 'Mine') {
  s.el.save.dispatchEvent(new s.win.MouseEvent('click', { bubbles: true }));
  const dlg = s.el.dialogHost.querySelector('dialog.save-dialog');
  dlg.querySelector('.sd-name').value = name;
  return dlg;
}
const clickSave = (s, dlg) => dlg.querySelector('.sd-confirm').dispatchEvent(new s.win.MouseEvent('click', { bubbles: true }));

test('composer save: a 400, a 422 or a thrown save is a card alert; Save returns to idle and the dialog stays dirty', async () => {
  await checkRows([
    { name: 'composer save: a 400 refusal shows a card alert above the button row and Save returns to idle', run: async () => {
      const calls = [];
      let release;
      const gate = new Promise((r) => { release = r; });
      const s = await open({
        notify: (o) => calls.push(o),
        api: { saveWorkflow: async () => { await gate; return { ok: false, status: 400, error: 'the name is taken' }; } },
      });
      s.c.setName('Dirty one');
      const dlg = openDialog(s);
      const btn = dlg.querySelector('.sd-confirm');
      clickSave(s, dlg);
      assert.equal(btn.dataset.fbState, 'busy', 'Save shows Saving… while the POST runs');
      assert.equal(btn.disabled, true);
      release();
      await tick(); await tick();
      const alert = dlg.querySelector('.card-alert.err');
      assert.ok(alert, 'card alert rendered');
      assert.equal(alert.querySelector('.ca-title').textContent, 'Not saved');
      assert.equal(alert.querySelector('.ca-detail').textContent, 'the name is taken');
      assert.equal(alert.nextElementSibling, dlg.querySelector('.sd-actions'), 'the alert sits right above the button row');
      assert.equal(btn.dataset.fbState, undefined, 'Save back to idle');
      assert.equal(btn.disabled, false);
      assert.equal(btn.textContent, 'Save');
      assert.ok(dlg.hasAttribute('open') || dlg.open, 'dialog stays open');
      assert.equal(calls.length, 0, 'no toast for a refusal');
      assert.equal(s.c.isDirty(), true);
    } },
    { name: 'composer save: 422 issues are the card alert detail, verbatim', run: async () => {
      const s = await open({
        notify: () => {},
        api: { saveWorkflow: async () => ({ ok: false, status: 422, issues: [{ code: 'V21', message: 'exactly one end node is required' }] }) },
      });
      const dlg = openDialog(s);
      clickSave(s, dlg);
      await tick(); await tick();
      assert.equal(dlg.querySelector('.card-alert .ca-detail').textContent, 'V21: exactly one end node is required');
    } },
    { name: 'composer save: a thrown save is a card alert too', run: async () => {
      const s = await open({ notify: () => {}, api: { saveWorkflow: async () => { throw new Error('network down'); } } });
      const dlg = openDialog(s);
      clickSave(s, dlg);
      await tick(); await tick();
      assert.equal(dlg.querySelector('.card-alert .ca-detail').textContent, 'network down');
      assert.equal(dlg.querySelector('.sd-confirm').dataset.fbState, undefined);
    } },
  ]);
});

test('composer save: empty name is a field error before any POST; success closes with Saved', async () => {
  await checkRows([
    { name: 'composer save: an empty name is a field error on the name input, before any POST', run: async () => {
      let posts = 0;
      const s = await open({ notify: () => {}, api: { saveWorkflow: async () => { posts += 1; return { ok: true, workflow: { id: 'x' } }; } } });
      const dlg = openDialog(s, '   ');
      clickSave(s, dlg);
      await tick();
      assert.equal(posts, 0);
      const input = dlg.querySelector('.sd-name');
      assert.equal(input.getAttribute('aria-invalid'), 'true');
      assert.match(dlg.querySelector('.field-error').textContent, /Name is required/);
      assert.equal(dlg.querySelector('.sd-confirm').dataset.fbState, undefined, 'Save never went busy');
    } },
    { name: 'composer save: success closes the dialog, shows Saved and raises "Pipeline saved"', run: async () => {
      const calls = [];
      const s = await open({ notify: (o) => calls.push(o), api: { saveWorkflow: async (b) => ({ ok: true, workflow: { id: 'wf_mine', ...b } }) } });
      s.c.setName('Dirty one');
      const dlg = openDialog(s);
      const btn = dlg.querySelector('.sd-confirm');
      clickSave(s, dlg);
      await tick(); await tick();
      assert.equal(btn.dataset.fbState, 'done', 'Save shows the Saved state');
      assert.match(btn.textContent, /Saved/);
      assert.ok(!(dlg.hasAttribute('open') || dlg.open), 'dialog closed');
      assert.deepEqual(calls, [{ tone: 'ok', title: 'Pipeline saved' }]);
      assert.equal(s.c.isDirty(), false);
    } },
  ]);
});
