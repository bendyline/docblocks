import { expect } from 'chai';
import { NativeFileSystemProvider } from '../src/filesystem/native-provider.js';

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
});
