import {
  FsError,
  serializeFsError,
  type FileSystemCreateDirectoryOptions,
  type FileSystemMoveOptions,
  type FileSystemRemoveOptions,
  type FileSystemWatchSubscription,
  type FileSystemWriteOptions,
  type FsOperation,
  type WorkspacePath,
} from '@bendyline/docblocks/filesystem';
import type {
  HostFileSystemV2OpenRequest,
  HostFileSystemV2Result,
  HostFileSystemV2WatchMessage,
} from '@bendyline/docblocks/host';

import { NodeWorkspaceFileSystemV2 } from './node-workspace-filesystem-v2.js';

interface ProviderRecord {
  readonly request: HostFileSystemV2OpenRequest;
  readonly provider: NodeWorkspaceFileSystemV2;
  readonly subscriptions: Map<string, FileSystemWatchSubscription>;
}

export type FileSystemV2ProviderFactory = (
  request: HostFileSystemV2OpenRequest,
) => NodeWorkspaceFileSystemV2;

export type FileSystemV2WatchSender = (message: HostFileSystemV2WatchMessage) => void;

/** Pure owner-scoped service used by the Electron IPC adapter and unit tests. */
export class FileSystemV2IpcService {
  private readonly records = new Map<string, ProviderRecord>();
  private readonly openings = new Map<string, Promise<ProviderRecord>>();
  private readonly closedOwners = new Set<string>();

  public constructor(
    private readonly providerFactory: FileSystemV2ProviderFactory = (request) =>
      new NodeWorkspaceFileSystemV2(request.providerId, request.label, request.rootPath),
  ) {}

  public open(
    ownerId: string,
    request: HostFileSystemV2OpenRequest,
  ): Promise<HostFileSystemV2Result<NodeWorkspaceFileSystemV2['capabilities']>> {
    return this.result('stat', null, null, async () => {
      if (this.closedOwners.has(ownerId)) {
        throw new FsError('closed', 'Filesystem IPC owner is closed.', { operation: 'stat' });
      }
      validateIdentifier(request.instanceId, 'provider instance');
      validateIdentifier(request.providerId, 'provider');
      if (!request.label || request.label.length > 1024) {
        throw new FsError('invalid-path', 'Invalid provider label.', { operation: 'stat' });
      }
      if (!request.rootPath || request.rootPath.includes('\0')) {
        throw new FsError('invalid-path', 'Invalid workspace root.', { operation: 'stat' });
      }

      const key = recordKey(ownerId, request.instanceId);
      const existing = this.records.get(key);
      if (existing) {
        assertSameProvider(existing, request);
        return existing.provider.capabilities;
      }

      let opening = this.openings.get(key);
      if (!opening) {
        opening = this.openRecord(ownerId, key, request);
        this.openings.set(key, opening);
      }
      try {
        const record = await opening;
        assertSameProvider(record, request);
        return record.provider.capabilities;
      } finally {
        if (this.openings.get(key) === opening) this.openings.delete(key);
      }
    });
  }

  public stat(ownerId: string, instanceId: string, itemPath: WorkspacePath) {
    return this.withProvider(ownerId, instanceId, 'stat', itemPath, null, (provider) =>
      provider.stat(itemPath),
    );
  }

  public readFile(ownerId: string, instanceId: string, itemPath: WorkspacePath) {
    return this.withProvider(ownerId, instanceId, 'read', itemPath, null, (provider) =>
      provider.readFile(itemPath),
    );
  }

  public readDirectory(ownerId: string, instanceId: string, itemPath: WorkspacePath) {
    return this.withProvider(ownerId, instanceId, 'list', itemPath, null, (provider) =>
      provider.readDirectory(itemPath),
    );
  }

  public writeFile(
    ownerId: string,
    instanceId: string,
    itemPath: WorkspacePath,
    data: ArrayBuffer | Uint8Array,
    options?: FileSystemWriteOptions,
  ) {
    return this.withProvider(ownerId, instanceId, 'write', itemPath, null, (provider) =>
      provider.writeFile(itemPath, data, options),
    );
  }

  public createDirectory(
    ownerId: string,
    instanceId: string,
    itemPath: WorkspacePath,
    options?: FileSystemCreateDirectoryOptions,
  ) {
    return this.withProvider(ownerId, instanceId, 'create-directory', itemPath, null, (provider) =>
      provider.createDirectory(itemPath, options),
    );
  }

  public remove(
    ownerId: string,
    instanceId: string,
    itemPath: WorkspacePath,
    options?: FileSystemRemoveOptions,
  ) {
    return this.withProvider(ownerId, instanceId, 'remove', itemPath, null, (provider) =>
      provider.remove(itemPath, options),
    );
  }

  public move(
    ownerId: string,
    instanceId: string,
    oldPath: WorkspacePath,
    newPath: WorkspacePath,
    options?: FileSystemMoveOptions,
  ) {
    return this.withProvider(ownerId, instanceId, 'move', oldPath, newPath, (provider) =>
      provider.move(oldPath, newPath, options),
    );
  }

  public snapshot(ownerId: string, instanceId: string) {
    return this.withProvider(ownerId, instanceId, 'snapshot', null, null, (provider) =>
      provider.snapshot(),
    );
  }

