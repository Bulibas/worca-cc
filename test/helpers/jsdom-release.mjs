// test/helpers/jsdom-release.mjs
// Release a jsdom window's memory after its test, for suites that boot the real
// app.js once per test.
//
// Those suites import app.js under a fresh `?b=<random>` URL per test so its
// top-level state starts clean. Node never unloads an ES module, so every
// instance stays in the module map for the life of the process, and its
// top-level bindings (cached elements like `nodesGroupBox`) keep that test's
// whole DOM reachable. window.close() stops the window's timers but cannot cut
// that path. A file with ~100 such tests grew past Node's 4GB heap on CI and
// aborted, even though every test passed.
//
// releaseDom() detaches every element from its parent and drops its attributes,
// so a leaked module pins only the few elements it named, not the document
// behind them. It measured a 57% lower heap at the end of
// test/ui-history-detail.test.mjs. The module's own code and state still leak;
// keep files that boot app.js per test from growing without bound.

/**
 * Close a jsdom window and take its DOM apart.
 * @param {import('jsdom').JSDOM} dom
 */
export function releaseDom(dom) {
  const { document } = dom.window;
  // Collect before close(): the walk must not race app.js handlers, and close()
  // stops the window's timers and observers first.
  const elements = [...document.querySelectorAll('*')];
  try { dom.window.close(); } catch { /* already closed */ }
  for (const el of elements) {
    el.replaceChildren();
    for (const attr of [...el.attributes]) el.removeAttributeNode(attr);
  }
  document.replaceChildren();
}

/**
 * Release every DOM the current test tracked, after each test.
 * @param {(fn: () => void) => void} afterEach  the node:test `afterEach` hook
 * @returns {<T extends import('jsdom').JSDOM>(dom: T) => T}  track a DOM; returns it
 */
export function useDomRelease(afterEach) {
  const open = [];
  afterEach(() => { for (const dom of open.splice(0)) releaseDom(dom); });
  return (dom) => { open.push(dom); return dom; };
}
