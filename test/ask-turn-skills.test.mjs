// test/ask-turn-skills.test.mjs — skills registry §4.4: an Ask turn mounts its set skills per message under the
// thread's folder (one generated plugin per set, the real P3 materializeSkillMount in the first row), names exactly what
// the mount wrote (prompt section appended last, sub-agent note, allow rules), hands every attempt the plugin dirs,
// removes the mount in finally, and survives a host whose Claude Code refuses --plugin-dir (the sideload safety net runs
// the same attempt again without the layer). AskTurn over the REAL store (temp home) with an injected runClaudeImpl.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

import { useTempHome } from './helpers/temp-home.mjs';
import { checkRows } from './helpers/rows.mjs';
import { createAskTurn } from '../src/core/ask/turn.mjs';
import { createThread, appendMessage, getMessage, deleteThread } from '../src/core/ask/store.mjs';
import { worcaHome } from '../src/core/projects.mjs';

const home = useTempHome(after);

// A hook inside the mount's sweep: turn.mjs imports `rm` from node:fs/promises by name, so the CJS object is patched and
// the ESM bindings re-synced. One row arms it, for one folder name only.
const realRm = fs.promises.rm;
let onSweepRm = null;
fs.promises.rm = async function (p, ...a) {
  if (onSweepRm && /askm_0000f00d$/.test(String(p))) { const f = onSweepRm; onSweepRm = null; f(); }
  return realRm.call(this, p, ...a);
};
syncBuiltinESMExports();

const RESULT = (over = {}) => ({
  type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01,
  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  modelUsage: {}, duration_ms: 5, num_turns: 1, session_id: 'sess-1', permission_denials: [], ...over,
});
const INIT = { type: 'system', subtype: 'init', session_id: 'sess-1', parent_tool_use_id: null, mcp_servers: [] };
const push = (onEvent, raw) => onEvent({ type: raw.type, raw });
const REFUSED = "claude exited with code 1: --plugin-dir is disabled by your organization's managed settings (disableSideloadFlags)";

