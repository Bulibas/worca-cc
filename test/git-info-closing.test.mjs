// test/git-info-closing.test.mjs
// The PR body's issue link: which source URLs are GitHub issues, and the Closes line
// issueClosingLine adds (same repo #N, other repo owner/repo#N, nothing when already closed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGithubIssueUrl, issueClosingLine } from '../src/core/git-info.mjs';
import { checkRows } from './helpers/rows.mjs';

const URL42 = 'https://github.com/up/repo/issues/42';
const line = (o) => issueClosingLine({ sourceUrl: URL42, baseRepo: 'up/repo', body: '', ...o });

test('parseGithubIssueUrl: issue URLs only', async () => {
  await checkRows([
    { name: 'a plain issue URL', run: () => assert.deepEqual(parseGithubIssueUrl(URL42), { owner: 'up', repo: 'repo', number: 42 }) },
    { name: 'trailing /, ?query and #fragment are tolerated', run: () => {
      for (const u of [`${URL42}/`, `${URL42}?x=1`, `${URL42}#issuecomment-9`, `${URL42}/?x=1`]) {
        assert.deepEqual(parseGithubIssueUrl(u), { owner: 'up', repo: 'repo', number: 42 }, u);
      }
    } },
    { name: 'dots and dashes in names; host case-insensitive', run: () => {
      assert.deepEqual(parseGithubIssueUrl('https://GitHub.com/my-org/my.repo_x/issues/7'), { owner: 'my-org', repo: 'my.repo_x', number: 7 });
    } },
    { name: 'not an issue: PR URL, other host, http, sub-path, zero, garbage, non-string', run: () => {
      for (const u of ['https://github.com/up/repo/pull/42', 'https://gitlab.com/up/repo/issues/42',
        'http://github.com/up/repo/issues/42', `${URL42}/comments`, 'https://github.com/up/repo/issues/0',
        'https://github.com/up/repo/issues/42abc', 'up/repo#42', '', '  ', null, undefined, 42, {}]) {
        assert.equal(parseGithubIssueUrl(u), null, String(u));
      }
    } },
  ]);
});

test('issueClosingLine: every §3.2 row', async () => {
  await checkRows([
    { name: 'missing, empty or non-issue sourceUrl -> empty', run: () => {
      for (const sourceUrl of [undefined, null, '', 'https://github.com/up/repo/pull/42', 'https://linear.app/x/issue/ENG-1', 'not a url']) {
        assert.equal(issueClosingLine({ sourceUrl, baseRepo: 'up/repo', body: '' }), '', String(sourceUrl));
      }
      assert.equal(issueClosingLine(), '');
    } },
    { name: 'issue in the base repo -> Closes #N (case-insensitive owner/repo)', run: () => {
      assert.equal(line(), 'Closes #42');
      assert.equal(line({ baseRepo: 'UP/Repo' }), 'Closes #42');
    } },
    { name: 'issue in another repo, or no base repo -> Closes owner/repo#N', run: () => {
      assert.equal(line({ baseRepo: 'me/repo' }), 'Closes up/repo#42');
      assert.equal(line({ baseRepo: null }), 'Closes up/repo#42');
      assert.equal(line({ baseRepo: 'ghe.corp/up/repo' }), 'Closes up/repo#42', 'a GHE slug is not the github.com repo');
    } },
    { name: 'trailing /, ? or # on the source URL still links', run: () => {
      for (const u of [`${URL42}/`, `${URL42}?a=b`, `${URL42}#top`]) assert.equal(line({ sourceUrl: u }), 'Closes #42', u);
    } },
  ]);
});

test('issueClosingLine: nothing added when the body already closes that issue (D4)', async () => {
  const KEYWORDS = ['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved'];
  await checkRows([
    { name: 'each keyword, any case, by #N (same repo)', run: () => {
      for (const k of KEYWORDS) {
        for (const kk of [k, k.toUpperCase(), k[0].toUpperCase() + k.slice(1)]) {
          assert.equal(line({ body: `Did it.\n\n${kk} #42` }), '', kk);
        }
      }
    } },
    { name: 'by owner/repo#N (any case) and by the full URL', run: () => {
      assert.equal(line({ body: 'Fixes UP/repo#42' }), '');
      assert.equal(line({ body: `Resolves ${URL42}` }), '');
      assert.equal(line({ baseRepo: 'me/repo', body: 'closes up/repo#42' }), '');
      assert.equal(line({ baseRepo: 'me/repo', body: `fixed: ${URL42}` }), '', 'GitHub accepts a colon after the keyword');
    } },
    { name: 'not a duplicate: other number, no keyword, cross-repo bare #N, glued keyword', run: () => {
      assert.equal(line({ body: 'Fixes #420' }), 'Closes #42');
      assert.equal(line({ body: 'Fixes #4' }), 'Closes #42');
      assert.equal(line({ body: 'See #42' }), 'Closes #42');
      assert.equal(line({ body: 'prefixes #42' }), 'Closes #42');
      assert.equal(line({ baseRepo: 'me/repo', body: 'Fixes #42' }), 'Closes up/repo#42', '#42 there is me/repo#42');
      assert.equal(line({ body: 'Fixes other/repo#42' }), 'Closes #42');
    } },
  ]);
});
