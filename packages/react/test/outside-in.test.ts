import { expect } from 'chai';
import { MemoryFileSystemProvider } from '@bendyline/docblocks/filesystem';
import type { DocumentCommitRequest } from '@bendyline/docblocks/document';
import {
  createOutsideInDocumentTarget,
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

describe('DocBlocks outside-in editing', () => {
  it('imports an HTML target once and reopens its durable companion Markdown', async () => {
    const provider = new MemoryFileSystemProvider('outside', 'Outside');
    await provider.writeFile('/battle-of-britain.html', '<h1>Battle of Britain</h1>');

    const first = await loadEditableShellDocument(provider, '/battle-of-britain.html');
    expect(first?.sourcePath).to.equal('/battle-of-britain_files/battle-of-britain.md');
    expect(first?.content).to.contain('squisq-output: ../battle-of-britain.html');
    expect(first?.content).to.contain('# Battle of Britain');

    await provider.writeFile(
      '/battle-of-britain_files/battle-of-britain.md',
      first!.content.replace('# Battle of Britain', '# Edited source'),
    );
    const reopened = await loadEditableShellDocument(provider, '/battle-of-britain.html');
    expect(reopened?.content).to.contain('# Edited source');
  });

  it('commits Markdown, rendered HTML, and the shared hierarchy runtime', async () => {
    const provider = new MemoryFileSystemProvider('outside', 'Outside');
    await provider.writeFile('/history/battle.html', '<h1>Original</h1>');
    const opened = await loadEditableShellDocument(provider, '/history/battle.html');
    const target = createOutsideInDocumentTarget(provider, opened!.outsideIn!);
    const next = opened!.content.replace('# Original', '# Saved together');

    await target.commit(request(target.key, next, opened!.content));

    expect(await provider.readFile(opened!.sourcePath)).to.equal(next);
    expect(await provider.readFile('/history/battle.html')).to.contain('Saved together');
    expect(await provider.readFile('/_squisq/squisq-player.js')).to.contain('SquisqPlayer');

    const reopened = await loadEditableShellDocument(provider, '/history/battle.html');
    const secondTarget = createOutsideInDocumentTarget(provider, reopened!.outsideIn!);
    const second = reopened!.content.replace('# Saved together', '# Saved again');
    await secondTarget.commit(request(secondTarget.key, second, reopened!.content));
    expect(await provider.readFile('/history/battle.html')).to.contain('Saved again');
  });
});
