import {
  ELECTRON_FILE_SYSTEM_V2_CAPABILITIES,
  maybeGetDocBlocksHost,
  type DocBlocksHostFsV2API,
  type HostFileSystemV2Result,
  type HostFileSystemV2WatchMessage,
} from '../host/index.js';
import {
  FsError,
  deserializeFsError,
  fsErrorFromUnknown,
  isSerializedFsError,
  type FsOperation,
} from './fs-error.js';
import {
  WORKSPACE_ROOT,
  parseWorkspacePath,
  workspacePathBasename,
  workspacePathDirname,
  type WorkspacePath,
} from './workspace-path.js';
import {
  parseFileSystemVersion,
  type FileSystemCreateDirectoryOptions,
  type FileSystemDirectorySnapshot,
  type FileSystemEntrySnapshot,
  type FileSystemFileRead,
  type FileSystemFileSnapshot,
  type FileSystemMoveOptions,
  type FileSystemProviderCapabilities,
  type FileSystemProviderV2,
  type FileSystemRemoveOptions,
  type FileSystemRemoveResult,
  type FileSystemSnapshot,
  type FileSystemSnapshotEntry,
  type FileSystemWatchEvent,
  type FileSystemWatchOptions,
  type FileSystemWatchSubscription,
  type FileSystemWriteOptions,
} from './v2.js';

interface ClientWatcher {
  readonly listener: (event: FileSystemWatchEvent) => void;
  readonly onError: FileSystemWatchOptions['onError'];
}

let fallbackInstanceSequence = 0;

function getHostFsV2(operation: FsOperation): DocBlocksHostFsV2API {
  const host = maybeGetDocBlocksHost();
  if (!host?.fsV2) {
    throw new FsError('not-supported', 'Electron filesystem v2 host is unavailable.', {
      operation,
    });
  }
  return host.fsV2;
}

/** Pure renderer-side client for the typed Electron filesystem v2 transport. */
export class ElectronFileSystemProviderV2 implements FileSystemProviderV2 {
  public readonly id: string;
  public readonly label: string;
  public readonly capabilities = ELECTRON_FILE_SYSTEM_V2_CAPABILITIES;

  private readonly rootPath: string;
  private readonly instanceId = createInstanceId();
  private readonly watchers = new Map<string, ClientWatcher>();
  private readonly subscriptions = new Set<FileSystemWatchSubscription>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private openPromise: Promise<void> | null = null;
  private removeWatchBridge: (() => void) | null = null;
  private disposePromise: Promise<void> | null = null;
  private hostOpened = false;
  private disposed = false;

  public constructor(id: string, label: string, rootPath: string) {
    this.id = id;
    this.label = label;
    this.rootPath = rootPath;
  }

  public getRootPath(): string {
    return this.rootPath;
  }

  public async stat(path: WorkspacePath): Promise<FileSystemEntrySnapshot | null> {
    const canonical = parseWorkspacePath(String(path));
    return this.request(
      'stat',
      () => getHostFsV2('stat').stat(this.instanceId, canonical),
      (value) => (value ? normalizeEntry(value) : null),
    );
  }

  public async readFile(path: WorkspacePath): Promise<FileSystemFileRead | null> {
    const canonical = parseWorkspacePath(String(path));
    return this.request(
      'read',
      () => getHostFsV2('read').readFile(this.instanceId, canonical),
      (value) => {
        if (!value) return null;
        const entry = normalizeFile(value.entry);
        const data = copyWireBuffer(value.data);
        if (data.byteLength !== entry.size) {
          throw new TypeError('Filesystem transport returned file bytes with the wrong size.');
        }
        return Object.freeze({ entry, data });
      },
    );
  }

  public async readDirectory(path: WorkspacePath): Promise<readonly FileSystemEntrySnapshot[]> {
    const canonical = parseWorkspacePath(String(path));
    return this.request(
      'list',
      () => getHostFsV2('list').readDirectory(this.instanceId, canonical),
      (value) => normalizeDirectoryListing(value, canonical),
    );
  }