  public watchSubscribe(
    ownerId: string,
    instanceId: string,
    subscriptionId: string,
    send: FileSystemV2WatchSender,
  ): Promise<HostFileSystemV2Result<null>> {
    return this.result('watch', null, null, async () => {
      validateIdentifier(subscriptionId, 'watch subscription');
      const record = this.requireRecord(ownerId, instanceId, 'watch');
      if (record.subscriptions.has(subscriptionId)) {
        throw new FsError('already-exists', 'Watch subscription already exists.', {
          operation: 'watch',
        });
      }

      const subscription = record.provider.watch(
        (event) => send({ instanceId, subscriptionId, kind: 'event', event }),
        {
          onError: (error) =>
            send({
              instanceId,
              subscriptionId,
              kind: 'error',
              error: serializeFsError(error, { operation: 'watch' }),
            }),
        },
      );
      record.subscriptions.set(subscriptionId, subscription);
      try {
        await subscription.ready;
      } catch (error: unknown) {
        record.subscriptions.delete(subscriptionId);
        await subscription.dispose();
        throw error;
      }
      return null;
    });
  }

  public watchUnsubscribe(
    ownerId: string,
    instanceId: string,
    subscriptionId: string,
  ): Promise<HostFileSystemV2Result<null>> {
    return this.result('watch', null, null, async () => {
      const record = this.requireRecord(ownerId, instanceId, 'watch');
      const subscription = record.subscriptions.get(subscriptionId);
      if (!subscription) return null;
      record.subscriptions.delete(subscriptionId);
      await subscription.dispose();
      return null;
    });
  }

  public dispose(ownerId: string, instanceId: string): Promise<HostFileSystemV2Result<null>> {
    return this.result('dispose', null, null, async () => {
      const key = recordKey(ownerId, instanceId);
      const record = this.records.get(key);
      if (!record) return null;
      this.records.delete(key);
      await Promise.all([...record.subscriptions.values()].map((item) => item.dispose()));
      record.subscriptions.clear();
      await record.provider.dispose();
      return null;
    });
  }

  public async disposeOwner(ownerId: string): Promise<void> {
    this.closedOwners.add(ownerId);
    const openingPrefix = `${ownerId}\0`;
    await Promise.allSettled(
      [...this.openings.entries()]
        .filter(([key]) => key.startsWith(openingPrefix))
        .map(([, opening]) => opening),
    );
    const records = [...this.records.entries()].filter(([key]) => key.startsWith(`${ownerId}\0`));
    await Promise.all(
      records.map(async ([key, record]) => {
        this.records.delete(key);
        await record.provider.dispose();
      }),
    );
  }

  private withProvider<T>(
    ownerId: string,
    instanceId: string,
    operation: FsOperation,
    itemPath: WorkspacePath | null,
    destinationPath: WorkspacePath | null,
    work: (provider: NodeWorkspaceFileSystemV2) => Promise<T>,
  ): Promise<HostFileSystemV2Result<T>> {
    return this.result(operation, itemPath, destinationPath, () =>
      work(this.requireRecord(ownerId, instanceId, operation).provider),
    );
  }

  private async openRecord(
    ownerId: string,
    key: string,
    request: HostFileSystemV2OpenRequest,
  ): Promise<ProviderRecord> {
    const provider = this.providerFactory(request);
    try {
      await provider.initialize();
    } catch (error: unknown) {
      await provider.dispose();
      throw error;
    }
    if (this.closedOwners.has(ownerId)) {
      await provider.dispose();
      throw new FsError('closed', 'Filesystem IPC owner closed while opening.', {
        operation: 'stat',
      });
    }
    const record: ProviderRecord = { request, provider, subscriptions: new Map() };
    this.records.set(key, record);
    return record;
  }

  private requireRecord(
    ownerId: string,
    instanceId: string,
    operation: FsOperation,
  ): ProviderRecord {
    const record = this.records.get(recordKey(ownerId, instanceId));
    if (record) return record;
    throw new FsError('closed', 'Filesystem provider is not open.', { operation });
  }

  private async result<T>(
    operation: FsOperation,
    itemPath: WorkspacePath | null,
    destinationPath: WorkspacePath | null,
    work: () => Promise<T>,
  ): Promise<HostFileSystemV2Result<T>> {
    try {
      return { ok: true, value: await work() };
    } catch (error: unknown) {
      return {
        ok: false,
        error: serializeFsError(error, {
          operation,
          path: itemPath ?? undefined,
          destinationPath: destinationPath ?? undefined,
        }),
      };
    }
  }
}

function recordKey(ownerId: string, instanceId: string): string {
  return `${ownerId}\0${instanceId}`;
}

function validateIdentifier(value: string, label: string): void {
  if (!value || value.length > 256 || value.includes('\0')) {
    throw new FsError('invalid-path', `Invalid ${label} id.`, { operation: 'stat' });
  }
}

function assertSameProvider(record: ProviderRecord, request: HostFileSystemV2OpenRequest): void {
  if (
    record.request.providerId === request.providerId &&
    record.request.rootPath === request.rootPath
  ) {
    return;
  }
  throw new FsError('already-exists', 'Provider instance id is already in use.', {
    operation: 'stat',
  });
}
