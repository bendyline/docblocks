import { expect } from 'chai';
import {
  describePartialMove,
  documentCompanionPath,
  FileSystemMoveRecoveryError,
  FileSystemPartialMoveError,
  MemoryFileSystemProvider,
  moveFileSystemEntry,
  FileSystemContentContainer,
  createFileMediaProvider,
  rewriteCompanionReferences,
} from '@bendyline/docblocks/filesystem';
import { DocumentSession, createFileSystemDocumentTarget } from '@bendyline/docblocks/document';

describe('moveFileSystemEntry', () => {
  it('keeps Markdown image, reference, audio and video targets valid after a basename rename', async () => {
    const fs = new MemoryFileSystemProvider('rename-media', 'Media');
    await fs.writeFile(
      'notes.md',
      [
        '![Photo](notes_files/photo.png)',
        '[Audio][sound]',
        '[sound]: notes_files/sound.mp3',
        '<video src="notes_files/movie.mp4"></video>',
        '<audio src="notes_files/sound.mp3"></audio>',
        '`notes_files/photo.png`',
        'Literal notes_files/photo.png',
        '![External](https://example.com/notes_files/photo.png)',
      ].join('\n\n'),
    );
    for (const name of ['photo.png', 'sound.mp3', 'movie.mp4']) {
      await fs.writeBinary(`notes_files/${name}`, new Uint8Array([1, 2, 3]));
    }
    await moveFileSystemEntry(fs, 'notes.md', 'renamed.md', 'file');
    const content = await fs.readFile('renamed.md');
    expect(content).to.contain('renamed_files/photo.png');
    expect(content).to.contain('renamed_files/sound.mp3');
    expect(content).to.contain('renamed_files/movie.mp4');
    expect(content).to.contain('src="renamed_files/sound.mp3"');
    expect(content).to.contain('`notes_files/photo.png`');
    expect(content).to.contain('Literal notes_files/photo.png');
    expect(content).to.contain('https://example.com/notes_files/photo.png');
    const media = createFileMediaProvider(new FileSystemContentContainer(fs, ''), 'renamed.md');
    expect(await media.resolveUrl('renamed_files/photo.png')).to.match(/^blob:/);
    media.dispose?.();
    await fs.v2.dispose();
  });

  it('retargets an active session before rewriting its media and preserves the next edit', async () => {
    const fs = new MemoryFileSystemProvider('active-rename-media', 'Active media');
    const initial = '![Photo](notes_files/photo.png)';
    await fs.writeFile('notes.md', initial);
    await fs.writeBinary('notes_files/photo.png', new Uint8Array([1, 2, 3]));
    const session = new DocumentSession({ autoSaveEnabled: false });
    try {
      await session.transitionTo(createFileSystemDocumentTarget(fs, 'notes.md'), initial);
      const moved = await session.retarget(createFileSystemDocumentTarget(fs, 'renamed.md'), () =>
        moveFileSystemEntry(fs, 'notes.md', 'renamed.md', 'file', { rewriteMarkdown: false }),
      );
      const scope = { targetKey: moved.targetKey!, generation: moved.generation };
      session.edit(
        await rewriteCompanionReferences(moved.content, 'notes.md', 'renamed.md'),
        scope,
      );
      await session.flush();
      session.edit(`${session.getSnapshot().content}\n\nContinued editing.`, scope);
      await session.flush();
      expect(session.getSnapshot().status).to.equal('saved');
      expect(await fs.readFile('renamed.md')).to.contain('renamed_files/photo.png');
      expect(await fs.readFile('renamed.md')).to.contain('Continued editing.');
      expect(await fs.exists('notes.md')).to.equal(false);
    } finally {
      await session.cancel();
      await fs.v2.dispose();
    }
  });
  for (const extension of ['html', 'htm', 'docx', 'pdf', 'pptx', 'xlsx', 'csv']) {
    it(`moves the ${extension} companion and assets when renaming`, async () => {
      const fs = new MemoryFileSystemProvider(`move-${extension}`, 'Move');
      await fs.writeBinary(`old.${extension}`, new Uint8Array([1, 2, 3]));
      await fs.writeFile('old_files/old.md', '# Source');
      await fs.writeBinary('old_files/image.png', new Uint8Array([4, 5]));
      await moveFileSystemEntry(fs, `old.${extension}`, `new.${extension}`, 'file');
      expect(await fs.readFile('new_files/old.md')).to.equal('# Source');
      expect(await fs.exists('new_files/image.png')).to.equal(true);
      expect(await fs.exists('old_files')).to.equal(false);
      await fs.v2.dispose();
    });
  }
  it('derives a sibling companion directory at any nesting depth', () => {
    expect(documentCompanionPath('/notes.md')).to.equal('/notes_files');
    expect(documentCompanionPath('guides/start.md')).to.equal('guides/start_files');
  });

  it('moves a markdown file and its companion directory together', async () => {
    const fs = new MemoryFileSystemProvider('move', 'Move');
    await fs.writeFile('/notes.md', '# Notes');
    await fs.writeBinary('/notes_files/image.png', new Uint8Array([1, 2, 3]));
    await fs.createDirectory('/archive');

    await moveFileSystemEntry(fs, '/notes.md', '/archive/notes.md', 'file');

    expect(await fs.exists('/notes.md')).to.equal(false);
    expect(await fs.exists('/notes_files')).to.equal(false);
    expect(await fs.readFile('/archive/notes.md')).to.equal('# Notes');
    expect(await fs.exists('/archive/notes_files/image.png')).to.equal(true);
  });

  it('renames the companion directory when the markdown basename changes', async () => {
    const fs = new MemoryFileSystemProvider('rename', 'Rename');
    await fs.writeFile('/draft.md', 'draft');
    await fs.writeFile('/draft_files/.versions/1.md', 'v1');

    await moveFileSystemEntry(fs, '/draft.md', '/final.md', 'file');

    expect(await fs.readFile('/final.md')).to.equal('draft');
    expect(await fs.readFile('/final_files/.versions/1.md')).to.equal('v1');
    expect(await fs.exists('/draft_files')).to.equal(false);
  });

  it('moves an outside-in rendered file with its editable companion', async () => {
    const fs = new MemoryFileSystemProvider('outside-in-move', 'Outside-in move');
    await fs.writeBinary('/Tucson.pptx', new Uint8Array([1, 2, 3]));
    await fs.writeFile('/Tucson_files/tucson.md', '# Tucson');
    await fs.createDirectory('/archive');

    await moveFileSystemEntry(fs, '/Tucson.pptx', '/archive/Phoenix.pptx', 'file');

    expect(await fs.exists('/Tucson.pptx')).to.equal(false);
    expect(await fs.exists('/Tucson_files')).to.equal(false);
    expect(await fs.exists('/archive/Phoenix.pptx')).to.equal(true);
    expect(await fs.readFile('/archive/Phoenix_files/tucson.md')).to.equal('# Tucson');
  });

  it('rejects a move when the destination or companion destination exists', async () => {
    const fs = new MemoryFileSystemProvider('collision', 'Collision');
    await fs.writeFile('/notes.md', 'notes');
    await fs.writeFile('/notes_files/image.png', 'image');
    await fs.writeFile('/archive/notes.md', 'existing');

    let message = '';
    try {
      await moveFileSystemEntry(fs, '/notes.md', '/archive/notes.md', 'file');
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).to.contain('already exists');
    expect(await fs.readFile('/notes.md')).to.equal('notes');

    await fs.delete('/archive/notes.md');
    await fs.writeFile('/archive/notes_files/existing.png', 'existing image');
    message = '';
    try {
      await moveFileSystemEntry(fs, '/notes.md', '/archive/notes.md', 'file');
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).to.contain('companion folder');
    expect(await fs.readFile('/notes.md')).to.equal('notes');
  });

  it('probes v2 authority when the compatibility facade reports stale presence', async () => {
    class StalePresenceProvider extends MemoryFileSystemProvider {
      override async exists(): Promise<boolean> {
        return false;
      }
    }

    const fs = new StalePresenceProvider('presence', 'Presence');
    await fs.writeFile('/source.md', 'source');
    const state = await describePartialMove(
      fs,
      '/source.md',
      '/destination.md',
      '/source_files',
      '/destination_files',
    );

    expect(state).to.deep.equal({
      source: 'present',
      destination: 'missing',
      companionSource: 'missing',
      companionDestination: 'missing',
    });
  });

  it('reports first-move destination state when a backend throws after moving', async () => {
    const fs = new MemoryFileSystemProvider('first-partial', 'First partial');
    const move = fs.v2.move.bind(fs.v2);
    fs.v2.move = async (oldPath, newPath, options) => {
      const result = await move(oldPath, newPath, options);
      if (oldPath === 'notes.md' && newPath === 'archive/notes.md') {
        throw new Error('backend acknowledgement failed');
      }
      return result;
    };
    await fs.writeFile('/notes.md', 'notes');
    await fs.createDirectory('/archive');

    let failure: unknown;
    try {
      await moveFileSystemEntry(fs, '/notes.md', '/archive/notes.md', 'file');
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(FileSystemMoveRecoveryError);
    const recovery = failure as FileSystemMoveRecoveryError;
    expect(recovery.location).to.equal('destination');
    expect(recovery.state).to.deep.equal({ source: 'missing', destination: 'present' });
  });

  it('reports companion partial state even when the document rollback succeeds', async () => {
    const fs = new MemoryFileSystemProvider('companion-partial', 'Companion partial');
    const move = fs.v2.move.bind(fs.v2);
    fs.v2.move = async (oldPath, newPath, options) => {
      const result = await move(oldPath, newPath, options);
      if (oldPath === 'notes_files' && newPath === 'archive/notes_files') {
        throw new Error('companion acknowledgement failed');
      }
      return result;
    };
    await fs.writeFile('/notes.md', 'notes');
    await fs.writeFile('/notes_files/image.png', 'image');
    await fs.createDirectory('/archive');

    let failure: unknown;
    try {
      await moveFileSystemEntry(fs, '/notes.md', '/archive/notes.md', 'file');
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(FileSystemPartialMoveError);
    const partial = failure as FileSystemPartialMoveError;
    expect(partial.documentLocation).to.equal('source');
    expect(partial.companionLocation).to.equal('destination');
  });

  it('reports authoritative path state when companion failure cannot roll back the document', async () => {
    const fs = new MemoryFileSystemProvider('partial', 'Partial');
    const move = fs.v2.move.bind(fs.v2);
    fs.v2.move = async (oldPath, newPath, options) => {
      if (oldPath === 'notes_files') throw new Error('companion move failed');
      if (oldPath === 'archive/notes.md') throw new Error('document rollback failed');
      return move(oldPath, newPath, options);
    };
    await fs.writeFile('/notes.md', 'notes');
    await fs.writeFile('/notes_files/image.png', 'image');
    await fs.createDirectory('/archive');

    let failure: unknown;
    try {
      await moveFileSystemEntry(fs, '/notes.md', '/archive/notes.md', 'file');
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(FileSystemPartialMoveError);
    const partial = failure as FileSystemPartialMoveError;
    expect(partial.documentLocation).to.equal('destination');
    expect(partial.companionLocation).to.equal('source');
    expect(partial.state).to.deep.equal({
      source: 'missing',
      destination: 'present',
      companionSource: 'present',
      companionDestination: 'missing',
    });
  });
});
