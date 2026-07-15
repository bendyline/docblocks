import { expect } from 'chai';
import {
  FileSystemMoveRecoveryError,
  NativeFileSystemMoveRecoveryError,
  NativeFileSystemProvider,
  NativeFileSystemProviderV2,
  WORKSPACE_ROOT,
  parseWorkspacePath,
  moveFileSystemEntry,
} from '../src/filesystem/index.js';
import {
  defineFileSystemProviderV2Conformance,
  expectFsError,
} from './helpers/filesystem-v2-conformance.js';
import { NativeFileSystemEmulator, nativeDomError } from './helpers/native-file-system-emulator.js';

let providerId = 0;
defineFileSystemProviderV2Conformance('Native File System Access', () => {
  const fileSystem = new NativeFileSystemEmulator();
  return new NativeFileSystemProviderV2(`native-v2-${++providerId}`, fileSystem.rootHandle);
});

describe('NativeFileSystemProviderV2', () => {
  it('declares conservative browser-handle capabilities', async () => {
    const { provider } = setup('capabilities');
    expect(provider.capabilities).to.deep.equal({
      writeAtomicity: 'none',
      moveAtomicity: 'none',
      snapshotAtomicity: 'none',
      conditionalWrite: 'process',
      recursiveRemove: true,
      watch: false,
      caseSensitivity: 'platform',
      symlinkPolicy: 'unsupported',
      durability: 'best-effort',
    });
    expect(Object.isFrozen(provider.capabilities)).to.equal(true);
    await provider.dispose();
  });

  it('uses metadata versions without materializing payloads for stat or listing', async () => {
    const { fileSystem, provider } = setup('metadata-scan');
    const directoryPath = parseWorkspacePath('/docs');
    const filePath = parseWorkspacePath('/docs/note.md');
    const nestedFilePath = parseWorkspacePath('/docs/nested/other.md');
    fileSystem.seedFile('/docs/note.md', 'note');
    fileSystem.seedFile('/docs/nested/other.md', 'other');
    fileSystem.resetOperationCounts();

    const rootBefore = await provider.stat(WORKSPACE_ROOT);
    const directoryBefore = await provider.stat(directoryPath);
    const fileBefore = await provider.stat(filePath);
    const listing = await provider.readDirectory(directoryPath);
    await provider.move(filePath, filePath);

    expect(fileSystem.operationCount('array-buffer')).to.equal(0);
    expect(listing.find((entry) => entry.path === filePath)?.version).to.equal(fileBefore?.version);

    const read = await provider.readFile(filePath);
    expect(fileSystem.operationCount('array-buffer')).to.equal(1);
    expect(fileSystem.operationCount('array-buffer', '/docs/note.md')).to.equal(1);
    expect(read?.entry.version).to.equal(fileBefore?.version);
    expect(decoded(read?.data)).to.equal('note');

    fileSystem.resetOperationCounts();
    const snapshot = await provider.snapshot();
    expect(fileSystem.operationCount('array-buffer')).to.equal(2);
    expect(fileSystem.operationCount('array-buffer', '/docs/note.md')).to.equal(1);
    expect(fileSystem.operationCount('array-buffer', '/docs/nested/other.md')).to.equal(1);
    expect(snapshot.version).to.equal(rootBefore?.version);
    expect(snapshot.entries.find((entry) => entry.path === directoryPath)?.version).to.equal(
      directoryBefore?.version,
    );
    expect(snapshot.entries.find((entry) => entry.path === filePath)?.version).to.equal(
      fileBefore?.version,
    );
    expect(snapshot.entries.find((entry) => entry.path === nestedFilePath)?.kind).to.equal('file');
    await provider.dispose();
  });

  it('retains the precise operation and path when payload materialization fails', async () => {
    const { fileSystem, provider } = setup('payload-fault-context');
    const path = parseWorkspacePath('/note.md');
    fileSystem.seedFile('/note.md', 'note');
    fileSystem.failNext(
      'array-buffer',
      '/note.md',
      nativeDomError('NotReadableError', 'payload unavailable'),
    );

    const error = await expectFsError(provider.readFile(path), 'io');
    expect(error.operation).to.equal('read');
    expect(error.path).to.equal(path);
    await provider.dispose();
  });

  it('shares one byte-authoritative root and mutation boundary with the v1 facade', async () => {
    const fileSystem = new NativeFileSystemEmulator();
    const legacy = new NativeFileSystemProvider('native-shared', fileSystem.rootHandle);
    expect(legacy.v2).to.be.instanceOf(NativeFileSystemProviderV2);

    await legacy.writeBinary('/note.md', encoded('v1 baseline'));
    const baseline = await legacy.v2.readFile(parseWorkspacePath('/note.md'));
    expect(decoded(baseline?.data)).to.equal('v1 baseline');

    await legacy.writeBinary('/note.md', encoded('external v1'));
    await expectFsError(
      legacy.v2.writeFile(parseWorkspacePath('/note.md'), encoded('stale v2'), {
        expectedVersion: baseline!.entry.version,
      }),
      'conflict',
    );
    await legacy.v2.writeFile(parseWorkspacePath('/note.md'), encoded('fresh v2'));
    expect(decoded(await legacy.readBinary('/note.md'))).to.equal('fresh v2');
    await legacy.v2.dispose();
  });

  it('maps revoked handle permission to a typed permission error', async () => {
    const { fileSystem, provider } = setup('permission');
    fileSystem.failNext(
      'get-file',
      '/secret.md',
      nativeDomError('NotAllowedError', 'permission revoked'),
    );

    const error = await expectFsError(
      provider.readFile(parseWorkspacePath('/secret.md')),
      'permission-denied',
    );
    expect(error.operation).to.equal('read');
    await provider.dispose();
  });

  it('removes a newly created target and parent directories after a write fault', async () => {
    const { fileSystem, provider } = setup('write-fault');
    fileSystem.failNext(
      'write',
      '/nested/deep/file.bin',
      nativeDomError('QuotaExceededError', 'disk full'),
    );

    await expectFsError(
      provider.writeFile(parseWorkspacePath('/nested/deep/file.bin'), new Uint8Array([1, 2]), {
        createParents: true,
      }),
      'quota-exceeded',
    );
    expect(fileSystem.exists('/nested')).to.equal(false);
    await provider.dispose();
  });

  it('rolls a copied destination back when source deletion fails', async () => {
    const { fileSystem, provider } = setup('move-delete-fault');
    fileSystem.seedFile('/source.md', 'source');
    fileSystem.failNext('remove', '/source.md', nativeDomError('NotAllowedError', 'source locked'));

    await expectFsError(
      provider.move(parseWorkspacePath('/source.md'), parseWorkspacePath('/destination.md')),
      'permission-denied',
    );
    expect(fileSystem.readBytes('/source.md')).to.deep.equal([...encoded('source')]);
    expect(fileSystem.exists('/destination.md')).to.equal(false);
    await provider.dispose();
  });

  it('restores source content when verification fails after source deletion', async () => {
    const { fileSystem, provider } = setup('move-post-delete-fault');
    fileSystem.seedFile('/source.md', 'source');
    fileSystem.failOnCall(
      'get-file',
      '/source.md',
      4,
      nativeDomError('NotAllowedError', 'verification blocked'),
    );

    await expectFsError(
      provider.move(parseWorkspacePath('/source.md'), parseWorkspacePath('/destination.md')),
      'permission-denied',
    );
    expect(fileSystem.readBytes('/source.md')).to.deep.equal([...encoded('source')]);
    expect(fileSystem.exists('/destination.md')).to.equal(false);
    await provider.dispose();
  });

  it('cleans a partial directory copy after a destination write fault', async () => {
    const { fileSystem, provider } = setup('directory-copy-fault');
    fileSystem.seedFile('/source/a.md', 'a');
    fileSystem.seedFile('/source/b.md', 'b');
    fileSystem.failNext(
      'write',
      '/destination/b.md',
      nativeDomError('QuotaExceededError', 'disk full'),
    );

    await expectFsError(
      provider.move(parseWorkspacePath('/source'), parseWorkspacePath('/destination')),
      'quota-exceeded',
    );
    expect(fileSystem.exists('/source/a.md')).to.equal(true);
    expect(fileSystem.exists('/source/b.md')).to.equal(true);
    expect(fileSystem.exists('/destination')).to.equal(false);
    await provider.dispose();
  });

  it('restores a source that a partial delete gutted, then removes the copy', async () => {
    const { fileSystem, provider } = setup('partial-delete-restore');
    fileSystem.seedFile('/source/a.md', 'alpha');
    fileSystem.seedFile('/source/b.md', 'bravo');
    // Removing a directory is not atomic: the delete takes 'a.md' and then
    // fails, leaving the source present but missing a child.
    fileSystem.failRemoveAfterDeleting(
      '/source',
      ['a.md'],
      nativeDomError('NotAllowedError', 'entry locked'),
    );

    await expectFsError(
      provider.move(parseWorkspacePath('/source'), parseWorkspacePath('/destination')),
      'permission-denied',
    );

    expect(fileSystem.readBytes('/source/a.md')).to.deep.equal([...encoded('alpha')]);
    expect(fileSystem.readBytes('/source/b.md')).to.deep.equal([...encoded('bravo')]);
    expect(fileSystem.exists('/destination')).to.equal(false);
    await provider.dispose();
  });

  it('keeps the copy when a source gutted by a partial delete cannot be restored', async () => {
    const { fileSystem, provider } = setup('partial-delete-unrepairable');
    fileSystem.seedFile('/source/a.md', 'alpha');
    fileSystem.seedFile('/source/b.md', 'bravo');
    fileSystem.failRemoveAfterDeleting(
      '/source',
      ['a.md'],
      nativeDomError('NotAllowedError', 'entry locked'),
    );
    // The repair write fails too, so the source cannot be made whole again.
    fileSystem.failNext('write', '/source/a.md', nativeDomError('NotAllowedError', 'read-only'));

    const failure = await captureFailure(
      provider.move(parseWorkspacePath('/source'), parseWorkspacePath('/destination')),
    );

    // The copy is the only complete one left: rollback must not delete it, and
    // the failure must be loud rather than a plain retryable error.
    expect(failure).to.be.instanceOf(NativeFileSystemMoveRecoveryError);
    expect(fileSystem.readBytes('/destination/a.md')).to.deep.equal([...encoded('alpha')]);
    expect(fileSystem.readBytes('/destination/b.md')).to.deep.equal([...encoded('bravo')]);
    await provider.dispose();
  });

  it('reports authoritative compound state when destination rollback also fails', async () => {
    const { fileSystem, provider } = setup('compound-move-fault');
    fileSystem.seedFile('/source.md', 'source');
    fileSystem.failNext('remove', '/source.md', nativeDomError('NotAllowedError', 'source locked'));
    fileSystem.failNext(
      'remove',
      '/destination.md',
      nativeDomError('NotAllowedError', 'destination locked'),
    );

    let failure: unknown;
    try {
      await provider.move(parseWorkspacePath('/source.md'), parseWorkspacePath('/destination.md'));
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(NativeFileSystemMoveRecoveryError);
    const recovery = failure as NativeFileSystemMoveRecoveryError;
    expect(recovery.code).to.equal('io');
    expect(recovery.primaryError.code).to.equal('permission-denied');
    expect(recovery.recoveryErrors.map((error) => error.code)).to.deep.equal(['permission-denied']);
    expect(recovery.state).to.deep.equal({ source: 'present', destination: 'present' });
    await provider.dispose();
  });

  it('normalizes an incomplete native move into portable orchestration state', async () => {
    const fileSystem = new NativeFileSystemEmulator();
    const legacy = new NativeFileSystemProvider('native-portable-recovery', fileSystem.rootHandle);
    fileSystem.seedFile('/source.md', 'source');
    fileSystem.failNext('remove', '/source.md', nativeDomError('NotAllowedError', 'source locked'));
    fileSystem.failNext(
      'remove',
      '/destination.md',
      nativeDomError('NotAllowedError', 'destination locked'),
    );

    let failure: unknown;
    try {
      await moveFileSystemEntry(legacy, '/source.md', '/destination.md', 'file');
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(FileSystemMoveRecoveryError);
    expect((failure as FileSystemMoveRecoveryError).state).to.deep.equal({
      source: 'present',
      destination: 'present',
    });
    await legacy.v2.dispose();
  });
});

describe('NativeFileSystemProviderV2 version-token limits', () => {
  it('cannot see an external same-size rewrite inside one mtime tick', async () => {
    const { fileSystem, provider } = setup('coarse-mtime');
    fileSystem.seedFile('/note.md', 'aaaaa');
    // A FAT/exFAT volume stamps mtime at 2-second granularity, so an external
    // rewrite can land on the same timestamp the provider already observed.
    fileSystem.setLastModified('/note.md', 1_000);
    const before = await provider.stat(parseWorkspacePath('/note.md'));

    fileSystem.seedFile('/note.md', 'bbbbb');
    fileSystem.setLastModified('/note.md', 1_000);
    const after = await provider.stat(parseWorkspacePath('/note.md'));

    // Documented blind spot, not desired behaviour: size + mtime are identical,
    // so the token is identical while the bytes differ. Any change that makes
    // the token content-derived should delete this test — and must first show
    // that stat/list stay proportional to entry count rather than bytes.
    expect(after?.version).to.equal(before?.version);
    expect(
      decoded(
        fileSystem.readBytes('/note.md')
          ? new Uint8Array(fileSystem.readBytes('/note.md')!).buffer
          : null,
      ),
    ).to.equal('bbbbb');
    await provider.dispose();
  });

  it('does detect an external rewrite that changes size', async () => {
    const { fileSystem, provider } = setup('size-change');
    fileSystem.seedFile('/note.md', 'aaaaa');
    fileSystem.setLastModified('/note.md', 1_000);
    const before = await provider.stat(parseWorkspacePath('/note.md'));

    fileSystem.seedFile('/note.md', 'bbbbbb');
    fileSystem.setLastModified('/note.md', 1_000);

    await expectFsError(
      provider.writeFile(parseWorkspacePath('/note.md'), encoded('ccccc'), {
        expectedVersion: before!.version,
      }),
      'conflict',
    );
    await provider.dispose();
  });
});

function setup(id: string): {
  readonly fileSystem: NativeFileSystemEmulator;
  readonly provider: NativeFileSystemProviderV2;
} {
  const fileSystem = new NativeFileSystemEmulator();
  return {
    fileSystem,
    provider: new NativeFileSystemProviderV2(`native-${id}`, fileSystem.rootHandle),
  };
}

function encoded(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function captureFailure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error: unknown) {
    return error;
  }
}

function decoded(value: ArrayBuffer | null | undefined): string | null {
  return value ? new TextDecoder().decode(value) : null;
}
