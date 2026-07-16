import { expect } from 'chai';
import { MemoryFileSystemProvider, parseWorkspacePath } from '@bendyline/docblocks/filesystem';
import { copyTransientWorkspaceContents } from '../src/DocBlocksShell/transient-workspace-move.js';

describe('copyTransientWorkspaceContents', () => {
  it('copies the complete Markdown, media, and directory tree without changing the source', async () => {
    const source = new MemoryFileSystemProvider('temporary', 'Temporary document');
    const destination = new MemoryFileSystemProvider('workspace', 'My Documents');
    try {
      source.seedText('notes.md', '# Notes');
      await source.v2.writeFile(
        parseWorkspacePath('notes_files/image.png'),
        new Uint8Array([1, 2, 3, 4]),
        { mode: 'create', createParents: true },
      );
      await source.v2.createDirectory(parseWorkspacePath('empty'), { mode: 'create' });

      await copyTransientWorkspaceContents(source, destination);

      expect(await destination.readFile('notes.md')).to.equal('# Notes');
      const image = await destination.v2.readFile(parseWorkspacePath('notes_files/image.png'));
      expect(Array.from(new Uint8Array(image?.data ?? new ArrayBuffer(0)))).to.deep.equal([
        1, 2, 3, 4,
      ]);
      expect((await destination.v2.stat(parseWorkspacePath('empty')))?.kind).to.equal('directory');
      expect(await source.readFile('notes.md')).to.equal('# Notes');
      expect(await source.v2.stat(parseWorkspacePath('notes_files/image.png'))).not.to.equal(null);
    } finally {
      await source.v2.dispose();
      await destination.v2.dispose();
    }
  });

  it('rejects a destination collision before creating any companion content', async () => {
    const source = new MemoryFileSystemProvider('temporary-collision', 'Temporary document');
    const destination = new MemoryFileSystemProvider('workspace-collision', 'My Documents');
    try {
      source.seedText('notes.md', '# New notes');
      await source.v2.writeFile(parseWorkspacePath('notes_files/image.png'), new Uint8Array([9]), {
        mode: 'create',
        createParents: true,
      });
      destination.seedText('notes.md', '# Existing notes');

      let thrown: unknown;
      try {
        await copyTransientWorkspaceContents(source, destination);
      } catch (error: unknown) {
        thrown = error;
      }

      expect(thrown).to.be.instanceOf(Error);
      expect((thrown as Error).message).to.include('notes.md');
      expect(await destination.readFile('notes.md')).to.equal('# Existing notes');
      expect(await destination.v2.stat(parseWorkspacePath('notes_files'))).to.equal(null);
    } finally {
      await source.v2.dispose();
      await destination.v2.dispose();
    }
  });
});
