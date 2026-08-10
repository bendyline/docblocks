import { expect } from 'chai';
import { MemoryFileSystemProvider } from '@bendyline/docblocks/filesystem';
import type { DocumentCommitRequest } from '@bendyline/docblocks/document';
import {
  createOutsideInDocumentTarget,
  enableOutsideInMarkdownEditing,
  loadEditableShellDocument,
} from '../src/DocBlocksShell/outside-in.js';

function request(
  targetKey: string,
  content: string,
  persistedContent: string,
): DocumentCommitRequest {
  return {
    targetKey,
    content,
    revision: 2,
    persistedRevision: 1,
    persistedContent,
    reason: 'manual',
  };
}

describe('DocBlocks outside-in editing', function () {
  this.timeout(10_000);
  it('imports an HTML target once and reopens its durable companion Markdown', async () => {
    const provider = new MemoryFileSystemProvider('outside', 'Outside');
    await provider.writeFile('/battle-of-britain.html', '<h1>Battle of Britain</h1>');

    const first = await loadEditableShellDocument(provider, '/battle-of-britain.html');
    expect(first?.sourcePath).to.equal('/battle-of-britain_files/battle-of-britain.md');
    expect(first?.content).to.contain('squisq-output: ../battle-of-britain.html');
    expect(first?.content).to.contain('# Battle of Britain');
    expect(first?.outsideInEditingEnabled).to.equal(false);

    await provider.writeFile(
      '/battle-of-britain_files/battle-of-britain.md',
      first!.content.replace('# Battle of Britain', '# Edited source'),
    );
    const reopened = await loadEditableShellDocument(provider, '/battle-of-britain.html');
    expect(reopened?.content).to.contain('# Edited source');
  });

  it('rejects regeneration until the exact Markdown opt-in is present', async () => {
    const provider = new MemoryFileSystemProvider('outside-guard', 'Outside guard');
    await provider.writeFile('/guarded.html', '<h1>Original</h1>');
    const opened = await loadEditableShellDocument(provider, '/guarded.html');
    const target = createOutsideInDocumentTarget(provider, opened!.outsideIn!);
    const stringOptIn = opened!.content.replace(
      'squisq-output-format: html',
      'squisq-output-format: html\nsquisq-updatefrommarkdown: "true"',
    );

    let caught: unknown;
    try {
      await target.commit(request(target.key, stringOptIn, opened!.content));
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.contain('squisq-updatefrommarkdown: true');
    expect(await provider.readFile('/guarded.html')).to.equal('<h1>Original</h1>');
  });

  it('commits Markdown, rendered HTML, and the shared hierarchy runtime', async () => {
    const provider = new MemoryFileSystemProvider('outside', 'Outside');
    await provider.writeFile('/history/battle.html', '<h1>Original</h1>');
    const opened = await loadEditableShellDocument(provider, '/history/battle.html');
    const editable = await enableOutsideInMarkdownEditing(provider, opened!);
    const target = createOutsideInDocumentTarget(provider, editable.outsideIn);
    const next = editable.content.replace('# Original', '# Saved together');

    await target.commit(request(target.key, next, editable.content));

    expect(await provider.readFile(editable.sourcePath)).to.equal(next);
    expect(await provider.readFile('/history/battle_files/.original/original.html')).to.equal(
      '<h1>Original</h1>',
    );
    expect(await provider.readFile('/history/battle.html')).to.contain('Saved together');
    expect(await provider.readFile('/_squisq/squisq-player.js')).to.contain('SquisqPlayer');

    const reopened = await loadEditableShellDocument(provider, '/history/battle.html');
    expect(reopened?.outsideInEditingEnabled).to.equal(true);
    const reenabled = await enableOutsideInMarkdownEditing(provider, reopened!);
    const secondTarget = createOutsideInDocumentTarget(provider, reenabled.outsideIn);
    const second = reenabled.content.replace('# Saved together', '# Saved again');
    await secondTarget.commit(request(secondTarget.key, second, reenabled.content));
    expect(await provider.readFile('/history/battle.html')).to.contain('Saved again');
    expect(await provider.readFile('/history/battle_files/.original/original.html')).to.equal(
      '<h1>Original</h1>',
    );
  });
});
