// test/ui-graph-interactions.test.mjs — MAJ-30.
// jsdom ports of the MECHANICAL half of the behaviours that were asserted only
// inside tools/verify-composer-cdp.mjs and tools/verify-run-monitor-cdp.mjs
// — two scripts no automation runs (see the CI-COVERAGE header block in each).
//
// Ported here: the wheel preventDefault policy on BOTH canvases and the two pan
// gestures that had no automated guard anywhere (middle-button and space+drag).
//
// NOT ported, and deliberately so: everything whose assertion is a MEASUREMENT.
// jsdom has no layout engine — every getBoundingClientRect is 0×0 — so the rail's
// 340px width and its flush right edge, single-column palette pills, the pinned
// filter head, the legend footer span, the 22px card gap, stage-box stability
// through a wheel sequence, post-fit containment and the .nrun/.ngate em-box
// clearance can only be proven in a real browser. Those stay CDP-only; the two
// scripts' headers list them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createGraphView } from '../ui/public/graph/view.mjs';
import { manifestPortsFn, manifestTemplate } from '../src/shared/graph/manifest.mjs';
import { open } from './helpers/composer-shell.mjs';
import { checkRows } from './helpers/rows.mjs';

// The same two-card manifest test/ui-run-hosts.test.mjs mounts: one agent, one
// End, and w1 carrying a maxCycles budget (which is what mints a `.wbadge`).
const MANIFEST = {
  version: 2, template: { id: 'wf_t', name: 'T' },
  graph: {
    nodes: [
      { id: 'n_a', kind: 'agent', key: 'planner', x: 0, y: 0, label: 'Planner', color: 'violet',
        ports: { inputs: [{ id: 'task', type: 'md', loop: false }], outputs: [{ id: 'plan', type: 'md', when: 'always' }], await: true } },
      { id: 'n_end', kind: 'end', key: null, x: 400, y: 0, label: 'End', color: '',
        ports: { inputs: [{ id: 'result', type: 'any' }], outputs: [], await: false } },
    ],
    wires: [{ id: 'w1', from: { node: 'n_a', port: 'plan' }, to: { node: 'n_end', port: 'result' }, loop: true, maxCycles: 3 }],
  },
};

function mountView(mode = 'monitor') {
  const dom = new JSDOM('<!doctype html><div id="h" style="width:800px;height:400px"></div>');
  const { window } = dom;
  const host = window.document.getElementById('h');
  const view = createGraphView(host, {
    mode, doc: window.document, portsFn: manifestPortsFn(MANIFEST), agents: {},
    raf: (fn) => { fn(); return 1; },
    viewport: () => ({ left: 0, top: 0, width: 800, height: 400 }),
  });
  view.render(manifestTemplate(MANIFEST), {});
  return { window, doc: window.document, host, view };
}

const wheelOn = (win, el, o) => {
  const ev = new win.WheelEvent('wheel', { bubbles: true, cancelable: true, ...o });
  el.dispatchEvent(ev);
  return ev;
};
const pev = (win, type, o) => new win.PointerEvent(type, { pointerId: 1, bubbles: true, cancelable: true, ...o });

// ─── wheel preventDefault: the composer, then the run monitor ────────────────
// CDP: verify-composer-cdp.mjs check(6) `prevented`.

test('wheel ownership: the composer swallows every wheel, the monitor only ctrl/meta (a plain wheel scrolls the page); destroy() gives it back', async () => {
  await checkRows([
    { name: 'the composer canvas swallows EVERY wheel — plain, ctrl and meta — and gives it back on destroy()', run: async () => {
      const s = await open();
      s.c.view.setTransform({ x: 0, y: 0, z: 1 });
      for (const o of [{ deltaY: -120 }, { deltaX: 40, deltaY: 0 }, { deltaY: -120, ctrlKey: true }, { deltaY: -120, metaKey: true }]) {
        const ev = wheelOn(s.win, s.c.view.stage, { clientX: 600, clientY: 300, ...o });
        assert.equal(ev.defaultPrevented, true, `the page must never scroll under the canvas: ${JSON.stringify(o)}`);
      }
      s.c.destroy();
      const after = wheelOn(s.win, s.c.view.stage, { clientX: 600, clientY: 300, deltaY: -120 });
      assert.equal(after.defaultPrevented, false, 'destroy() unbinds the wheel handler');
    } },
    // CDP: verify-run-monitor-cdp.mjs check(6) `prevented0` / `prevented1`.
    { name: 'the monitor canvas preventDefaults only what it consumes: ⌘/ctrl+wheel always, a plain wheel never', run: () => {
      const { window, host, view } = mountView('monitor');
      const nav = view.createNav();
      const stage = view.stage;
      view.setTransform({ x: 0, y: 0, z: 1 });

      // (a) a plain wheel belongs to the PAGE — untouched and unmoved, with no click first.
      const idle = wheelOn(window, stage, { clientX: 400, clientY: 200, deltaX: 40, deltaY: -25 });
      assert.equal(idle.defaultPrevented, false, 'a plain wheel scrolls the page');
      assert.deepEqual(view.getTransform(), { x: 0, y: 0, z: 1 }, 'and pans nothing');

      // (b) a press does NOT change that: there is no engagement any more.
      stage.dispatchEvent(pev(window, 'pointerdown', { button: 0, clientX: 400, clientY: 200 }));
      window.document.dispatchEvent(pev(window, 'pointerup', { clientX: 400, clientY: 200 }));
      const after = wheelOn(window, stage, { clientX: 400, clientY: 200, deltaX: 40, deltaY: -25 });
      assert.equal(after.defaultPrevented, false, 'clicking the canvas never captures the page scroll');
      assert.deepEqual(view.getTransform(), { x: 0, y: 0, z: 1 });

      // (c) ctrl+wheel and meta+wheel zoom, and are always consumed.
      for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
        const z0 = view.getTransform().z;
        const zoom = wheelOn(window, stage, { clientX: 400, clientY: 200, deltaY: -120, ...mod });
        assert.equal(zoom.defaultPrevented, true, `${JSON.stringify(mod)}+wheel is the canvas's`);
        assert.ok(view.getTransform().z > z0, 'and it really zoomed in');
      }
      nav.destroy();
      const dead = wheelOn(window, stage, { clientX: 400, clientY: 200, deltaY: -120, ctrlKey: true });
      assert.equal(dead.defaultPrevented, false, 'destroy() unbinds the wheel handler');
      assert.equal(host.isConnected, true);
    } },
  ]);
});

