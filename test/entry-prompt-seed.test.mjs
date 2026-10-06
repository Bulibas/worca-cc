import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPromptArtifact, renderAttachmentsBlock } from '../src/core/phases.mjs';
import { checkRows } from './helpers/rows.mjs';

test('renderPromptArtifact and renderAttachmentsBlock: request + attachments only when present', async () => {
  await checkRows([
    { name: 'renderPromptArtifact embeds the request and lists attachments only when there are some', run: async () => {
      await checkRows([
        { name: 'renderPromptArtifact embeds the request and lists attachments', run: async () => {
          const md = renderPromptArtifact('BUILD THE THING', [{ name: 'spec.md', path: '/pipe/extras/spec.md' }]);
          assert.match(md, /No upstream agent produced this artifact/);
          assert.match(md, /## Original request/);
          assert.match(md, /BUILD THE THING/);
          assert.match(md, /## Attached files/);
          assert.match(md, /\/pipe\/extras\/spec\.md/);
        } },
        { name: 'renderPromptArtifact omits the attachments section when there are none', run: async () => {
          assert.doesNotMatch(renderPromptArtifact('X', []), /## Attached files/);
        } },
      ]);
    } },
    { name: 'renderAttachmentsBlock is the single source for the attachments list', run: () => {
      assert.equal(renderAttachmentsBlock([]), '');
      const block = renderAttachmentsBlock([{ name: 'a.txt', path: '/pipe/extras/a.txt' }]);
      assert.match(block, /## Attached files/);
      assert.match(block, /- `\/pipe\/extras\/a\.txt` \(a\.txt\)/);
    } },
  ]);
});
