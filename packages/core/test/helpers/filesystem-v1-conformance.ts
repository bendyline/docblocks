import { expect } from 'chai';
import { FsError } from '../../src/filesystem/fs-error.js';
import type { FileSystemProvider } from '../../src/filesystem/types.js';

export type FileSystemProviderV1Factory =
  | (() => FileSystemProvider)
  | (() => Promise<FileSystemProvider>);

/** Bytes that are not valid UTF-8: a lone continuation byte and a bare 0xFF. */
export const INVALID_UTF8 = new Uint8Array([0x68, 0x69, 0x80, 0xff]);

/**
 * Shared behavioral contract for the v1 FileSystemProvider facades.
 *
 * `FileSystemProvider` is a seam: callers pick a backend once and then program
 * against the interface. Anything a caller can observe differently across
 * backends is a defect in the seam, so these cases are deliberately about
 * agreement rather than about any one backend's internals.
 */
export function defineFileSystemProviderV1Conformance(
  name: string,
  factory: FileSystemProviderV1Factory,
): void {
  describe(`${name} FileSystemProvider conformance`, () => {
    let provider: FileSystemProvider;

    beforeEach(async () => {
      provider = await factory();
    });

    it('refuses to decode a file whose bytes are not valid UTF-8', async () => {
      await provider.writeBinary('/payload.bin', INVALID_UTF8);

      // Replacement characters here are a data-loss trap, not a display glitch:
      // the caller would hold mojibake that its next save writes back over the
      // user's original bytes. The read must fail instead.
      const error = await captureRejection(() => provider.readFile('/payload.bin'));
      expect(
        error,
        'readFile must reject rather than return replacement characters',
      ).to.be.instanceOf(FsError);
      expect((error as FsError).code).to.equal('corrupt');
      expect((error as FsError).message).to.match(/UTF-8/);

      // The bytes must still be intact and reachable through the byte API.
      expect([...new Uint8Array((await provider.readBinary('/payload.bin'))!)]).to.deep.equal([
        ...INVALID_UTF8,
      ]);
    });

    it('refuses to commit against a baseline it cannot decode', async () => {
      if (!provider.commitFile) return;
      await provider.writeBinary('/payload.bin', INVALID_UTF8);

      const error = await captureRejection(() =>
        provider.commitFile!('/payload.bin', 'replacement', null),
      );
      expect(error, 'commitFile must not silently overwrite undecodable bytes').to.be.instanceOf(
        FsError,
      );
      expect((error as FsError).code).to.equal('corrupt');
      expect([...new Uint8Array((await provider.readBinary('/payload.bin'))!)]).to.deep.equal([
        ...INVALID_UTF8,
      ]);
    });

    it('reads any existing file as bytes regardless of how it was written', async () => {
      await provider.writeFile('/note.md', 'written as text');

      const binary = await provider.readBinary('/note.md');
      expect(binary, 'readBinary must not report an existing file as missing').not.to.equal(null);
      expect([...new Uint8Array(binary!)]).to.deep.equal([
        ...new TextEncoder().encode('written as text'),
      ]);
    });

    it('reports a missing file as null from both read APIs', async () => {
      expect(await provider.readFile('/absent.md')).to.equal(null);
      expect(await provider.readBinary('/absent.md')).to.equal(null);
      expect(await provider.stat('/absent.md')).to.equal(null);
      expect(await provider.exists('/absent.md')).to.equal(false);
    });

    it('treats the workspace root as an existing directory', async () => {
      expect(await provider.exists('/')).to.equal(true);
      // stat() reports files; the root is a directory, so it has no metadata —
      // and a non-file path is null everywhere else, not an error.
      expect(await provider.stat('/')).to.equal(null);
      // Ensuring a directory that already exists is a no-op, as for `mkdir -p`.
      await provider.createDirectory('/');
      expect(await provider.exists('/')).to.equal(true);
    });

    it('rejects reading the root as a file with a kind error', async () => {
      for (const read of [() => provider.readFile('/'), () => provider.readBinary('/')]) {
        const error = await captureRejection(read);
        expect(error).to.be.instanceOf(FsError);
        expect((error as FsError).code).to.equal('type-mismatch');
        // The root is a read target that exists and is simply the wrong kind, so
        // the message must not describe it as a rejected mutation target.
        expect((error as FsError).message).not.to.match(/mutation target/);
      }
    });

    it('rejects mutating the root with one invalid-path error', async () => {
      const mutations: Array<() => Promise<unknown>> = [
        () => provider.writeFile('/', 'x'),
        () => provider.writeBinary('/', new Uint8Array([1])),
        () => provider.delete('/'),
        () => provider.rename('/', '/moved'),
      ];
      for (const mutation of mutations) {
        const error = await captureRejection(mutation);
        expect(error).to.be.instanceOf(FsError);
        expect((error as FsError).code).to.equal('invalid-path');
      }
    });

    it('rejects reading a directory as a file with a kind error', async () => {
      await provider.createDirectory('/folder');
      for (const read of [
        () => provider.readFile('/folder'),
        () => provider.readBinary('/folder'),
      ]) {
        const error = await captureRejection(read);
        expect(error, 'a directory is the wrong kind, not an absent file').to.be.instanceOf(
          FsError,
        );
        expect((error as FsError).code).to.equal('type-mismatch');
      }
      // stat() is the one read that reports a non-file as null rather than failing.
      expect(await provider.stat('/folder')).to.equal(null);
    });

    it('round-trips text and binary through one byte-authoritative entry', async () => {
      await provider.writeFile('/doc.md', '# hello');
      expect(await provider.readFile('/doc.md')).to.equal('# hello');

      await provider.writeBinary('/doc.md', new Uint8Array([0x62, 0x79, 0x65]));
      expect(await provider.readFile('/doc.md')).to.equal('bye');
      expect([...new Uint8Array((await provider.readBinary('/doc.md'))!)]).to.deep.equal([
        0x62, 0x79, 0x65,
      ]);
    });
  });
}

async function captureRejection(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('Expected the operation to reject.');
}
