import { expect } from 'chai';
import { NativeFileSystemProvider } from '../src/filesystem/native-provider.js';
import { NativeFileSystemEmulator, nativeDomError } from './helpers/native-file-system-emulator.js';
import { defineFileSystemProviderV1Conformance } from './helpers/filesystem-v1-conformance.js';

function domError(name: string, message = name): DOMException {
  return new DOMException(message, name);
}

async function captureRejection(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('Expected operation to reject');
}

function mockFile(name: string, bytes = new Uint8Array([1, 2, 3])): File {
  return {
    name,
    size: bytes.byteLength,
    lastModified: 1,
    arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
    text: async () => new TextDecoder().decode(bytes),
  } as unknown as File;
}

describe('NativeFileSystemProvider', () => {
  it('writes only the visible bytes for sliced Uint8Array binary data', async () => {
    const writes: unknown[] = [];
    const writable = {
      write: async (chunk: unknown) => {
        writes.push(chunk);
      },
      close: async () => undefined,
    } as unknown as FileSystemWritableFileStream;
    const fileHandle = {
      createWritable: async () => writable,
    } as unknown as FileSystemFileHandle;
    const root = {
      name: 'root',
      kind: 'directory',
      getDirectoryHandle: async () => root as unknown as FileSystemDirectoryHandle,
      getFileHandle: async () => fileHandle,
    } as unknown as FileSystemDirectoryHandle;

    const provider = new NativeFileSystemProvider('native-test', root);
    const backing = new Uint8Array([1, 2, 3, 4]).buffer;

    await provider.writeBinary('/file.bin', new Uint8Array(backing, 1, 2));

    expect(writes).to.have.length(1);
    expect(writes[0]).to.be.instanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(writes[0] as ArrayBuffer))).to.deep.equal([2, 3]);
  });

  it('propagates permission failures instead of reporting a missing file', async () => {
    const root = {
      name: 'root',
      kind: 'directory',
      getFileHandle: async () => {
        throw domError('NotAllowedError', 'permission revoked');
      },
    } as unknown as FileSystemDirectoryHandle;

    const provider = new NativeFileSystemProvider('native-permission', root);
    const error = await captureRejection(() => provider.readFile('/secret.md'));

    expect(error).to.be.instanceOf(DOMException);
    expect((error as DOMException).name).to.equal('NotAllowedError');
  });

  it('returns null only for an expected missing-file failure', async () => {
    const root = {
      name: 'root',
      kind: 'directory',
      getFileHandle: async () => {
        throw domError('NotFoundError');
      },
    } as unknown as FileSystemDirectoryHandle;

    const provider = new NativeFileSystemProvider('native-missing', root);
    expect(await provider.readFile('/missing.md')).to.equal(null);
  });

  it('rejects a file move when the destination write fails', async () => {
    const sourceHandle = {
      kind: 'file',
      name: 'source.md',
      getFile: async () => mockFile('source.md'),
    } as unknown as FileSystemFileHandle;
    const destinationHandle = {
      kind: 'file',
      name: 'destination.md',
      createWritable: async () =>
        ({
          write: async () => {
            throw domError('QuotaExceededError', 'disk full');
          },
          close: async () => undefined,
          abort: async () => undefined,
        }) as unknown as FileSystemWritableFileStream,
    } as unknown as FileSystemFileHandle;
    const removed: string[] = [];
    const root = {
      name: 'root',
      kind: 'directory',
      getFileHandle: async (name: string, options?: { create?: boolean }) => {
        if (name === 'source.md') return sourceHandle;
        if (name === 'destination.md' && options?.create) return destinationHandle;
        throw domError('NotFoundError');
      },
      getDirectoryHandle: async () => {
        throw domError('NotFoundError');
      },
      removeEntry: async (name: string) => {
        removed.push(name);
      },
    } as unknown as FileSystemDirectoryHandle;

    const provider = new NativeFileSystemProvider('native-write-failure', root);
    const error = await captureRejection(() => provider.rename('/source.md', '/destination.md'));

    expect((error as DOMException).name).to.equal('QuotaExceededError');
    expect(removed).to.deep.equal([]);
  });

  it('rolls back the destination and rejects when source deletion fails', async () => {
    const sourceHandle = {
      kind: 'file',
      name: 'source.md',
      getFile: async () => mockFile('source.md'),
    } as unknown as FileSystemFileHandle;
    const destinationHandle = {
      kind: 'file',
      name: 'destination.md',
      createWritable: async () =>
        ({
          write: async () => undefined,
          close: async () => undefined,
          abort: async () => undefined,
        }) as unknown as FileSystemWritableFileStream,
    } as unknown as FileSystemFileHandle;
    const removed: string[] = [];
    const root = {
      name: 'root',
      kind: 'directory',
      getFileHandle: async (name: string, options?: { create?: boolean }) => {
        if (name === 'source.md') return sourceHandle;
        if (name === 'destination.md' && options?.create) return destinationHandle;
        throw domError('NotFoundError');
      },
      getDirectoryHandle: async () => {
        throw domError('NotFoundError');
      },
      removeEntry: async (name: string) => {
        removed.push(name);
        if (name === 'source.md') throw domError('NotAllowedError', 'source is locked');
      },
    } as unknown as FileSystemDirectoryHandle;

    const provider = new NativeFileSystemProvider('native-delete-failure', root);
    const error = await captureRejection(() => provider.rename('/source.md', '/destination.md'));

    expect((error as DOMException).name).to.equal('NotAllowedError');
    expect(removed).to.deep.equal(['source.md', 'destination.md']);
  });

  it('restores a directory gutted by a partial delete and removes the copy', async () => {
    const fileSystem = new NativeFileSystemEmulator();
    fileSystem.seedFile('/source/a.md', 'alpha');
    fileSystem.seedFile('/source/b.md', 'bravo');
    // Removing a directory is not atomic: the delete takes 'a.md' and then
    // fails, leaving the source present but missing a child.
    fileSystem.failRemoveAfterDeleting(
      '/source',
      ['a.md'],
      nativeDomError('NotAllowedError', 'entry locked'),
    );

    const provider = new NativeFileSystemProvider('native-partial-delete', fileSystem.rootHandle);
    const error = await captureRejection(() => provider.rename('/source', '/destination'));

    expect((error as DOMException).name).to.equal('NotAllowedError');
    expect(fileSystem.readBytes('/source/a.md')).to.deep.equal([...encoded('alpha')]);
    expect(fileSystem.readBytes('/source/b.md')).to.deep.equal([...encoded('bravo')]);
    expect(fileSystem.exists('/destination')).to.equal(false);
  });

  it('keeps the copy when a directory gutted by a partial delete cannot be restored', async () => {
    const fileSystem = new NativeFileSystemEmulator();
    fileSystem.seedFile('/source/a.md', 'alpha');
    fileSystem.seedFile('/source/b.md', 'bravo');
    fileSystem.failRemoveAfterDeleting(
      '/source',
      ['a.md'],
      nativeDomError('NotAllowedError', 'entry locked'),
    );
    // Rebuilding the source from the copy fails too, so it cannot be made whole.
    fileSystem.failNext('write', '/source/a.md', nativeDomError('NotAllowedError', 'read-only'));

    const provider = new NativeFileSystemProvider('native-partial-keep', fileSystem.rootHandle);
    const error = await captureRejection(() => provider.rename('/source', '/destination'));

    // The copy is the only complete one left; rollback must not delete it.
    expect((error as Error).name).to.equal('NativeMoveRecoveryError');
    expect(fileSystem.readBytes('/destination/a.md')).to.deep.equal([...encoded('alpha')]);
    expect(fileSystem.readBytes('/destination/b.md')).to.deep.equal([...encoded('bravo')]);
  });
});

function encoded(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

defineFileSystemProviderV1Conformance(
  'NativeFileSystemProvider',
  () =>
    new NativeFileSystemProvider('native-conformance', new NativeFileSystemEmulator().rootHandle),
);
