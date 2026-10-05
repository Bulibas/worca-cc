// test/helpers/wsmap-p1-repos.mjs — tiny multi-repo workspaces for the wsmap P1 tests.
// (P3 adds the general fixture builder test/helpers/wsmap-fixtures.mjs; this one stays P1's.)
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { templateRepo } from './git-dir.mjs';

/** git in `dir`, no shell; throws with stderr on a non-zero exit; → trimmed stdout */
export function git(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** Writes { [relPath]: content } under dir (POSIX rel paths, parents created). */
export async function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, ...rel.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}

/** spec: { [memberKey]: { [relPath]: string } } → one committed git repo per member under one
 *  mkdtemp root (a copy of the `git init -b main` template with its identity stored, then the
 *  member's own files committed: each member has its own HEAD).
 *  → { root, members: [{key, name, dir, projectDir}] sorted by key, cleanup }.
 *  opts.git false → plain directories (no repo), for the fs-walk fallback. */
export async function makeRepos(spec, { git: useGit = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'worca-cc-wsmap-'));
  const members = [];
  for (const [key, files] of Object.entries(spec)) {
    const dir = join(root, key);
    if (useGit) {
      templateRepo(key, { commit: false, branch: 'main', user: true, into: dir });
      appendFileSync(join(dir, '.git', 'config'), '[commit]\n\tgpgsign = false\n'); // `git config commit.gpgsign false`, no spawn
    } else {
      await mkdir(dir, { recursive: true });
    }
    await writeFiles(dir, files);
    if (useGit) {
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
    }
    members.push({ key, name: key, dir, projectDir: dir });
  }
  members.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { root, members, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 3 }) };
}