function seed() {
  const thread = createThread();
  const user = appendMessage(thread.id, { role: 'user', text: 'hello' });
  const asst = appendMessage(thread.id, { role: 'assistant', text: '', status: 'streaming' });
  return { thread, user, asst };
}
function skillDir(name) {
  const dir = join(home, 'fixture-skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} help\n---\nDo ${name}.\n`);
  return dir;
}
const SKILLS = () => ({
  mounted: [
    { id: 'skill:library:deploy-checklist', name: 'deploy-checklist', qualifiedName: 'billing:deploy-checklist', pluginName: 'billing', setId: 'billing', setName: 'Billing',
      setSlug: 'billing', dir: skillDir('deploy-checklist'), projects: [], description: '', plugin: null },
    { id: 'skill:library:graphify', name: 'graphify', qualifiedName: 'general:graphify', pluginName: 'general', setId: 'general', setName: 'General',
      setSlug: null, dir: skillDir('graphify'), projects: [], description: '', plugin: null },
  ],
  plugins: [{ setId: 'billing', setName: 'Billing', pluginName: 'billing', renamedPlugin: false, skills: ['deploy-checklist'] },
    { setId: 'general', setName: 'General', pluginName: 'general', renamedPlugin: false, skills: ['graphify'] }],
  skipped: [], sets: [], blocked: null,
});
function makeTurn(s, over = {}, deps = {}) {
  return createAskTurn({
    threadId: s.thread.id, assistantMessageId: s.asst.id, userMessageId: s.user.id,
    prompt: 'PROMPT-1', systemPrompt: 'SYS', restoredPrompt: 'RESTORED-1', model: 'claude-opus-5-5', effort: 'high',
    resumeSessionId: null, firstTurn: false, firstText: 'hello', deterministicTitle: null, mock: null, attachmentNames: {},
    ...over,
    deps: { generateTitle: async () => '', failedBecauseSignedOut: async () => false, ...deps },
  });
}
const quiet = (t) => { const w = console.warn; console.warn = () => {}; t.after(() => { console.warn = w; }); };
const notices = (id) => getMessage(id).blocks.filter((b) => b.kind === 'notice').map((b) => b.text);
const SECTION = (names) => `SYS\n\n## Skills from your sets\nSkills from your sets this turn: ${names}\n`;
const DIR_LINK = process.platform === 'win32' ? 'junction' : 'dir';   // a folder symlink (a junction on Windows)
/** materializeSkillMount's answer for SKILLS(): both plugins written, nothing failed (the P3 shape). */
const WROTE = (base, failed = []) => ({ base, pluginDirs: [join(base, 'billing'), join(base, 'general')], failed,
  plugins: [{ setId: 'billing', pluginName: 'billing', dir: join(base, 'billing'), skills: ['deploy-checklist'] },
    { setId: 'general', pluginName: 'general', dir: join(base, 'general'), skills: ['graphify'] }] });

test('a mount: per message under the thread, one plugin per set, both attempts carry the dirs and the Skill tool, removed in finally', async () => {
  await checkRows([
    { name: 'the real mount: <home>/ask/<thread>/skills/<message>/<plugin>/ exists during the spawn and is gone after the turn', run: async () => {
      const s = seed();
      const base = join(worcaHome(), 'ask', s.thread.id, 'skills', s.asst.id);
      const seen = [];
      const turn = makeTurn(s, { skills: SKILLS() }, {
        runClaudeImpl: async (opts) => {
          seen.push({ dirs: opts.pluginDirs, tools: opts.tools, slash: opts.disableSlashCommands, sys: opts.systemPrompt, allowed: opts.allowedTools,
            manifest: JSON.parse(readFileSync(join(opts.pluginDirs[0], '.claude-plugin', 'plugin.json'), 'utf8')),
            skill: existsSync(join(opts.pluginDirs[0], 'skills', 'deploy-checklist', 'SKILL.md')) });
          push(opts.onEvent, RESULT());
          return { text: '', exitCode: 0 };
        },
      });
      const out = await turn.run();
      assert.equal(out.status, 'done');
      assert.deepEqual(seen[0].dirs, [join(base, 'billing'), join(base, 'general')]);
      assert.equal(seen[0].manifest.name, 'billing');
      assert.equal(seen[0].skill, true);
      assert.ok(seen[0].tools.includes('Skill'));
      assert.equal(seen[0].slash, undefined, 'no --disable-slash-commands with a mount');
      assert.ok(seen[0].sys.startsWith(SECTION('billing:deploy-checklist, general:graphify')), 'the section goes last, after the route\'s prompt');
      assert.deepEqual(seen[0].allowed, ['Task', 'Read', 'Grep', 'Glob', 'Skill(billing:deploy-checklist)', 'Skill(general:graphify)']);
      assert.equal(existsSync(base), false, 'removed in finally');
    } },
    { name: 'the resume-fallback retry carries the same mount; materialized once, removed once, by base', run: async () => {
      const s = seed();
      const calls = { mat: [], rm: [], spawn: [] };
      const turn = makeTurn(s, { skills: SKILLS(), resumeSessionId: 'dead-sid' }, {
        materializeSkillMount: async ({ result, base }) => { calls.mat.push({ result, base }); return WROTE(base); },
        removeSkillMount: async (base) => { calls.rm.push(base); },
        runClaudeImpl: async (opts) => {
          calls.spawn.push(opts);
          if (calls.spawn.length === 1) {
            push(opts.onEvent, RESULT({ subtype: 'error_during_execution', is_error: true, errors: ['No conversation found with session ID: dead-sid'] }));
            throw new Error('claude exited with code 1: No conversation found with session ID: dead-sid');
          }
          push(opts.onEvent, RESULT());
          return { text: '', exitCode: 0 };
        },
      });
      await turn.run();
      const base = join(worcaHome(), 'ask', s.thread.id, 'skills', s.asst.id);
      assert.equal(calls.mat.length, 1);
      assert.equal(calls.mat[0].base, base);
      assert.deepEqual(calls.mat[0].result.plugins.map((p) => p.pluginName), ['billing', 'general']);
      assert.equal(calls.spawn.length, 2);
      for (const o of calls.spawn) {
        assert.deepEqual(o.pluginDirs, [join(base, 'billing'), join(base, 'general')]);
        assert.match(o.appendSubagentSystemPrompt, /\(billing:deploy-checklist, general:graphify\)/);
        assert.ok(o.systemPrompt.startsWith(SECTION('billing:deploy-checklist, general:graphify')), 'the section rides every attempt');
      }
      assert.deepEqual(calls.rm, [base]);
    } },
    { name: 'a folder an earlier turn of the thread left behind (a server killed mid-turn) is swept by the next mount, and nothing else', run: async () => {
      const s = seed();
      const stale = join(worcaHome(), 'ask', s.thread.id, 'skills', 'askm_0000dead');
      mkdirSync(join(stale, 'billing'), { recursive: true });
      writeFileSync(join(stale, 'billing', 'x'), 'x');
      const other = join(worcaHome(), 'ask', s.thread.id, 'skills', 'att_0000beef');   // id-shaped, but no message folder
      mkdirSync(other, { recursive: true });
      let during = null;
      const turn = makeTurn(s, { skills: SKILLS() }, {
        runClaudeImpl: async (opts) => { during = existsSync(stale); push(opts.onEvent, RESULT()); return { text: '', exitCode: 0 }; },
      });
      await turn.run();
      assert.equal(during, false, 'gone before the spawn');
      assert.ok(existsSync(other), 'the sweep removes message folders only');
      assert.equal(existsSync(join(worcaHome(), 'ask', s.thread.id, 'skills', s.asst.id)), false);
    } },
  ]);
});

test('a skill the mount could not copy is named nowhere: not in the prompt, the note or the allow rules; a plugin left empty passes no dir; one notice', async (t) => {
  quiet(t);
  await checkRows([
    { name: 'billing:release-notes failed, its plugin still written with deploy-checklist: release-notes is named nowhere', run: async () => {
      const s = seed();
      const sk = SKILLS();
      sk.mounted.push({ ...sk.mounted[0], id: 'skill:library:release-notes', name: 'release-notes', qualifiedName: 'billing:release-notes', dir: skillDir('release-notes') });
      sk.plugins[0].skills.push('release-notes');
      let o = null;
      const turn = makeTurn(s, { skills: sk }, {
        materializeSkillMount: async ({ base }) => ({ ...WROTE(base), failed: [{ setId: 'billing', pluginName: 'billing', name: 'release-notes', error: 'a link leaves the skill folder' }] }),
        removeSkillMount: async () => {},
        runClaudeImpl: async (opts) => { o = opts; o.during = notices(s.asst.id); push(opts.onEvent, RESULT()); return { text: '', exitCode: 0 }; },
      });
      await turn.run();
      assert.deepEqual(o.during, ['skills from sets not loaded: billing:release-notes (they could not be copied for this turn)'], 'persisted before the spawn');
      assert.ok(o.systemPrompt.startsWith(SECTION('billing:deploy-checklist, general:graphify')));
      assert.ok(!o.systemPrompt.includes('release-notes') && !o.appendSubagentSystemPrompt.includes('release-notes'));
      assert.deepEqual(o.allowedTools, ['Task', 'Read', 'Grep', 'Glob', 'Skill(billing:deploy-checklist)', 'Skill(general:graphify)']);
      assert.deepEqual(notices(s.asst.id), ['skills from sets not loaded: billing:release-notes (they could not be copied for this turn)']);
    } },
    { name: 'billing:deploy-checklist failed (its plugin then empty and not written): only general:graphify is named and loaded', run: async () => {
      const s = seed();
      let o = null;
      const turn = makeTurn(s, { skills: SKILLS() }, {
        materializeSkillMount: async ({ base }) => ({ base, pluginDirs: [join(base, 'general')],
          plugins: [{ setId: 'general', pluginName: 'general', dir: join(base, 'general'), skills: ['graphify'] }],
          failed: [{ setId: 'billing', pluginName: 'billing', name: 'deploy-checklist', error: 'a link leaves the skill folder' }] }),
        removeSkillMount: async () => {},
        runClaudeImpl: async (opts) => { o = opts; push(opts.onEvent, RESULT()); return { text: '', exitCode: 0 }; },
      });
      await turn.run();
      assert.deepEqual(o.pluginDirs, [join(worcaHome(), 'ask', s.thread.id, 'skills', s.asst.id, 'general')]);
      assert.ok(o.systemPrompt.startsWith(SECTION('general:graphify')));
      assert.ok(!o.systemPrompt.includes('deploy-checklist') && !o.appendSubagentSystemPrompt.includes('deploy-checklist'));
      assert.deepEqual(o.allowedTools, ['Task', 'Read', 'Grep', 'Glob', 'Skill(general:graphify)']);
      assert.deepEqual(notices(s.asst.id), ['skills from sets not loaded: billing:deploy-checklist (they could not be copied for this turn)']);
    } },
    { name: 'a plugin refused as a whole (failed names no skill): none of its skills is named', run: async () => {
      const s = seed();
      let o = null;
      const turn = makeTurn(s, { skills: SKILLS() }, {
        materializeSkillMount: async ({ base }) => ({ base, pluginDirs: [join(base, 'general')],
          plugins: [{ setId: 'general', pluginName: 'general', dir: join(base, 'general'), skills: ['graphify'] }],
          failed: [{ setId: 'billing', pluginName: 'billing', name: null, error: 'not a usable plugin name' }] }),
        removeSkillMount: async () => {},
        runClaudeImpl: async (opts) => { o = opts; push(opts.onEvent, RESULT()); return { text: '', exitCode: 0 }; },
      });
      await turn.run();
      assert.ok(o.systemPrompt.startsWith(SECTION('general:graphify')));
      assert.deepEqual(notices(s.asst.id), ['skills from sets not loaded: billing:deploy-checklist (they could not be copied for this turn)']);
    } },
    { name: 'every skill failed: the turn runs without the layer (the whole-mount notice)', run: async () => {
      const s = seed();
      let o = null;
      const turn = makeTurn(s, { skills: SKILLS() }, {
        materializeSkillMount: async ({ base }) => ({ base, pluginDirs: [], plugins: [],
          failed: [{ setId: 'billing', pluginName: 'billing', name: 'deploy-checklist', error: 'x' }, { setId: 'general', pluginName: 'general', name: 'graphify', error: 'x' }] }),
        removeSkillMount: async () => {},
        runClaudeImpl: async (opts) => { o = opts; push(opts.onEvent, RESULT()); return { text: '', exitCode: 0 }; },
      });
      await turn.run();
      assert.equal(o.systemPrompt, 'SYS');
      assert.equal(o.disableSlashCommands, true);
      assert.deepEqual(notices(s.asst.id), ['skills from sets not loaded (they could not be copied for this turn)']);
    } },
    { name: 'a partial copy loss, then a dead session: the resume-fallback retry keeps the partial-loss notice', run: async () => {
      const s = seed();
      let n = 0;
      const turn = makeTurn(s, { skills: SKILLS(), resumeSessionId: 'dead-sid' }, {
        materializeSkillMount: async ({ base }) => ({ base, pluginDirs: [join(base, 'general')],
          plugins: [{ setId: 'general', pluginName: 'general', dir: join(base, 'general'), skills: ['graphify'] }],
          failed: [{ setId: 'billing', pluginName: 'billing', name: 'deploy-checklist', error: 'a link leaves the skill folder' }] }),
        removeSkillMount: async () => {},
        runClaudeImpl: async (opts) => {
          n += 1;
          if (n === 1) {
            push(opts.onEvent, RESULT({ subtype: 'error_during_execution', is_error: true, errors: ['No conversation found with session ID: dead-sid'] }));
            throw new Error('claude exited with code 1: No conversation found with session ID: dead-sid');
          }
          push(opts.onEvent, RESULT());
          return { text: '', exitCode: 0 };
        },
      });
      assert.equal((await turn.run()).status, 'done');
      assert.equal(n, 2);
      assert.deepEqual(notices(s.asst.id), ['skills from sets not loaded: billing:deploy-checklist (they could not be copied for this turn)', 'Context restored from history']);
    } },
  ]);
});

test('no mount: null, a blocked layer or no plugin never materializes; the spawn keeps --disable-slash-commands', async () => {
  for (const skills of [null, { ...SKILLS(), blocked: 'sideload-disabled' }, { ...SKILLS(), mounted: [], plugins: [] }]) {
    const s = seed();
    let mat = 0; let rm = 0; let o = null;
    const turn = makeTurn(s, { skills }, {
      materializeSkillMount: async () => { mat += 1; return { base: 'x', pluginDirs: ['x'], plugins: [] }; },
      removeSkillMount: async () => { rm += 1; },
      runClaudeImpl: async (opts) => { o = opts; push(opts.onEvent, RESULT()); return { text: '', exitCode: 0 }; },
    });
    await turn.run();
    assert.equal(turn.skills, null);
    assert.equal(mat, 0); assert.equal(rm, 0);
    assert.equal(o.disableSlashCommands, true);
    assert.ok(!Object.hasOwn(o, 'pluginDirs'));
    assert.ok(!o.tools.includes('Skill'));
    assert.equal(o.systemPrompt, 'SYS', 'no section');
  }
});

test('a failed mount never breaks the turn: no skills this turn, a notice, the partial folder removed', async (t) => {
  quiet(t);
  await checkRows([
    { name: 'materialize throws: the turn runs without the layer, says so, and removes the base', run: async () => {
      const s = seed();
      const rm = []; let o = null;
      const turn = makeTurn(s, { skills: SKILLS() }, {
        materializeSkillMount: async () => { throw new Error('ENOSPC'); },
        removeSkillMount: async (base) => { rm.push(base); },
        runClaudeImpl: async (opts) => { o = opts; push(opts.onEvent, RESULT()); return { text: '', exitCode: 0 }; },
      });
      const out = await turn.run();
      assert.equal(out.status, 'done');
      assert.equal(turn.skills, null, 'the turn reads as one without skills');
      assert.ok(!Object.hasOwn(o, 'pluginDirs'));
      assert.equal(o.disableSlashCommands, true);
      assert.deepEqual(notices(s.asst.id), ['skills from sets not loaded (they could not be copied for this turn)']);
      assert.deepEqual(rm, [join(worcaHome(), 'ask', s.thread.id, 'skills', s.asst.id)]);
    } },
    { name: 'materialize throws, then a dead session: the resume-fallback retry keeps the mount-failed notice', run: async () => {
      const s = seed();
      let n = 0;
      const turn = makeTurn(s, { skills: SKILLS(), resumeSessionId: 'dead-sid' }, {
        materializeSkillMount: async () => { throw new Error('ENOSPC'); },
        removeSkillMount: async () => {},
        runClaudeImpl: async (opts) => {
          n += 1;
          if (n === 1) {
            push(opts.onEvent, RESULT({ subtype: 'error_during_execution', is_error: true, errors: ['No conversation found with session ID: dead-sid'] }));
            throw new Error('claude exited with code 1: No conversation found with session ID: dead-sid');
          }
          push(opts.onEvent, RESULT());
          return { text: '', exitCode: 0 };
        },
      });
      assert.equal((await turn.run()).status, 'done');
      assert.equal(n, 2);
      assert.deepEqual(notices(s.asst.id), ['skills from sets not loaded (they could not be copied for this turn)', 'Context restored from history']);
    } },
    { name: 'an id that is no store id never becomes a path: no mount at all', run: async () => {
      const s = seed();
      let mat = 0; let o = null;
      const turn = makeTurn(s, { skills: SKILLS(), assistantMessageId: '../../etc' }, {
        materializeSkillMount: async () => { mat += 1; return { base: 'x', pluginDirs: ['x'], plugins: [] }; },
        runClaudeImpl: async (opts) => { o = opts; push(opts.onEvent, RESULT()); return { text: '', exitCode: 0 }; },
      });
      await turn.run();
      assert.equal(mat, 0);
      assert.ok(!Object.hasOwn(o, 'pluginDirs'));
    } },
    { name: 'a thread id that is no store id never becomes a path either: nothing swept, nothing mounted', run: async () => {
      const s = seed();
      const lib = join(worcaHome(), 'skills', 'deploy-checklist');   // the skill library — where <home>/ask/../skills/ points
      mkdirSync(lib, { recursive: true });
      writeFileSync(join(lib, 'SKILL.md'), 'x');
      let mat = 0; let o = null;
      const turn = makeTurn(s, { skills: SKILLS(), threadId: '..' }, {
        materializeSkillMount: async () => { mat += 1; return { base: 'x', pluginDirs: ['x'], plugins: [] }; },
        runClaudeImpl: async (opts) => { o = opts; push(opts.onEvent, RESULT()); return { text: '', exitCode: 0 }; },
      });
      await turn.run();
      assert.equal(mat, 0);
      assert.ok(!Object.hasOwn(o, 'pluginDirs'));
      assert.ok(existsSync(join(lib, 'SKILL.md')), 'the sweep never ran over the library');
    } },
    { name: 'hosted mode (ask/ is group-writable): a symlink where ask/<thread>/skills/ stands is never swept or written through — no layer this turn', run: async () => {
      const s = seed();
      const target = join(home, 'link-target-skills');
      mkdirSync(join(target, 'askm_0000beef'), { recursive: true });
      writeFileSync(join(target, 'askm_0000beef', 'keep'), 'x');
      mkdirSync(join(worcaHome(), 'ask', s.thread.id), { recursive: true });
      symlinkSync(target, join(worcaHome(), 'ask', s.thread.id, 'skills'), DIR_LINK);
      let o = null;
      const turn = makeTurn(s, { skills: SKILLS() }, {
        runClaudeImpl: async (opts) => { o = opts; push(opts.onEvent, RESULT()); return { text: '', exitCode: 0 }; },
      });
      assert.equal((await turn.run()).status, 'done');
      assert.deepEqual(readdirSync(target), ['askm_0000beef'], 'nothing swept and nothing written there');
      assert.ok(existsSync(join(target, 'askm_0000beef', 'keep')));
      assert.ok(!Object.hasOwn(o, 'pluginDirs'));
      assert.deepEqual(notices(s.asst.id), ['skills from sets not loaded (they could not be copied for this turn)']);
    } },
    { name: 'hosted mode: a symlink where ask/<thread>/ itself stands — the same', run: async () => {
      const s = seed();
      const target = join(home, 'link-target-thread');
      mkdirSync(join(target, 'skills', 'askm_0000beef'), { recursive: true });
      writeFileSync(join(target, 'skills', 'askm_0000beef', 'keep'), 'x');
      mkdirSync(join(worcaHome(), 'ask'), { recursive: true });
      symlinkSync(target, join(worcaHome(), 'ask', s.thread.id), DIR_LINK);
      let o = null;
      const turn = makeTurn(s, { skills: SKILLS() }, {
        runClaudeImpl: async (opts) => { o = opts; push(opts.onEvent, RESULT()); return { text: '', exitCode: 0 }; },
      });
      assert.equal((await turn.run()).status, 'done');
      assert.deepEqual(readdirSync(join(target, 'skills')), ['askm_0000beef'], 'nothing swept and nothing written there');
      assert.ok(existsSync(join(target, 'skills', 'askm_0000beef', 'keep')));
      assert.ok(!Object.hasOwn(o, 'pluginDirs'));
    } },
    { name: 'a turn stopped before its mount (its thread being deleted) writes no folder', run: async () => {
      const s = seed();
      let mat = 0; let turn = null;
      turn = makeTurn(s, { skills: SKILLS() }, {
        memoryMount: async () => { turn.stop(); return null; },
        materializeSkillMount: async () => { mat += 1; return { base: 'x', pluginDirs: ['x'], plugins: [] }; },
        runClaudeImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); },
      });
      const out = await turn.run();
      assert.equal(out.status, 'stopped');
      assert.equal(mat, 0);
      assert.equal(existsSync(join(worcaHome(), 'ask', s.thread.id, 'skills')), false);
    } },
    { name: 'a thread deleted while the mount sweeps (stop, then ask/<thread>/ removed without waiting): the mount recreates nothing', run: async () => {
      const s = seed();
      mkdirSync(join(worcaHome(), 'ask', s.thread.id, 'skills', 'askm_0000f00d'), { recursive: true });   // a crashed turn's folder: swept
      let turn = null;
      turn = makeTurn(s, { skills: SKILLS() }, {
        runClaudeImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); },
      });
      // The delete lands inside the sweep's own rm: after the folder checks, before the mount.
      onSweepRm = () => { turn.stop(); deleteThread(s.thread.id); };
      try {
        assert.equal((await turn.run()).status, 'stopped');
        assert.equal(onSweepRm, null, 'the stop landed inside the sweep');
        assert.equal(existsSync(join(worcaHome(), 'ask', s.thread.id)), false, 'the deleted thread\'s folder stays gone');
      } finally { onSweepRm = null; }
    } },
  ]);
});

