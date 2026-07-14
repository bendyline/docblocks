import { expect } from 'chai';
import {
  FsError,
  MemoryFileSystemProviderV2,
  WORKSPACE_ROOT,
  deserializeFsError,
  fsErrorFromUnknown,
  isSerializedFsError,
  mapDomExceptionToFsErrorCode,
  mapNodeErrorCodeToFsErrorCode,
  parseFileSystemVersion,
  parseWorkspacePath,
  serializeFsError,
  tryParseFileSystemVersion,
  tryParseWorkspacePath,
  workspacePathBasename,
  workspacePathContains,
  workspacePathDirname,
  workspacePathJoin,
  workspacePathToLegacy,
  type FileSystemWatchEvent,
} from '../src/filesystem/index.js';
import { defineFileSystemProviderV2Conformance } from './helpers/filesystem-v2-conformance.js';

let providerId = 0;
defineFileSystemProviderV2Conformance(
  'Memory reference',
  () => new MemoryFileSystemProviderV2(`memory-v2-${++providerId}`, 'Memory v2'),
);

describe('WorkspacePath', () => {
  it('canonicalizes legacy separators and exposes boundary-safe helpers', () => {
    const path = parseWorkspacePath('\\docs///guide.md/');
    expect(path).to.equal('docs/guide.md');
    expect(workspacePathToLegacy(path)).to.equal('/docs/guide.md');
    expect(workspacePathDirname(path)).to.equal('docs');
    expect(workspacePathBasename(path)).to.equal('guide.md');
    expect(workspacePathJoin(parseWorkspacePath('/docs'), 'nested/file.md')).to.equal(
      'docs/nested/file.md',
    );
    expect(workspacePathContains(parseWorkspacePath('/doc'), parseWorkspacePath('/docs'))).to.equal(
      false,
    );
    expect(workspacePathContains(parseWorkspacePath('/docs'), path)).to.equal(true);
    expect(parseWorkspacePath('/')).to.equal(WORKSPACE_ROOT);
    expect(workspacePathToLegacy(WORKSPACE_ROOT)).to.equal('/');
  });

  it('rejects traversal, OS drive paths, and control characters rather than resolving them', () => {
    for (const unsafe of ['../escape.md', 'docs/./file.md']) {
      expect(() => parseWorkspacePath(unsafe))
        .to.throw(FsError)
        .with.property('code', 'path-escape');
      expect(tryParseWorkspacePath(unsafe)).to.equal(null);
    }
    expect(() => parseWorkspacePath('bad\0name'))
      .to.throw(FsError)
      .with.property('code', 'invalid-path');
    expect(tryParseWorkspacePath('/line\nbreak')).to.equal(null);
    expect(() => parseWorkspacePath('C:\\outside\\file.md'))
      .to.throw(FsError)
      .with.property('code', 'path-escape');
    expect(tryParseWorkspacePath(42)).to.equal(null);
  });
});

describe('FsError wire contract', () => {
  it('round-trips through plain JSON without losing stable context', () => {
    const original = new FsError('conflict', 'Version mismatch.', {
      operation: 'write',
      path: 'docs/a.md',
      retryable: false,
    });
    const serialized = JSON.parse(JSON.stringify(serializeFsError(original))) as unknown;
    expect(isSerializedFsError(serialized)).to.equal(true);

    const restored = deserializeFsError(serialized as ReturnType<typeof serializeFsError>);
    expect(restored).to.be.instanceOf(FsError);
    expect(restored.code).to.equal('conflict');
    expect(restored.operation).to.equal('write');
    expect(restored.path).to.equal('docs/a.md');
    expect(restored.retryable).to.equal(false);
  });

  it('maps platform errors and marks transient taxonomy members retryable', () => {
    expect(mapDomExceptionToFsErrorCode('NotAllowedError')).to.equal('permission-denied');
    expect(mapDomExceptionToFsErrorCode('QuotaExceededError')).to.equal('quota-exceeded');
    expect(mapDomExceptionToFsErrorCode('InvalidStateError')).to.equal('disposed');
    expect(mapNodeErrorCodeToFsErrorCode('ENOENT')).to.equal('not-found');
    expect(mapNodeErrorCodeToFsErrorCode('ENOTDIR')).to.equal('type-mismatch');
    expect(mapNodeErrorCodeToFsErrorCode('ENOTEMPTY')).to.equal('not-empty');
    expect(mapNodeErrorCodeToFsErrorCode('EBUSY')).to.equal('busy');
    expect(
      fsErrorFromUnknown(Object.assign(new Error('denied'), { code: 'EACCES' })).code,
    ).to.equal('permission-denied');
    const error = fsErrorFromUnknown(Object.assign(new Error('locked'), { name: 'UnknownError' }), {
      defaultCode: 'busy',
      operation: 'write',
    });
    expect(error.code).to.equal('busy');
    expect(error.retryable).to.equal(true);
  });
});