  public async writeFile(
    path: WorkspacePath,
    data: ArrayBuffer | Uint8Array,
    options?: FileSystemWriteOptions,
  ): Promise<FileSystemFileSnapshot> {
    const canonical = parseWorkspacePath(String(path));
    const owned = copyBytes(data);
    return this.request(
      'write',
      () => getHostFsV2('write').writeFile(this.instanceId, canonical, owned, options),
      normalizeFile,
    );
  }

  public async createDirectory(
    path: WorkspacePath,
    options?: FileSystemCreateDirectoryOptions,
  ): Promise<FileSystemDirectorySnapshot> {
    const canonical = parseWorkspacePath(String(path));
    return this.request(
      'create-directory',
      () => getHostFsV2('create-directory').createDirectory(this.instanceId, canonical, options),
      normalizeDirectory,
    );
  }

  public async remove(
    path: WorkspacePath,
    options?: FileSystemRemoveOptions,
  ): Promise<FileSystemRemoveResult> {
    const canonical = parseWorkspacePath(String(path));
    return this.request(
      'remove',
      () => getHostFsV2('remove').remove(this.instanceId, canonical, options),
      normalizeRemoveResult,
    );
  }

  public async move(
    oldPath: WorkspacePath,
    newPath: WorkspacePath,
    options?: FileSystemMoveOptions,
  ): Promise<FileSystemEntrySnapshot> {
    const source = parseWorkspacePath(String(oldPath));
    const destination = parseWorkspacePath(String(newPath));
    return this.request(
      'move',
      () => getHostFsV2('move').move(this.instanceId, source, destination, options),
      normalizeEntry,
    );
  }

  public async snapshot(): Promise<FileSystemSnapshot> {
    return this.request(
      'snapshot',
      () => getHostFsV2('snapshot').snapshot(this.instanceId),
      normalizeSnapshot,
    );
  }

  public watch(
    listener: (event: FileSystemWatchEvent) => void,
    options: FileSystemWatchOptions = {},
  ): FileSystemWatchSubscription {
    this.assertOpen('watch');
    this.ensureWatchBridge();
    const subscriptionId = createInstanceId();
    const watcher: ClientWatcher = { listener, onError: options.onError };
    this.watchers.set(subscriptionId, watcher);
    let closed = false;
    let subscribed = false;
    let closePromise: Promise<void> | null = null;
    const ready = this.ensureOpen('watch')
      .then(async () => {
        if (closed) return;
        unwrap(await getHostFsV2('watch').watchSubscribe(this.instanceId, subscriptionId), 'watch');
        subscribed = true;
      })
      .catch((error: unknown) => {
        closed = true;
        this.watchers.delete(subscriptionId);
        const typed = error instanceof FsError ? error : new FsError('io', String(error));
        try {
          watcher.onError?.(typed);
        } catch {
          // Isolate observers.
        }
        throw typed;
      });

    const subscription: FileSystemWatchSubscription = {
      get closed() {
        return closed;
      },
      ready,
      dispose: () => {
        if (closePromise) return closePromise;
        closed = true;
        this.watchers.delete(subscriptionId);
        this.subscriptions.delete(subscription);
        closePromise = (async () => {
          await ready.catch(() => undefined);
          if (subscribed) {
            unwrap(
              await getHostFsV2('watch').watchUnsubscribe(this.instanceId, subscriptionId),
              'watch',
            );
          }
        })();
        return closePromise;
      },
    };
    this.subscriptions.add(subscription);
    return subscription;
  }