test('sideload safety net: a refusal before init runs the same attempt again without the layer — same prompt, same --resume, one notice', async (t) => {
  quiet(t);
  await checkRows([
    { name: 'refused before init: the attempt again without --plugin-dir, the prompt and the session kept, no "Context restored"', run: async () => {
      const s = seed();
      const seen = []; const rm = [];
      const turn = makeTurn(s, { skills: SKILLS(), resumeSessionId: 'live-sid' }, {
        removeSkillMount: async (base) => { rm.push(base); },
        runClaudeImpl: async (opts) => {
          seen.push(opts);
          if (seen.length === 1) throw new Error(REFUSED);
          seen.during = notices(s.asst.id);
          push(opts.onEvent, INIT);
          push(opts.onEvent, RESULT());
          return { text: '', exitCode: 0 };
        },
      });
      const out = await turn.run();
      assert.equal(out.status, 'done');
      assert.equal(seen.length, 2);
      assert.ok(seen[0].pluginDirs.length === 2);
      assert.ok(seen[0].systemPrompt.startsWith(SECTION('billing:deploy-checklist, general:graphify')));
      assert.equal(seen[1].systemPrompt, 'SYS', 'no skills, no section');
      assert.ok(!Object.hasOwn(seen[1], 'pluginDirs'));
      assert.equal(seen[1].disableSlashCommands, true);
      assert.ok(!seen[1].tools.includes('Skill'));
      assert.equal(seen[1].prompt, 'PROMPT-1');
      assert.equal(seen[1].resumeSessionId, 'live-sid', 'the session was never reached: keep it');
      assert.deepEqual(notices(s.asst.id), ['skills from sets not loaded (Claude Code refuses --plugin-dir here)']);
      assert.equal(rm.length, 1, 'the mount is still removed');
      assert.deepEqual(seen.during, ['skills from sets not loaded (Claude Code refuses --plugin-dir here)'], 'persisted before the re-run spawns');
    } },
    { name: 'the reducer\'s errors count too (an older CLI: unknown option), and the layer drop survives a resume-fallback retry with its notice', run: async () => {
      const s = seed();
      const seen = [];
      const turn = makeTurn(s, { skills: SKILLS(), resumeSessionId: 'dead-sid' }, {
        removeSkillMount: async () => {},
        runClaudeImpl: async (opts) => {
          seen.push(opts);
          if (seen.length === 1) {
            push(opts.onEvent, RESULT({ subtype: 'error_during_execution', is_error: true, errors: ["error: unknown option '--plugin-dir'"] }));
            throw new Error('claude exited with code 1: no stderr');
          }
          if (seen.length === 2) {
            push(opts.onEvent, RESULT({ subtype: 'error_during_execution', is_error: true, errors: ['No conversation found with session ID: dead-sid'] }));
            throw new Error('claude exited with code 1: No conversation found with session ID: dead-sid');
          }
          push(opts.onEvent, RESULT());
          return { text: '', exitCode: 0 };
        },
      });
      const out = await turn.run();
      assert.equal(out.status, 'done');
      assert.deepEqual(seen.map((o) => [Object.hasOwn(o, 'pluginDirs'), o.resumeSessionId ?? null, o.prompt]),
        [[true, 'dead-sid', 'PROMPT-1'], [false, 'dead-sid', 'PROMPT-1'], [false, null, 'RESTORED-1']]);
      assert.deepEqual(notices(s.asst.id), ['skills from sets not loaded (Claude Code refuses --plugin-dir here)', 'Context restored from history']);
    } },
    { name: 'a refusal printed on stdout (a plain log line; the runner\'s error says only "no stderr") counts too', run: async () => {
      const s = seed();
      const seen = [];
      const turn = makeTurn(s, { skills: SKILLS() }, {
        removeSkillMount: async () => {},
        runClaudeImpl: async (opts) => {
          seen.push(opts);
          if (seen.length === 1) {
            const text = REFUSED.replace('claude exited with code 1: ', '');
            opts.onEvent({ type: 'log', text: 'Warning: an unrelated line first', raw: 'Warning: an unrelated line first' });
            opts.onEvent({ type: 'log', text, raw: text });
            throw new Error('claude exited with code 1: no stderr');
          }
          push(opts.onEvent, INIT);
          push(opts.onEvent, RESULT());
          return { text: '', exitCode: 0 };
        },
      });
      assert.equal((await turn.run()).status, 'done');
      assert.deepEqual(seen.map((o) => Object.hasOwn(o, 'pluginDirs')), [true, false]);
      assert.deepEqual(notices(s.asst.id), ['skills from sets not loaded (Claude Code refuses --plugin-dir here)']);
    } },
    { name: 'a partial copy loss, then a refusal: only the refusal is said — no skill of this turn loaded', run: async () => {
      const s = seed();
      let n = 0;
      const turn = makeTurn(s, { skills: SKILLS() }, {
        materializeSkillMount: async ({ base }) => ({ base, pluginDirs: [join(base, 'general')],
          plugins: [{ setId: 'general', pluginName: 'general', dir: join(base, 'general'), skills: ['graphify'] }],
          failed: [{ setId: 'billing', pluginName: 'billing', name: 'deploy-checklist', error: 'a link leaves the skill folder' }] }),
        removeSkillMount: async () => {},
        runClaudeImpl: async (opts) => {
          n += 1;
          if (n === 1) throw new Error(REFUSED);
          push(opts.onEvent, INIT);
          push(opts.onEvent, RESULT());
          return { text: '', exitCode: 0 };
        },
      });
      assert.equal((await turn.run()).status, 'done');
      assert.equal(n, 2);
      assert.deepEqual(notices(s.asst.id), ['skills from sets not loaded (Claude Code refuses --plugin-dir here)']);
    } },
    { name: 'the re-run starts on a fresh reducer: the refused spawn\'s result (its cost, its errors) is not the turn\'s', run: async () => {
      const s = seed();
      let n = 0;
      const turn = makeTurn(s, { skills: SKILLS() }, {
        removeSkillMount: async () => {},
        runClaudeImpl: async (opts) => {
          n += 1;
          if (n === 1) {
            push(opts.onEvent, RESULT({ subtype: 'error_during_execution', is_error: true, total_cost_usd: 0.42, errors: ["error: unknown option '--plugin-dir'"] }));
            throw new Error('claude exited with code 1: no stderr');
          }
          push(opts.onEvent, INIT);
          throw new Error('claude exited with code 1: API Error: 500');
        },
      });
      const out = await turn.run();
      assert.equal(out.status, 'error');
      assert.equal(n, 2);
      assert.equal(getMessage(s.asst.id).costUsd, null, 'no result reached the re-run');
      assert.deepEqual(notices(s.asst.id), ['skills from sets not loaded (Claude Code refuses --plugin-dir here)']);
    } },
  ]);
});

