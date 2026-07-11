import { expect } from 'chai';
import { FileSystemContentContainer } from '../src/filesystem/filesystem-content-container.js';
import { MemoryFileSystemProvider } from '../src/filesystem/memory-provider.js';

describe('FileSystemContentContainer', () => {
  it('lists content under prefixes containing regular-expression metacharacters', async () => {
    const provider = new MemoryFileSystemProvider('container-prefix', 'Container');
    await provider.writeBinary('/[draft/image.png', new Uint8Array([1, 2, 3]));
    const container = new FileSystemContentContainer(provider, '[draft');

    expect(await container.listFiles()).to.deep.equal([
      { path: 'image.png', mimeType: 'image/png', size: 3 },
    ]);
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