// ─── the two pan gestures that had no guard anywhere ─────────────────────────
// CDP: verify-composer-cdp.mjs check(9).

test('middle-button and Space+drag pan by the exact delta, outrank the hit-test and mutate no model state', async () => {
  const s = await open();
  await checkRows([
    { name: 'a MIDDLE-button drag pans the composer by the exact delta and never grabs the card under it', run: () => {
      s.c.view.setTransform({ x: 0, y: 0, z: 1 });
      const before = JSON.stringify(s.c.template());
      // press on the n_agent CARD: button 1 outranks the hit-test.
      s.c.view.stage.dispatchEvent(pev(s.win, 'pointerdown', { button: 1, clientX: 400, clientY: 80 }));
      assert.equal(s.c.gesture().type, 'pan', 'the middle button always pans');
      assert.equal(s.c.selection(), null, 'and selects nothing');
      assert.ok(s.c.view.stage.classList.contains('panning'));
      s.c.view.stage.dispatchEvent(pev(s.win, 'pointermove', { clientX: 455, clientY: 45 }));
      s.flush();
      assert.deepEqual(s.c.view.getTransform(), { x: 55, y: -35, z: 1 }, 'panned by (+55, −35)');
      s.c.view.stage.dispatchEvent(pev(s.win, 'pointerup', { button: 1, clientX: 455, clientY: 45 }));
      s.flush();
      assert.equal(s.c.gesture(), null);
      assert.equal(s.c.view.stage.classList.contains('panning'), false);
      assert.equal(JSON.stringify(s.c.template()), before, 'a pan mutates no model state');
      // …and a button the composer does not own is ignored outright.
      s.c.view.stage.dispatchEvent(pev(s.win, 'pointerdown', { button: 2, clientX: 400, clientY: 80 }));
      assert.equal(s.c.gesture(), null, 'the right button starts nothing');
    } },
    { name: 'SPACE+drag pans the composer: the key arms the stage, outranks the hit-test and disarms on keyup', run: () => {
      s.c.view.setTransform({ x: 0, y: 0, z: 1 });
      const key = (type, k) => {
        const ev = new s.win.KeyboardEvent(type, { key: k, bubbles: true, cancelable: true });
        s.doc.dispatchEvent(ev);
        return ev;
      };
      const armed = key('keydown', ' ');
      assert.equal(s.c._internal.isSpace(), true, 'space arms the pan modifier');
      assert.equal(armed.defaultPrevented, true, 'and the page never page-downs under the canvas');
      assert.ok(s.c.view.stage.classList.contains('space'), 'the stage takes the grab cursor');

      s.c.view.stage.dispatchEvent(pev(s.win, 'pointerdown', { button: 0, clientX: 400, clientY: 80 }));
      assert.equal(s.c.gesture().type, 'pan', 'space wins over the card under the cursor');
      s.c.view.stage.dispatchEvent(pev(s.win, 'pointermove', { clientX: 360, clientY: 105 }));
      s.flush();
      assert.deepEqual(s.c.view.getTransform(), { x: -40, y: 25, z: 1 }, 'panned by (−40, +25)');
      s.c.view.stage.dispatchEvent(pev(s.win, 'pointerup', { button: 0, clientX: 360, clientY: 105 }));
      s.flush();

      key('keyup', ' ');
      assert.equal(s.c._internal.isSpace(), false, 'keyup disarms');
      assert.equal(s.c.view.stage.classList.contains('space'), false);
      // Rewind the pan first: the same client point maps to a different WORLD point
      // once the canvas has moved, so a press there would miss the card for a reason
      // that has nothing to do with the space modifier.
      s.c.view.setTransform({ x: 0, y: 0, z: 1 });
      s.c._internal.readRect();
      s.c.view.stage.dispatchEvent(pev(s.win, 'pointerdown', { button: 0, clientX: 400, clientY: 80 }));
      assert.equal(s.c.gesture().type, 'node', 'and the hit-test is back in charge');
    } },
  ]);
});