test('sideload safety net is narrow: after init, another error, or a spawn without the layer never re-runs; an abort stays an abort', async () => {
  await checkRows([
    { name: 'a refusal text after init is a turn failure', run: async () => {
      const s = seed(); let n = 0;
      const turn = makeTurn(s, { skills: SKILLS() }, { removeSkillMount: async () => {},
        runClaudeImpl: async (opts) => { n += 1; push(opts.onEvent, INIT); throw new Error(REFUSED); } });
      const out = await turn.run();
      assert.equal(n, 1); assert.equal(out.status, 'error');
    } },
    { name: 'another error before init is a turn failure', run: async () => {
      const s = seed(); let n = 0;
      const turn = makeTurn(s, { skills: SKILLS() }, { removeSkillMount: async () => {},
        runClaudeImpl: async () => { n += 1; throw new Error('claude exited with code 1: API Error: 500'); } });
      assert.equal((await turn.run()).status, 'error');
      assert.equal(n, 1);
    } },
    { name: 'a spawn that carried no --plugin-dir never matches', run: async () => {
      const s = seed(); let n = 0;
      const turn = makeTurn(s, { skills: null }, { runClaudeImpl: async () => { n += 1; throw new Error(REFUSED); } });
      assert.equal((await turn.run()).status, 'error');
      assert.equal(n, 1);
    } },
    { name: 'only the first attempt re-runs: a refusal on the resume-fallback retry is a turn failure (at most one spawn more)', run: async () => {
      const s = seed(); let n = 0;
      const turn = makeTurn(s, { skills: SKILLS(), resumeSessionId: 'dead-sid' }, { removeSkillMount: async () => {},
        runClaudeImpl: async (opts) => {
          n += 1;
          if (n === 1) {
            push(opts.onEvent, RESULT({ subtype: 'error_during_execution', is_error: true, errors: ['No conversation found with session ID: dead-sid'] }));
            throw new Error('claude exited with code 1: No conversation found with session ID: dead-sid');
          }
          throw new Error(REFUSED);
        } });
      assert.equal((await turn.run()).status, 'error');
      assert.equal(n, 2);
    } },
    { name: 'an abort before init is a stop, not a re-run', run: async () => {
      const s = seed(); let n = 0;
      const turn = makeTurn(s, { skills: SKILLS() }, { removeSkillMount: async () => {},
        runClaudeImpl: async () => { n += 1; throw Object.assign(new Error(REFUSED), { name: 'AbortError' }); } });
      const out = await turn.run();
      assert.equal(n, 1); assert.equal(out.status, 'stopped');
    } },
  ]);
});
