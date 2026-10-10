import { expect } from 'chai';
import { FileSystemContentContainer } from '../src/filesystem/filesystem-content-container.js';
import { MemoryFileSystemProvider } from '../src/filesystem/memory-provider.js';

describe('FileSystemContentContainer', () => {
  it('keeps narration sidecars beside their audio when document references include the media folder', async () => {
    const provider = new MemoryFileSystemProvider('narration-container', 'Narration');
    const container = new FileSystemContentContainer(provider, 'nested/notes_files', {
      documentMediaPrefix: 'notes_files',
    });
    await container.writeFile('audio/take.webm', new Uint8Array([1, 2]));
    await container.writeFile(
      'notes_files/audio/take.webm.timing.json',
      new TextEncoder().encode('{}'),
    );
    expect(await container.exists('notes_files/audio/take.webm')).to.equal(true);
    expect(await container.readFile('notes_files/audio/take.webm')).to.deep.equal(
      await container.readFile('audio/take.webm'),
    );
    expect((await container.listFiles()).map((entry) => entry.path).sort()).to.deep.equal([
      'audio/take.webm',
      'audio/take.webm.timing.json',
    ]);
    await container.writeFile('.versions/notes.v1.md', new TextEncoder().encode('old'));
    expect(await provider.exists('nested/notes_files/.versions/notes.v1.md')).to.equal(true);
    await container.removeFile('notes_files/audio/take.webm.timing.json');
    expect(await container.readFile('audio/take.webm.timing.json')).to.equal(null);
    try {
      await container.writeFile('notes_files/../../escape', new Uint8Array([0]));
      throw new Error('accepted traversal');
    } catch (error: unknown) {
      expect(String(error)).not.to.contain('accepted traversal');
    }
  });
  it('lists content under prefixes containing regular-expression metacharacters', async () => {
    const provider = new MemoryFileSystemProvider('container-prefix', 'Container');
    await provider.writeBinary('/[draft/image.png', new Uint8Array([1, 2, 3]));
    const container = new FileSystemContentContainer(provider, '[draft');

    expect(await container.listFiles()).to.deep.equal([
      { path: 'image.png', mimeType: 'image/png', size: 3 },
    ]);
  });

  it('preserves nested file paths and prefix scans from a root-scoped container', async () => {
    const provider = new MemoryFileSystemProvider('root-container', 'Container');
    await provider.writeBinary(
      '/notes_files/video/camera+audio-recording.webm',
      new Uint8Array([1, 2, 3]),
    );
    const container = new FileSystemContentContainer(provider, '');

    const expected = [
      {
        path: 'notes_files/video/camera+audio-recording.webm',
        mimeType: 'video/webm',
        size: 3,
      },
    ];
    expect(await container.listFiles()).to.deep.equal(expected);
    expect(await container.listFiles('notes_files/')).to.deep.equal(expected);
  });

  it('propagates directory failures instead of returning a partial backup', async () => {
    class FailingDirectoryProvider extends MemoryFileSystemProvider {
      override async readDirectory(): Promise<never> {
        throw new DOMException('permission revoked', 'NotAllowedError');
      }
    }

    const provider = new FailingDirectoryProvider('container-errors', 'Container');
    // Exercise the transitional v1 fallback explicitly; normal Memory providers
    // expose the direct v2 implementation and no longer call this override.
    Object.defineProperty(provider, 'v2', { value: undefined });
    const container = new FileSystemContentContainer(provider);
    let failure: unknown;
    try {
      await container.listFiles();
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).to.be.instanceOf(DOMException);
    expect((failure as DOMException).name).to.equal('NotAllowedError');
  });
});