  public dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = (async () => {
      await Promise.allSettled([...this.inFlight]);
      await Promise.all([...this.subscriptions].map((subscription) => subscription.dispose()));
      try {
        if (this.openPromise) {
          try {
            await this.openPromise;
          } catch {
            // A failed request normally creates no host record. `hostOpened`
            // separately tracks a successful open whose response validation
            // failed after the main-side record had already been published.
          }
        }
        if (this.hostOpened) {
          try {
            unwrap(await getHostFsV2('dispose').dispose(this.instanceId), 'dispose');
          } catch (error: unknown) {
            if (!(error instanceof FsError && error.code === 'closed')) throw error;
          } finally {
            this.hostOpened = false;
          }
        }
      } finally {
        this.removeWatchBridge?.();
        this.removeWatchBridge = null;
      }
    })();
    return this.disposePromise;
  }

  private request<T, U>(
    operation: FsOperation,
    send: () => Promise<HostFileSystemV2Result<T>>,
    normalize: (value: T) => U,
  ): Promise<U> {
    this.assertOpen(operation);
    const promise = this.ensureOpen(operation).then(async () => {
      try {
        return normalize(unwrap(await send(), operation));
      } catch (error: unknown) {
        throw transportErrorFromUnknown(error, operation);
      }
    });
    this.inFlight.add(promise);
    void promise.then(
      () => this.inFlight.delete(promise),
      () => this.inFlight.delete(promise),
    );
    return promise;
  }

  private ensureOpen(operation: FsOperation): Promise<void> {
    this.assertOpen(operation);
    if (!this.openPromise) {
      const attempt = getHostFsV2(operation)
        .open({
          instanceId: this.instanceId,
          providerId: this.id,
          label: this.label,
        })
        .then((result) => {
          if (isRecord(result) && result.ok === true) this.hostOpened = true;
          const capabilities = unwrap(result, operation);
          assertCapabilities(capabilities, operation);
        })
        .catch((error: unknown) => {
          const typed = withOperation(fsErrorFromUnknown(error, { operation }), operation);
          if (typed.retryable && this.openPromise === attempt) this.openPromise = null;
          throw typed;
        });
      this.openPromise = attempt;
    }
    return this.openPromise;
  }

  private ensureWatchBridge(): void {
    if (this.removeWatchBridge) return;
    this.removeWatchBridge = getHostFsV2('watch').onWatchMessage((message) =>
      this.handleWatchMessage(message),
    );
  }

  private handleWatchMessage(message: HostFileSystemV2WatchMessage): void {
    if (message.instanceId !== this.instanceId) return;
    const watcher = this.watchers.get(message.subscriptionId);
    if (!watcher) return;
    if (message.kind === 'error') {
      const typed = isSerializedFsError(message.error)
        ? deserializeFsError(message.error)
        : invalidTransport('watch', 'Filesystem transport returned an invalid watch error.');
      try {
        watcher.onError?.(typed);
      } catch {
        // Isolate observers.
      }
      return;
    }

    let event: FileSystemWatchEvent;
    try {
      event = normalizeWatchEvent(message.event);
    } catch (error: unknown) {
      try {
        watcher.onError?.(transportErrorFromUnknown(error, 'watch'));
      } catch {
        // Isolate observers.
      }
      return;
    }
    try {
      watcher.listener(event);
    } catch {
      // Watch callbacks are observational.
    }
  }

  private assertOpen(operation: FsOperation): void {
    if (!this.disposed) return;
    throw new FsError('disposed', 'Filesystem provider is disposed.', { operation });
  }
}

function unwrap<T>(result: HostFileSystemV2Result<T>, operation: FsOperation): T {
  if (!isRecord(result) || typeof result.ok !== 'boolean') {
    throw invalidTransport(operation, 'Filesystem transport returned an invalid result envelope.');
  }
  if (result.ok) {
    if (!('value' in result)) {
      throw invalidTransport(operation, 'Filesystem transport omitted a result value.');
    }
    return result.value;
  }
  if (!isSerializedFsError(result.error)) {
    throw invalidTransport(operation, 'Filesystem transport returned an invalid error envelope.');
  }
  throw deserializeFsError(result.error);
}

function normalizeEntry(entry: FileSystemEntrySnapshot): FileSystemEntrySnapshot {
  if (!isRecord(entry)) throw new TypeError('Expected a filesystem entry object.');
  if (typeof entry.path !== 'string')
    throw new TypeError('Filesystem entry path must be a string.');
  if (typeof entry.name !== 'string')
    throw new TypeError('Filesystem entry name must be a string.');
  if (typeof entry.lastModified !== 'string') {
    throw new TypeError('Filesystem entry timestamp must be a string.');
  }
  const path = parseWorkspacePath(entry.path);
  if (entry.name !== workspacePathBasename(path)) {
    throw new TypeError('Filesystem entry name does not match its canonical path.');
  }
  const common = {
    path,
    name: entry.name,
    version: parseFileSystemVersion(entry.version),
    lastModified: new Date(entry.lastModified).toISOString(),
  };
  if (entry.kind === 'file') {
    if (!isNonNegativeSafeInteger(entry.size)) {
      throw new TypeError('Filesystem file size must be a non-negative safe integer.');
    }
    return Object.freeze({ ...common, kind: 'file', size: entry.size });
  }
  if (entry.kind === 'directory') {
    if (entry.size !== null) throw new TypeError('Filesystem directory size must be null.');
    return Object.freeze({ ...common, kind: 'directory', size: null });
  }
  throw new TypeError('Unknown filesystem entry kind.');
}

