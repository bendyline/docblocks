import { expect } from 'chai';
import { MemoryFileSystemProviderV2, parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import { createWorkspaceIndex } from '@bendyline/docblocks/workspace-index';
import {
  createDocumentLinkCandidates,
  type DocumentLinkTarget,
} from '../src/DocBlocksShell/document-links.js';

describe('document link candidates', () => {
  const file = (name: string, path = name): DocumentLinkTarget => ({ name, path });

  it('returns stable relative candidates, excluding the current document', () => {
    const entries = [
      file('root.md'),
      file('zeta.md', 'docs/zeta.md'),
      file('alpha.md', 'docs/alpha.md'),
    ];
    expect(createDocumentLinkCandidates(entries, 'docs/zeta.md', '')).to.deep.equal([
      { path: 'alpha.md', label: 'alpha', description: 'docs' },
      { path: '../root.md', label: 'root' },
    ]);
  });

  it('lists candidates in the file explorer’s order and strips any Markdown extension', () => {
    const entries = [file('Invoice 10.md'), file('Invoice 2.markdown'), file('apple.mdown')];
    expect(
      createDocumentLinkCandidates(entries, 'current.md', '').map((candidate) => candidate.label),
    ).to.deep.equal(['apple', 'Invoice 2', 'Invoice 10']);
  });

  it('offers the workspace index’s Markdown documents, skipping implementation folders', async () => {
    const provider = new MemoryFileSystemProviderV2('links', 'Links');
    const encode = (text: string) => new TextEncoder().encode(text);
    for (const path of [
      'root.md',
      'docs/alpha.md',
      '.git/x.md',
      'node_modules/y.md',
      'root_files/z.md',
    ]) {
      await provider.writeFile(parseWorkspacePath(path), encode('# Doc\n'), {
        createParents: true,
      });
    }
    await provider.writeFile(parseWorkspacePath('docs/image.png'), encode('png'));
    const index = createWorkspaceIndex({ workspaceId: 'links', source: provider });
    index.start();
    expect(await index.whenListed()).to.equal(true);

    const documents = index.getFiles().filter((entry) => entry.kind === 'markdown');
    expect(createDocumentLinkCandidates(documents, 'root.md', '')).to.deep.equal([
      { path: 'docs/alpha.md', label: 'alpha', description: 'docs' },
    ]);
    index.dispose();
  });
});
