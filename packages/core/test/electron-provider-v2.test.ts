import { expect } from 'chai';
import { ElectronFileSystemProvider } from '../src/filesystem/electron-provider.js';
import { ElectronFileSystemProviderV2 } from '../src/filesystem/electron-provider-v2.js';
import { FsError, serializeFsError } from '../src/filesystem/fs-error.js';
import { parseWorkspacePath } from '../src/filesystem/workspace-path.js';
import { parseFileSystemVersion, type FileSystemWatchEvent } from '../src/filesystem/v2.js';
import {
  ELECTRON_FILE_SYSTEM_V2_CAPABILITIES,
  type DocBlocksHostAPI,
  type DocBlocksHostFsV2API,
  type HostFileSystemV2WatchMessage,
} from '../src/host/index.js';

interface MockHostState {
  emitEvent(event: FileSystemWatchEvent): void;
  emitInvalidWatchError(error: unknown): void;
  disposes: number;
  unsubscribes: number;
}

function installHost(overrides: Partial<DocBlocksHostFsV2API> = {}): MockHostState {
  let listener: Parameters<DocBlocksHostFsV2API['onWatchMessage']>[0] | null = null;
  let watchedInstanceId = '';
  let watchedSubscriptionId = '';
  const state = { disposes: 0, unsubscribes: 0 };
  const defaults: DocBlocksHostFsV2API = {
    open: async () => ({ ok: true, value: ELECTRON_FILE_SYSTEM_V2_CAPABILITIES }),
    stat: async () => ({ ok: true, value: null }),
    readFile: async () => ({ ok: true, value: null }),
    readDirectory: async () => ({ ok: true, value: [] }),
    writeFile: async () => {
      throw new Error('Not implemented by mock');
    },
    createDirectory: async () => {
      throw new Error('Not implemented by mock');
    },
    remove: async () => {
      throw new Error('Not implemented by mock');
    },
    move: async () => {
      throw new Error('Not implemented by mock');
    },
    snapshot: async () => {
      throw new Error('Not implemented by mock');
    },
    watchSubscribe: async (instanceId, subscriptionId) => {
      watchedInstanceId = instanceId;
      watchedSubscriptionId = subscriptionId;
      return { ok: true, value: null };
    },
    watchUnsubscribe: async () => {
      state.unsubscribes += 1;
      return { ok: true, value: null };
    },
    dispose: async () => {
      state.disposes += 1;
      return { ok: true, value: null };
    },
    onWatchMessage(callback) {
      listener = callback;
      return () => {
        if (listener === callback) listener = null;
      };
    },
  };
  const fsV2 = { ...defaults, ...overrides };
  (globalThis as unknown as { docBlocksHost: DocBlocksHostAPI }).docBlocksHost = {
    fs: {} as DocBlocksHostAPI['fs'],
    fsV2,
  } as DocBlocksHostAPI;
  return {
    emitEvent(event) {
      listener?.({
        instanceId: watchedInstanceId,
        subscriptionId: watchedSubscriptionId,
        kind: 'event',
        event,
      });
    },
    emitInvalidWatchError(error) {
      listener?.({
        instanceId: watchedInstanceId,
        subscriptionId: watchedSubscriptionId,
        kind: 'error',
        error,
      } as unknown as HostFileSystemV2WatchMessage);
    },
    get unsubscribes() {
      return state.unsubscribes;
    },
    get disposes() {
      return state.disposes;
    },
  };
}

function clearHost(): void {
  delete (globalThis as { docBlocksHost?: unknown }).docBlocksHost;
}