function normalizeDirectoryListing(
  value: readonly FileSystemEntrySnapshot[],
  parent: WorkspacePath,
): readonly FileSystemEntrySnapshot[] {
  if (!Array.isArray(value)) throw new TypeError('Expected a filesystem directory listing.');
  const entries = value.map(normalizeEntry);
  const seen = new Set<WorkspacePath>();
  for (const entry of entries) {
    if (entry.path === WORKSPACE_ROOT || workspacePathDirname(entry.path) !== parent) {
      throw new TypeError('Filesystem listing contained a non-child entry.');
    }
    if (seen.has(entry.path)) throw new TypeError('Filesystem listing contained a duplicate path.');
    seen.add(entry.path);
  }
  const ordered = [...entries].sort(compareDirectoryEntries);
  if (ordered.some((entry, index) => entry.path !== entries[index]?.path)) {
    throw new TypeError('Filesystem listing was not in canonical deterministic order.');
  }
  return Object.freeze(entries);
}

function normalizeFile(entry: FileSystemFileSnapshot): FileSystemFileSnapshot {
  const normalized = normalizeEntry(entry);
  if (normalized.kind !== 'file') throw new TypeError('Expected a file snapshot.');
  return normalized;
}

function normalizeDirectory(entry: FileSystemDirectorySnapshot): FileSystemDirectorySnapshot {
  const normalized = normalizeEntry(entry);
  if (normalized.kind !== 'directory') throw new TypeError('Expected a directory snapshot.');
  return normalized;
}

function normalizeSnapshot(snapshot: FileSystemSnapshot): FileSystemSnapshot {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.entries)) {
    throw new TypeError('Expected a filesystem snapshot object.');
  }
  const version = parseFileSystemVersion(snapshot.version);
  const entries: FileSystemSnapshotEntry[] = snapshot.entries.map((entry) => {
    if (entry.kind === 'file') {
      const file = normalizeFile(entry);
      const data = copyWireBuffer(entry.data);
      if (data.byteLength !== file.size) {
        throw new TypeError('Filesystem snapshot file bytes have the wrong size.');
      }
      return Object.freeze({ ...file, data });
    }
    if (entry.kind === 'directory') return normalizeDirectory(entry);
    throw new TypeError('Unknown filesystem snapshot entry kind.');
  });
  const roots = entries.filter((entry) => entry.path === WORKSPACE_ROOT);
  if (roots.length !== 1 || roots[0]?.kind !== 'directory' || roots[0].version !== version) {
    throw new TypeError('Filesystem snapshot must contain one matching root directory.');
  }
  const seen = new Set<WorkspacePath>();
  for (const entry of entries) {
    if (seen.has(entry.path))
      throw new TypeError('Filesystem snapshot contained a duplicate path.');
    seen.add(entry.path);
  }
  const ordered = [...entries].sort((left, right) => compareText(left.path, right.path));
  if (ordered.some((entry, index) => entry.path !== entries[index]?.path)) {
    throw new TypeError('Filesystem snapshot was not in canonical deterministic order.');
  }
  return Object.freeze({
    version,
    entries: Object.freeze(entries),
  });
}

