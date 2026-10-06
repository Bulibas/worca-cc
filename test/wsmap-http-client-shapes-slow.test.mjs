// test/wsmap-http-client-shapes-slow.test.mjs — the 1 MiB ReDoS row of wsmap-http-client-shapes, in the slow tier
// (test/tiers.json): it spends its CPU budget on adversarial input, so the fast tier leaves it out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import detector from '../src/core/workspace-map/detectors/http-clients.mjs';

// ReDoS guard for the scans M6 adds (the index v2 rule: linear on 1 MiB adversarial input; the bound of
// wsmap-detectors-p4-registry, in CPU time so a loaded machine never fails it: every row takes < 100 ms). A call with
// a non-literal URL makes http-clients build the file's bindings, which reads every parameter list. `func` + a run of
// spaces was quadratic (minutes) with `[ \t]*` on both sides of an optional name.
test('M6: the parameter and .NET BaseAddress scans stay linear on 1 MiB adversarial input (< 2 s of CPU)', () => {
  const MB = 1024 * 1024;
  const fill = (unit, n = MB) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const js = (s) => `${'// ok\n'.repeat(700)}${s}`.slice(0, MB); // 4 KiB of short lines: never read as minified
  const INPUTS = [
    ['a.go', `http.Get(base + "/x")\nfunc${' '.repeat(MB - 30)}`],
    ['a.go', `http.Get(base + "/x")\n${fill('func (r *T) ')}`],
    ['a.py', `requests.get(BASE + "/x")\ndef${' '.repeat(MB - 40)}`],
    ['a.js', js(`fetch(base + '/x');\n${fill(`(${'a'.repeat(298)})`)}`)],
    ['a.ts', js(`fetch(base + '/x');\n${fill(`(a): ${'T'.repeat(99)} `)}`)],
    ['a.js', js(`fetch(base + '/x');\n${fill(', async a ')}`)],
    ['a.js', js(`fetch(base + '/x');\nconstructor${' '.repeat(MB)}`)],
    ['A.cs', fill('x = new HttpClient { ')],
    ['A.cs', fill(`x = new HttpClient {${' '.repeat(399)}\n`)],
    ['A.cs', fill('x.BaseAddress = new Uri(')],
    ['A.cs', `_c.GetAsync("a");\nx = new${' '.repeat(MB - 30)}`],
    ['A.cs', fill('_c.GetAsync("a"); HttpClient a, ')],
    ['A.cs', `_c.GetAsync("a");\nx.BaseAddress = new Uri("http://a");\n${fill('var x = ')}`],
    ['A.cs', `_c.GetAsync("a");\n${fill('BaseAddress = new Uri(')}`],
    ['a.rb', fill('conn.get("/a/#{')],
    ['A.cs', `h.BaseAddress = new Uri("http://a");\nx${' '.repeat(128 * 1024)}`], // lambdaParams: a name, then a run of blanks and no `=>`
    ['A.cs', `static F(${fill('HttpClient a,static F(', MB - 10)}`], // staticParam: every parameter a static helper's, on one line
  ];
  const member = { key: 'm', name: 'm', dir: '/none', projectDir: '/none' };
  for (const [i, [rel, text]] of INPUTS.entries()) {
    const ctx = { member, members: [member], files: [rel], state: {} };
    const c0 = process.cpuUsage();
    assert.doesNotThrow(() => { detector.detect({ rel, text }, ctx); detector.finish(ctx); }, `INPUTS[${i}] ${rel}`);
    const { user, system } = process.cpuUsage(c0);
    const ms = (user + system) / 1000;
    assert.ok(ms < 2000, `http-clients took ${ms.toFixed(0)} ms of CPU on INPUTS[${i}] ${rel} (${JSON.stringify(text.slice(text.startsWith('// ok') ? 4200 : 0).slice(0, 30))}…)`);
  }
});