describe('ElectronFileSystemProviderV2', () => {
  afterEach(clearHost);

  it('opens with a workspace capability and never sends an absolute root', async () => {
    let request: Parameters<DocBlocksHostFsV2API['open']>[0] | null = null;
    installHost({
      open: async (value) => {
        request = value;
        return { ok: true, value: ELECTRON_FILE_SYSTEM_V2_CAPABILITIES };
      },
    });
    const provider = new ElectronFileSystemProviderV2(
      'workspace-capability',
      'Workspace',
      'C:\\private\\documents',
    );

    await provider.stat(parseWorkspacePath('/note.md'));

    expect(request).to.include({ providerId: 'workspace-capability', label: 'Workspace' });
    expect(request).not.to.have.property('rootPath');
    await provider.dispose();
  });

  it('rehydrates a serialized transport failure as FsError', async () => {
    installHost({
      stat: async () => ({
        ok: false,
        error: serializeFsError(
          new FsError('permission-denied', 'No access.', {
            operation: 'stat',
            path: 'secret.md',
          }),
        ),
      }),
    });
    const provider = new ElectronFileSystemProviderV2('workspace', 'Workspace', '/tmp/workspace');

    let failure: unknown;
    try {
      await provider.stat(parseWorkspacePath('/secret.md'));
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(FsError);
    expect((failure as FsError).code).to.equal('permission-denied');
    expect((failure as FsError).path).to.equal('secret.md');
    await provider.dispose();
  });

  it('preserves the requested operation when the host bridge is unavailable', async () => {
    clearHost();
    const provider = new ElectronFileSystemProviderV2('workspace', 'Workspace', '/tmp/workspace');

    let failure: unknown;
    try {
      await provider.readFile(parseWorkspacePath('/note.md'));
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(FsError);
    expect((failure as FsError).code).to.equal('not-supported');
    expect((failure as FsError).operation).to.equal('read');
    await provider.dispose();
  });

  it('rejects structurally invalid bytes at the IPC boundary', async () => {
    installHost({
      readFile: async () => ({
        ok: true,
        value: {
          entry: {
            kind: 'file',
            path: parseWorkspacePath('/note.md'),
            name: 'note.md',
            size: 2,
            version: parseFileSystemVersion('v1'),
            lastModified: new Date(0).toISOString(),
          },
          data: new Uint8Array([1]).buffer,
        },
      }),
    });
    const provider = new ElectronFileSystemProviderV2('workspace', 'Workspace', '/tmp/workspace');

    let failure: unknown;
    try {
      await provider.readFile(parseWorkspacePath('/note.md'));
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(FsError);
    expect((failure as FsError).code).to.equal('io');
    expect((failure as FsError).operation).to.equal('read');
    expect((failure as FsError).retryable).to.equal(false);
    await provider.dispose();
  });

  it('retries a retryable failed open and validates host capability agreement', async () => {
    let attempts = 0;
    const host = installHost({
      open: async () => {
        attempts += 1;
        if (attempts === 1) {
          return {
            ok: false,
            error: serializeFsError(new FsError('busy', 'Try again.', { operation: 'stat' })),
          };
        }
        return { ok: true, value: ELECTRON_FILE_SYSTEM_V2_CAPABILITIES };
      },
    });
    const provider = new ElectronFileSystemProviderV2('workspace', 'Workspace', '/tmp/workspace');

    const openFailure = await expectRejected(
      provider.readFile(parseWorkspacePath('/note.md')),
      'busy',
    );
    expect(openFailure.operation).to.equal('read');
    expect(await provider.stat(parseWorkspacePath('/note.md'))).to.equal(null);
    expect(attempts).to.equal(2);
    await provider.dispose();
    expect(host.disposes).to.equal(1);

    const incompatibleHost = installHost({
      open: async () => ({
        ok: true,
        value: { ...ELECTRON_FILE_SYSTEM_V2_CAPABILITIES, watch: false },
      }),
    });
    const incompatible = new ElectronFileSystemProviderV2(
      'incompatible',
      'Incompatible',
      '/tmp/incompatible',
    );
    let failure: unknown;
    try {
      await incompatible.stat(parseWorkspacePath('/note.md'));
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(FsError);
    expect((failure as FsError).code).to.equal('io');
    expect((failure as FsError).retryable).to.equal(false);
    await incompatible.dispose();
    expect(incompatibleHost.disposes).to.equal(1);
  });

  it('accepts the ordinal deterministic order emitted by provider backends', async () => {
    const modified = new Date(0).toISOString();
    const treeVersion = parseFileSystemVersion('tree-v1');
    const upperVersion = parseFileSystemVersion('upper-v1');
    const lowerVersion = parseFileSystemVersion('lower-v1');
    const upperPath = parseWorkspacePath('/Z.md');
    const lowerPath = parseWorkspacePath('/a.md');
    const upper = {
      kind: 'file' as const,
      path: upperPath,
      name: 'Z.md',
      size: 1,
      version: upperVersion,
      lastModified: modified,
    };
    const lower = {
      kind: 'file' as const,
      path: lowerPath,
      name: 'a.md',
      size: 1,
      version: lowerVersion,
      lastModified: modified,
    };
    installHost({
      readDirectory: async () => ({ ok: true, value: [upper, lower] }),
      snapshot: async () => ({
        ok: true,
        value: {
          version: treeVersion,
          entries: [
            {
              kind: 'directory',
              path: parseWorkspacePath('/'),
              name: '',
              size: null,
              version: treeVersion,
              lastModified: modified,
            },
            { ...upper, data: new Uint8Array([1]).buffer },
            { ...lower, data: new Uint8Array([2]).buffer },
          ],
        },
      }),
    });
    const provider = new ElectronFileSystemProviderV2('workspace', 'Workspace', '/tmp/workspace');

    expect(
      (await provider.readDirectory(parseWorkspacePath('/'))).map((entry) => entry.name),
    ).to.deep.equal(['Z.md', 'a.md']);
    expect((await provider.snapshot()).entries.map((entry) => entry.path)).to.deep.equal([
      parseWorkspacePath('/'),
      upperPath,
      lowerPath,
    ]);
    await provider.dispose();
  });

  it('bridges ordered watch events and uses awaitable unsubscribe', async () => {
    const host = installHost();
    const provider = new ElectronFileSystemProviderV2('workspace', 'Workspace', '/tmp/workspace');
    const events: string[] = [];
    const subscription = provider.watch((event) => events.push(event.type));
    await subscription.ready;

    host.emitEvent({
      sequence: 1,
      origin: 'external',
      type: 'created',
      kind: 'file',
      path: parseWorkspacePath('/note.md'),
      destinationPath: null,
      version: parseFileSystemVersion('v1'),
      previousVersion: null,
    });
    expect(events).to.deep.equal(['created']);

    await subscription.dispose();
    expect(subscription.closed).to.equal(true);
    expect(host.unsubscribes).to.equal(1);
    await provider.dispose();
  });

  it('routes invalid serialized watch errors as non-retryable transport errors', async () => {
    const host = installHost();
    const provider = new ElectronFileSystemProviderV2('workspace', 'Workspace', '/tmp/workspace');
    const errors: FsError[] = [];
    const subscription = provider.watch(() => undefined, {
      onError: (error) => errors.push(error),
    });
    await subscription.ready;

    host.emitInvalidWatchError({ name: 'FsError', code: 'not-a-real-code' });
    expect(errors).to.have.length(1);
    expect(errors[0]).to.include({
      code: 'io',
      operation: 'watch',
      retryable: false,
    });

    await subscription.dispose();
    await provider.dispose();
  });

  it('disposes idempotently after open fails without issuing a phantom host dispose', async () => {
    const host = installHost({
      open: async () => ({
        ok: false,
        error: serializeFsError(
          new FsError('permission-denied', 'Workspace access was revoked.', {
            operation: 'stat',
          }),
        ),
      }),
    });
    const provider = new ElectronFileSystemProviderV2('workspace', 'Workspace', '/tmp/workspace');

    let failure: unknown;
    try {
      await provider.stat(parseWorkspacePath('/note.md'));
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(FsError);
    await provider.dispose();
    await provider.dispose();
    expect(host.disposes).to.equal(0);
  });

  it('exposes the v2 client through the legacy provider migration seam', () => {
    installHost();
    const legacy = new ElectronFileSystemProvider('workspace', 'Workspace', '/tmp/workspace');
    expect(legacy.v2).to.be.instanceOf(ElectronFileSystemProviderV2);
    expect(legacy.v2.capabilities.symlinkPolicy).to.equal('follow-contained');
  });
});

async function expectRejected(promise: Promise<unknown>, code: FsError['code']): Promise<FsError> {
  let failure: unknown;
  try {
    await promise;
  } catch (error: unknown) {
    failure = error;
  }
  expect(failure).to.be.instanceOf(FsError);
  expect((failure as FsError).code).to.equal(code);
  return failure as FsError;
}