function normalizeWatchEvent(event: FileSystemWatchEvent): FileSystemWatchEvent {
  if (!isRecord(event)) throw new TypeError('Expected a filesystem watch event object.');
  if (!isPositiveSafeInteger(event.sequence)) {
    throw new TypeError('Filesystem watch sequence must be a positive safe integer.');
  }
  if (!isWatchOrigin(event.origin)) throw new TypeError('Unknown filesystem watch origin.');
  if (typeof event.path !== 'string') throw new TypeError('Watch event path must be a string.');
  const path = parseWorkspacePath(event.path);
  if (event.type === 'overflow') {
    if (
      event.kind !== null ||
      event.destinationPath !== null ||
      event.version !== null ||
      event.previousVersion !== null
    ) {
      throw new TypeError('Filesystem overflow event has entry-specific fields.');
    }
    return Object.freeze({
      sequence: event.sequence,
      origin: event.origin,
      type: 'overflow',
      kind: null,
      path,
      destinationPath: null,
      version: null,
      previousVersion: null,
    });
  }
  if (!isEntryWatchType(event.type)) throw new TypeError('Unknown filesystem watch event type.');
  if (event.kind !== 'file' && event.kind !== 'directory') {
    throw new TypeError('Unknown filesystem watch entry kind.');
  }
  const destinationPath =
    event.destinationPath === null
      ? null
      : typeof event.destinationPath === 'string'
        ? parseWorkspacePath(event.destinationPath)
        : (() => {
            throw new TypeError('Watch destination path must be a string or null.');
          })();
  if ((event.type === 'moved') !== (destinationPath !== null)) {
    throw new TypeError('Only moved watch events may have a destination path.');
  }
  return Object.freeze({
    sequence: event.sequence,
    origin: event.origin,
    type: event.type,
    kind: event.kind,
    path,
    destinationPath,
    version: event.version === null ? null : parseFileSystemVersion(event.version),
    previousVersion:
      event.previousVersion === null ? null : parseFileSystemVersion(event.previousVersion),
  });
}

function normalizeRemoveResult(value: FileSystemRemoveResult): FileSystemRemoveResult {
  if (!isRecord(value) || typeof value.removed !== 'boolean') {
    throw new TypeError('Filesystem transport returned an invalid remove result.');
  }
  return Object.freeze({ removed: value.removed, version: parseFileSystemVersion(value.version) });
}

function assertCapabilities(value: FileSystemProviderCapabilities, operation: FsOperation): void {
  if (!isRecord(value)) {
    throw invalidTransport(operation, 'Filesystem host returned invalid capabilities.');
  }
  for (const key of Object.keys(ELECTRON_FILE_SYSTEM_V2_CAPABILITIES) as Array<
    keyof FileSystemProviderCapabilities
  >) {
    if (value[key] !== ELECTRON_FILE_SYSTEM_V2_CAPABILITIES[key]) {
      throw invalidTransport(operation, `Filesystem host capability mismatch: ${key}.`);
    }
  }
}

function compareDirectoryEntries(
  left: FileSystemEntrySnapshot,
  right: FileSystemEntrySnapshot,
): number {
  if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
  return compareText(left.path, right.path);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isWatchOrigin(value: unknown): value is FileSystemWatchEvent['origin'] {
  return value === 'local' || value === 'external' || value === 'unknown';
}

function isEntryWatchType(
  value: unknown,
): value is Exclude<FileSystemWatchEvent['type'], 'overflow'> {
  return value === 'created' || value === 'modified' || value === 'removed' || value === 'moved';
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function invalidTransport(operation: FsOperation, message: string): FsError {
  return new FsError('io', message, { operation, retryable: false });
}

function transportErrorFromUnknown(error: unknown, operation: FsOperation): FsError {
  if (error instanceof TypeError) return invalidTransport(operation, error.message);
  return withOperation(fsErrorFromUnknown(error, { operation }), operation);
}

function withOperation(error: FsError, operation: FsOperation): FsError {
  if (error.operation === operation) return error;
  return new FsError(error.code, error.message, {
    operation,
    path: error.path ?? undefined,
    destinationPath: error.destinationPath ?? undefined,
    retryable: error.retryable,
  });
}

function copyBytes(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  const source = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy.buffer as ArrayBuffer;
}

function copyWireBuffer(data: ArrayBuffer): ArrayBuffer {
  if (Object.prototype.toString.call(data) !== '[object ArrayBuffer]') {
    throw new TypeError('Expected an ArrayBuffer from the filesystem transport.');
  }
  return data.slice(0);
}

function createInstanceId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === 'function') return randomUUID.call(globalThis.crypto);
  fallbackInstanceSequence += 1;
  return `electron-fs-v2-${Date.now()}-${fallbackInstanceSequence}`;
}