describe('FileSystemVersion', () => {
  it('accepts bounded opaque tokens and rejects malformed transport values', () => {
    expect(parseFileSystemVersion('provider:42')).to.equal('provider:42');
    expect(tryParseFileSystemVersion('')).to.equal(null);
    expect(tryParseFileSystemVersion('bad\0token')).to.equal(null);
    expect(tryParseFileSystemVersion({ token: 'provider:42' })).to.equal(null);
  });
});

describe('MemoryFileSystemProviderV2 reference semantics', () => {
  it('declares strong in-process semantics without implying durability or symlinks', () => {
    const provider = new MemoryFileSystemProviderV2('capabilities', 'Capabilities');
    expect(provider.capabilities).to.deep.equal({
      writeAtomicity: 'process',
      moveAtomicity: 'process',
      snapshotAtomicity: 'process',
      conditionalWrite: 'process',
      recursiveRemove: true,
      watch: true,
      caseSensitivity: 'sensitive',
      symlinkPolicy: 'unsupported',
      durability: 'volatile',
    });
    expect(Object.isFrozen(provider.capabilities)).to.equal(true);
  });

  it('models overflow and unknown-origin watch signals without fabricating an entry kind', () => {
    const overflow: FileSystemWatchEvent = {
      sequence: 12,
      type: 'overflow',
      origin: 'unknown',
      kind: null,
      path: WORKSPACE_ROOT,
      destinationPath: null,
      version: null,
      previousVersion: null,
    };
    expect(overflow.type).to.equal('overflow');
    expect(overflow.kind).to.equal(null);
  });

  it('keeps repeated subscriptions of the same listener independently disposable', async () => {
    const provider = new MemoryFileSystemProviderV2('subscriptions', 'Subscriptions');
    let calls = 0;
    const listener = () => {
      calls += 1;
    };
    const first = provider.watch(listener);
    const second = provider.watch(listener);
    await Promise.all([first.ready, second.ready]);

    await provider.writeFile(parseWorkspacePath('/one.md'), new Uint8Array([1]));
    expect(calls).to.equal(2);
    await first.dispose();
    await provider.writeFile(parseWorkspacePath('/two.md'), new Uint8Array([2]));
    expect(calls).to.equal(3);

    const disposing = provider.dispose();
    expect(provider.dispose()).to.equal(disposing);
    await disposing;
    expect(second.closed).to.equal(true);
  });

  it('publishes one overflow event after an atomic whole-tree replacement', async () => {
    const provider = new MemoryFileSystemProviderV2('replacement-watch', 'Replacement watch');
    const events: FileSystemWatchEvent[] = [];
    const subscription = provider.watch((event) => events.push(event));
    await subscription.ready;

    provider.replaceState({
      files: [
        {
          path: parseWorkspacePath('/replacement.md'),
          data: new TextEncoder().encode('replacement'),
          payloadKind: 'text',
        },
      ],
    });

    expect(events).to.have.length(1);
    expect(events[0]).to.deep.include({
      sequence: 1,
      type: 'overflow',
      origin: 'local',
      kind: null,
      path: WORKSPACE_ROOT,
    });
    expect(
      new TextDecoder().decode(
        (await provider.readFile(parseWorkspacePath('/replacement.md')))!.data,
      ),
    ).to.equal('replacement');
    await provider.dispose();
  });

  it('delivers monotonically ordered events when a listener mutates reentrantly', async () => {
    const provider = new MemoryFileSystemProviderV2('reentrant-events', 'Reentrant events');
    const firstSequences: number[] = [];
    const secondSequences: number[] = [];
    let nestedWrite: Promise<unknown> | null = null;
    const first = provider.watch((event) => {
      firstSequences.push(event.sequence);
      if (event.sequence === 1) {
        nestedWrite = provider.writeFile(
          parseWorkspacePath('/nested.md'),
          new TextEncoder().encode('nested'),
        );
      }
    });
    const second = provider.watch((event) => secondSequences.push(event.sequence));
    await Promise.all([first.ready, second.ready]);

    await provider.writeFile(parseWorkspacePath('/first.md'), new TextEncoder().encode('first'));
    await nestedWrite;

    expect(firstSequences).to.deep.equal([1, 2]);
    expect(secondSequences).to.deep.equal([1, 2]);
    await provider.dispose();
  });

  it('rejects invalid replacement payload kinds without changing state', async () => {
    const provider = new MemoryFileSystemProviderV2('replacement-kind', 'Replacement kind');
    await provider.writeFile(parseWorkspacePath('/keep.bin'), new Uint8Array([1]));
    const revision = provider.mutationRevision;

    expect(() =>
      provider.replaceState({
        files: [
          {
            path: parseWorkspacePath('/bad.bin'),
            data: new Uint8Array([2]),
            payloadKind: 'invalid' as 'binary',
          },
        ],
      }),
    )
      .to.throw(FsError)
      .with.property('code', 'type-mismatch');
    expect(provider.mutationRevision).to.equal(revision);
    expect(await provider.stat(parseWorkspacePath('/keep.bin'))).not.to.equal(null);
    expect(await provider.stat(parseWorkspacePath('/bad.bin'))).to.equal(null);
    await provider.dispose();
  });
});
