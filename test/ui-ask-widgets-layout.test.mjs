// test/ui-ask-widgets-layout.test.mjs — the layout containers (ask-forms §6.1)
// and the versioning path (§10): requires -> fallback -> nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderAskForm } from '../ui/public/ask/form-renderer.mjs';
import { checkRows } from './helpers/rows.mjs';

const win = new JSDOM('<!doctype html><body></body>').window;
const doc = win.document;
const click = (n) => n.dispatchEvent(new win.Event('click', { bubbles: true }));

const askOf = (layout, properties = {}, required = []) => ({
  id: 'q:1', askId: 'q_1', kind: 'form', form: 'f', version: 1, title: 'T', surface: 'any',
  data: { msg: 'body' }, files: [], fileRefs: [], layout,
  answerSchema: { type: 'object', required, properties },
});
const mount = (ask, opts = {}) => renderAskForm(ask, { doc, ...opts });

test('nested fields inside a group or a hidden tab are collected and counted', async () => {
  await checkRows([
    { name: 'group: a titled section that still collects its children', run: () => {
      const f = mount(askOf(
        [{ widget: 'group', title: 'Details', children: [
          { widget: 'text', field: 'who', label: 'Reviewer' },
          { widget: 'markdown', bind: 'data.msg' },
        ] }],
        { who: { type: 'string' } }, ['who'],
      ));
      const grp = f.el.querySelector('.af-grp');
      assert.equal(grp.querySelector('.af-grp-title').textContent, 'Details');
      assert.ok(grp.querySelector('.af-md'));
      const input = grp.querySelector('input[type="text"]');
      input.value = 'dp';
      input.dispatchEvent(new win.Event('input'));
      assert.equal(f.snapshot().who, 'dp');
      assert.deepEqual(f.progress(), { done: 1, total: 1 }, 'a nested required field is counted');
    } },
    { name: 'a field inside a hidden tab is still collected (tabs are chrome, not `when`)', run: () => {
      const f = mount(askOf([{ widget: 'tabs', tabs: [
        { label: 'One', children: [{ widget: 'callout', text: 'first' }] },
        { label: 'Two', children: [{ widget: 'text', field: 'n', label: 'Name' }] },
      ] }], { n: { type: 'string', minLength: 2 } }, ['n']));
      assert.deepEqual(f.progress(), { done: 0, total: 1 });
      f.setValue('n', 'dp');
      assert.deepEqual(f.collect(), { values: { n: 'dp' }, errors: [] });
    } },
  ]);
});

test('tabs: clicking a tab shows its panel and hides the others', () => {
  const f = mount(askOf([{ widget: 'tabs', tabs: [
    { label: 'One', children: [{ widget: 'callout', text: 'first' }] },
    { label: 'Two', children: [{ widget: 'text', field: 'n', label: 'Name' }] },
    { label: 'Three', children: [{ widget: 'callout', text: 'third' }] },
  ] }], { n: { type: 'string' } }));
  const tabs = [...f.el.querySelectorAll('[role="tab"]')];
  const panes = [...f.el.querySelectorAll('[role="tabpanel"]')];
  click(tabs[1]);
  assert.deepEqual(panes.map((p) => p.hidden), [true, false, true]);
  click(tabs[2]);
  assert.deepEqual(panes.map((p) => p.hidden), [true, true, false]);
});

test('requires/fallback: an unmet item draws its fallback; with none it draws nothing', () => {
  const layout = [
    { widget: 'compare', before: 'data.a', after: 'data.b', requires: { askCatalog: 99 },
      fallback: { widget: 'callout', text: 'two images' } },
    { widget: 'not-a-widget', label: 'nope' },
  ];
  const f = mount(askOf(layout));
  assert.equal(f.el.querySelectorAll('.af-callout').length, 1);
  assert.match(f.el.textContent, /two images/);
  assert.equal(f.el.children.length, 1, 'the unknown widget with no fallback drew nothing at all');
  assert.doesNotMatch(f.el.textContent, /not-a-widget|nope/, 'and no host prose about it');
});
