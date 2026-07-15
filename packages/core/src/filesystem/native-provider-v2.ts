import { withFileCommitLock } from './commit-lock.js';
import { FsError, fsErrorFromUnknown, type FsOperation } from './fs-error.js';
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
  type FileSystemSnapshotFile,
  type FileSystemVersion,
  type FileSystemWatchListener,
  type FileSystemWatchOptions,
  type FileSystemWatchSubscription,
  type FileSystemWriteOptions,
} from './v2.js';
import {
  WORKSPACE_ROOT,
  parseWorkspacePath,
  workspacePathBasename,
  workspacePathContains,
  workspacePathDirname,
  workspacePathJoin,
  type WorkspacePath,
} from './workspace-path.js';
import { bytesEqual, copyBytes } from './internal/bytes.js';
import { compareSnapshotsByName, compareText } from './internal/entry-order.js';
import { parentChain } from './internal/parent-chain.js';

interface ScannedEntry<TFile extends FileSystemFileSnapshot> {
  readonly root: FileSystemDirectorySnapshot | TFile;
  readonly entries: readonly (FileSystemDirectorySnapshot | TFile)[];
}

type MetadataScan = ScannedEntry<FileSystemFileSnapshot>;
type SnapshotScan = ScannedEntry<FileSystemSnapshotFile>;

export type NativeFileSystemMovePathState = 'present' | 'missing' | 'unknown';

export interface NativeFileSystemMoveRecoveryState {
  readonly source: NativeFileSystemMovePathState;
  readonly destination: NativeFileSystemMovePathState;
}

/**
 * A copy/delete move failed and the provider could not prove that rollback
 * restored the source-only state. Callers must inspect `state` before retrying.
 */
export class NativeFileSystemMoveRecoveryError extends FsError {
  public readonly primaryError: FsError;
  public readonly recoveryErrors: readonly FsError[];
  public readonly state: NativeFileSystemMoveRecoveryState;

  public constructor(
    sourcePath: WorkspacePath,
    destinationPath: WorkspacePath,
    primaryError: FsError,
    recoveryErrors: readonly FsError[],
    state: NativeFileSystemMoveRecoveryState,
  ) {
    super(
      'io',
      `Native move recovery is incomplete (source: ${state.source}, destination: ${state.destination}).`,
      {
        operation: 'move',
        path: sourcePath,
        destinationPath,
        retryable: false,
      },
    );
    this.name = 'NativeFileSystemMoveRecoveryError';
    this.primaryError = primaryError;
    this.recoveryErrors = Object.freeze([...recoveryErrors]);
    this.state = Object.freeze({ ...state });
  }
}

const EPOCH = new Date(0).toISOString();

const NATIVE_V2_CAPABILITIES: FileSystemProviderCapabilities = Object.freeze({
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

/** Direct File System Access API implementation of FileSystemProviderV2. */
export class NativeFileSystemProviderV2 implements FileSystemProviderV2 {
  public readonly id: string;
  public readonly label: string;
  public readonly capabilities = NATIVE_V2_CAPABILITIES;

  private readonly root: FileSystemDirectoryHandle;
  private readonly lockKey: string;
  private readonly subscriptions = new Set<FileSystemWatchSubscription>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  public constructor(id: string, root: FileSystemDirectoryHandle) {
    this.id = id;
    this.label = root.name;
    this.root = root;
    this.lockKey = `native:${id}:workspace`;
  }

  public async stat(path: WorkspacePath): Promise<FileSystemEntrySnapshot | null> {
    const canonical = this.canonical(path);
    return this.execute('stat', canonical, null, async () => {
      const scanned = await this.tryScanMetadata(canonical, 'stat');
      return scanned ? withoutData(scanned.root) : null;
    });
  }

  public async readFile(path: WorkspacePath): Promise<FileSystemFileRead | null> {
    const canonical = this.canonical(path);
    return this.execute('read', canonical, null, async () => {
      const handle = await this.getHandle(canonical);
      if (!handle) return null;
      if (handle.kind !== 'file') {
        throw this.error('type-mismatch', 'read', canonical, 'Expected a file, found a directory.');
      }
      const scanned = await this.scanSnapshotHandle(canonical, handle, 'read');
      if (scanned.root.kind !== 'file') {
        throw this.error('io', 'read', canonical, 'Native file handle changed kind during read.');
      }
      return Object.freeze({
        entry: withoutData(scanned.root) as FileSystemFileSnapshot,
        data: scanned.root.data.slice(0),
      });
    });
  }

  public async readDirectory(path: WorkspacePath): Promise<readonly FileSystemEntrySnapshot[]> {
    const canonical = this.canonical(path);
    return this.execute('list', canonical, null, async () => {
      const handle = await this.getHandle(canonical);
      if (!handle) throw this.error('not-found', 'list', canonical, 'Directory does not exist.');
      if (handle.kind !== 'directory') {
        throw this.error('type-mismatch', 'list', canonical, 'Expected a directory, found a file.');
      }

      const children: FileSystemEntrySnapshot[] = [];
      for (const [name, childHandle] of await listDirectory(
        handle as FileSystemDirectoryHandle,
        'list',
        canonical,
      )) {
        const childPath = workspacePathJoin(canonical, name);
        children.push(
          withoutData((await this.scanMetadataHandle(childPath, childHandle, 'list')).root),
        );
      }
      children.sort(compareSnapshotsByName);
      return Object.freeze(children);
    });
  }

  public async writeFile(
    path: WorkspacePath,
    data: ArrayBuffer | Uint8Array,
    options: FileSystemWriteOptions = {},
  ): Promise<FileSystemFileSnapshot> {
    const canonical = this.canonicalNonRoot(path, 'write');
    const ownedData = copyBytes(data);
    return this.mutate('write', canonical, null, async () => {
      const mode = options.mode ?? 'upsert';
      if (mode !== 'upsert' && mode !== 'create' && mode !== 'replace') {
        throw this.error('invalid-path', 'write', canonical, 'Invalid write mode.');
      }

      const existing = await this.tryScanMetadata(canonical, 'write');
      if (existing?.root.kind === 'directory') {
        throw this.error(
          'type-mismatch',
          'write',
          canonical,
          'Cannot replace a directory with a file.',
        );
      }
      if (mode === 'create' && existing) {
        throw this.error('already-exists', 'write', canonical, 'File already exists.');
      }
      if (mode === 'replace' && !existing) {
        throw this.error('not-found', 'write', canonical, 'File does not exist.');
      }
      this.assertExpectedVersion(existing?.root, options.expectedVersion, 'write', canonical);

      const missingParents = await this.planParents(
        canonical,
        options.createParents ?? false,
        'write',
      );
      const createdParents = await this.createDirectories(missingParents);
      let writeCompleted = false;
      try {
        await this.writeBytes(canonical, ownedData);
        writeCompleted = true;
        const written = await this.requireSnapshot(canonical, 'write');
        if (written.root.kind !== 'file' || !bytesEqual(written.root.data, ownedData)) {
          throw this.error(
            'conflict',
            'write',
            canonical,
            'Stored bytes changed before the write could be verified.',
          );
        }
        return withoutData(written.root) as FileSystemFileSnapshot;
      } catch (error: unknown) {
        if (!existing && !writeCompleted) {
          await this.removeEmptyFileIfPresent(canonical).catch(() => undefined);
        }
        await this.rollbackDirectories(createdParents);
        throw error;
      }
    });
  }

  public async createDirectory(
    path: WorkspacePath,
    options: FileSystemCreateDirectoryOptions = {},
  ): Promise<FileSystemDirectorySnapshot> {
    const canonical = this.canonical(path);
    return this.mutate('create-directory', canonical, null, async () => {
      const mode = options.mode ?? 'ensure';
      if (mode !== 'ensure' && mode !== 'create') {
        throw this.error('invalid-path', 'create-directory', canonical, 'Invalid directory mode.');
      }
      const existing = await this.tryScanMetadata(canonical, 'create-directory');
      if (existing) {
        if (existing.root.kind !== 'directory') {
          throw this.error(
            'type-mismatch',
            'create-directory',
            canonical,
            'Cannot replace a file with a directory.',
          );
        }
        if (mode === 'create') {
          throw this.error(
            'already-exists',
            'create-directory',
            canonical,
            'Directory already exists.',
          );
        }
        return withoutData(existing.root) as FileSystemDirectorySnapshot;
      }

      const missingParents = await this.planParents(
        canonical,
        options.createParents ?? false,
        'create-directory',
      );
      const planned = [...missingParents, canonical];
      const created = await this.createDirectories(planned);
      try {
        const scanned = await this.requireMetadata(canonical, 'create-directory');
        if (scanned.root.kind !== 'directory') {
          throw this.error(
            'io',
            'create-directory',
            canonical,
            'The native backend did not create a directory.',
          );
        }
        return withoutData(scanned.root) as FileSystemDirectorySnapshot;
      } catch (error: unknown) {
        await this.rollbackDirectories(created);
        throw error;
      }
    });
  }

  public async remove(
    path: WorkspacePath,
    options: FileSystemRemoveOptions = {},
  ): Promise<FileSystemRemoveResult> {
    const canonical = this.canonicalNonRoot(path, 'remove');
    return this.mutate('remove', canonical, null, async () => {
      const existing = await this.tryScanMetadata(canonical, 'remove');
      if (!existing) {
        if ((options.missing ?? 'error') === 'ignore') {
          return Object.freeze({
            removed: false,
            version: await this.currentTreeVersion('remove'),
          });
        }
        throw this.error('not-found', 'remove', canonical, 'Entry does not exist.');
      }
      this.assertExpectedVersion(existing.root, options.expectedVersion, 'remove', canonical);
      if (existing.root.kind === 'directory' && !options.recursive) {
        const handle = await this.getHandle(canonical);
        if (!handle || handle.kind !== 'directory') {
          throw this.error('conflict', 'remove', canonical, 'Directory changed before removal.');
        }
        if (
          (await listDirectory(handle as FileSystemDirectoryHandle, 'remove', canonical)).length > 0
        ) {
          throw this.error('not-empty', 'remove', canonical, 'Directory is not empty.');
        }
      }

      await this.removeEntry(canonical, existing.root.kind === 'directory' && !!options.recursive);
      if (await this.getHandle(canonical)) {
        throw this.error('conflict', 'remove', canonical, 'Entry was recreated during removal.');
      }
      return Object.freeze({
        removed: true,
        version: await this.currentTreeVersion('remove'),
      });
    });
  }

  public async move(
    oldPath: WorkspacePath,
    newPath: WorkspacePath,
    options: FileSystemMoveOptions = {},
  ): Promise<FileSystemEntrySnapshot> {
    const sourcePath = this.canonicalNonRoot(oldPath, 'move');
    const destinationPath = this.canonicalNonRoot(newPath, 'move');
    return this.mutate('move', sourcePath, destinationPath, async () => {
      const sourceMetadata = await this.tryScanMetadata(sourcePath, 'move');
      if (!sourceMetadata) {
        throw this.error('not-found', 'move', sourcePath, 'Source does not exist.');
      }
      this.assertExpectedVersion(sourceMetadata.root, options.expectedVersion, 'move', sourcePath);
      if (sourcePath === destinationPath) return withoutData(sourceMetadata.root);
      if (
        sourceMetadata.root.kind === 'directory' &&
        workspacePathContains(sourcePath, destinationPath, false)
      ) {
        throw new FsError('invalid-path', 'Cannot move a directory into itself.', {
          operation: 'move',
          path: sourcePath,
          destinationPath,
        });
      }
      if (await this.getHandle(destinationPath)) {
        throw new FsError('already-exists', 'Destination already exists.', {
          operation: 'move',
          path: sourcePath,
          destinationPath,
        });
      }

      const missingParents = await this.planParents(
        destinationPath,
        options.createParents ?? false,
        'move',
      );
      const source = await this.tryScanSnapshot(sourcePath, 'move');
      if (
        !source ||
        source.root.kind !== sourceMetadata.root.kind ||
        source.root.version !== sourceMetadata.root.version
      ) {
        throw new FsError('conflict', 'Source changed before the move could be copied.', {
          operation: 'move',
          path: sourcePath,
          destinationPath,
        });
      }
      const createdParents = await this.createDirectories(missingParents);
      let destinationVersion: FileSystemVersion | null = null;
      let sourceDeleteAttempted = false;
      try {
        await this.writeTree(source, sourcePath, destinationPath);
        const copied = await this.requireSnapshot(destinationPath, 'move');
        destinationVersion = copied.root.version;
        if (!equalTreeContents(source, sourcePath, copied, destinationPath)) {
          throw new FsError('conflict', 'Destination changed while the move was copied.', {
            operation: 'move',
            path: sourcePath,
            destinationPath,
          });
        }

        const sourceBeforeDelete = await this.tryScanMetadata(sourcePath, 'move');
        if (
          !sourceBeforeDelete ||
          sourceBeforeDelete.root.kind !== source.root.kind ||
          sourceBeforeDelete.root.version !== source.root.version
        ) {
          throw new FsError('conflict', 'Source changed while the move was copied.', {
            operation: 'move',
            path: sourcePath,
            destinationPath,
          });
        }

        // The version check above is necessary but NOT sufficient to authorize
        // destroying the source. A native version token is
        // sha256(size + '\0' + lastModified), which cannot see a same-size
        // rewrite landing inside one coarse mtime tick -- FAT/exFAT stamp mtime
        // at 2s granularity, network shares coarser. Deleting on the strength
        // of that token alone can throw away an external edit this move never
        // copied, and `conditionalWrite: 'process'` does not excuse it: that
        // capability describes the atomicity boundary of a caller's
        // `expectedVersion`, whereas this is the provider's own internal proof,
        // reached with no concurrent DocBlocks writer involved.
        //
        // So prove it by bytes before deleting. A move already reads the whole
        // subtree, so re-reading it here is proportionate -- which is exactly
        // why the token itself must NOT hash content: `stat`/`readDirectory`
        // depend on staying metadata-only.
        if (!(await this.matchesCapturedSource(sourcePath, source))) {
          throw new FsError('conflict', 'Source changed while the move was copied.', {
            operation: 'move',
            path: sourcePath,
            destinationPath,
          });
        }

        // Recorded before the call, not after it: removing a directory is not
        // atomic, so a failure partway through still leaves the source damaged
        // and rollback must know the repair is ours to make.
        sourceDeleteAttempted = true;
        await this.removeEntry(sourcePath, source.root.kind === 'directory');
        const [sourceAfter, destinationAfter] = await Promise.all([
          this.tryScanMetadata(sourcePath, 'move'),
          this.tryScanMetadata(destinationPath, 'move'),
        ]);
        if (
          sourceAfter ||
          !destinationAfter ||
          destinationAfter.root.kind !== source.root.kind ||
          destinationAfter.root.version !== destinationVersion
        ) {
          throw new FsError('conflict', 'Move state changed before it could be verified.', {
            operation: 'move',
            path: sourcePath,
            destinationPath,
          });
        }
        return withoutData(destinationAfter.root);
      } catch (error: unknown) {
        return await this.rollbackMoveAndThrow(
          sourcePath,
          destinationPath,
          source,
          createdParents,
          destinationVersion,
          sourceDeleteAttempted,
          error,
        );
      }
    });
  }

  public async snapshot(): Promise<FileSystemSnapshot> {
    return this.mutate('snapshot', WORKSPACE_ROOT, null, async () => {
      const scanned = await this.scanSnapshotHandle(WORKSPACE_ROOT, this.root, 'snapshot');
      const entries = [...scanned.entries]
        .sort((left, right) => compareText(left.path, right.path))
        .map(copySnapshotEntry);
      return Object.freeze({ version: scanned.root.version, entries: Object.freeze(entries) });
    });
  }

  public watch(
    _listener: FileSystemWatchListener,
    options: FileSystemWatchOptions = {},
  ): FileSystemWatchSubscription {
    this.assertOpen('watch');
    const error = new FsError('not-supported', 'Native filesystem watching is unavailable.', {
      operation: 'watch',
    });
    let closed = false;
    let disposePromise: Promise<void> | null = null;
    const ready = Promise.reject(error);
    void ready.catch((caught: FsError) => {
      try {
        options.onError?.(caught);
      } catch {
        // Observers cannot change provider state.
      }
    });
    const subscription: FileSystemWatchSubscription = {
      get closed() {
        return closed;
      },
      ready,
      dispose: () => {
        if (disposePromise) return disposePromise;
        closed = true;
        this.subscriptions.delete(subscription);
        disposePromise = Promise.resolve();
        return disposePromise;
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
    })();
    return this.disposePromise;
  }

  private canonical(path: WorkspacePath): WorkspacePath {
    return parseWorkspacePath(String(path));
  }

  private canonicalNonRoot(path: WorkspacePath, operation: FsOperation): WorkspacePath {
    const canonical = this.canonical(path);
    if (!canonical) {
      throw this.error('invalid-path', operation, canonical, 'Workspace root cannot be mutated.');
    }
    return canonical;
  }

  private execute<T>(
    operation: FsOperation,
    path: WorkspacePath | null,
    destinationPath: WorkspacePath | null,
    work: () => Promise<T>,
  ): Promise<T> {
    this.assertOpen(operation);
    const promise = (async () => {
      try {
        return await work();
      } catch (error: unknown) {
        throw this.translateError(error, operation, path, destinationPath);
      }
    })();
    this.inFlight.add(promise);
    void promise.then(
      () => this.inFlight.delete(promise),
      () => this.inFlight.delete(promise),
    );
    return promise;
  }

  private mutate<T>(
    operation: FsOperation,
    path: WorkspacePath,
    destinationPath: WorkspacePath | null,
    work: () => Promise<T>,
  ): Promise<T> {
    return this.execute(operation, path, destinationPath, () =>
      withFileCommitLock(this.lockKey, work),
    );
  }

  private assertOpen(operation: FsOperation): void {
    if (!this.disposed) return;
    throw new FsError('disposed', 'Filesystem provider is disposed.', { operation });
  }

  private translateError(
    error: unknown,
    operation: FsOperation,
    path: WorkspacePath | null,
    destinationPath: WorkspacePath | null,
  ): FsError {
    if (error instanceof FsError) return error;
    return fsErrorFromUnknown(error, {
      operation,
      path: path ?? undefined,
      destinationPath: destinationPath ?? undefined,
    });
  }

  private error(
    code: ConstructorParameters<typeof FsError>[0],
    operation: FsOperation,
    path: WorkspacePath,
    message: string,
  ): FsError {
    return new FsError(code, message, { operation, path });
  }

  private assertExpectedVersion(
    entry: FileSystemEntrySnapshot | undefined,
    expected: FileSystemVersion | null | undefined,
    operation: FsOperation,
    path: WorkspacePath,
  ): void {
    if (expected === undefined) return;
    if (expected === null ? !entry : entry?.version === expected) return;
    throw this.error(
      'conflict',
      operation,
      path,
      'Entry version does not match the expected version.',
    );
  }

  private async resolveDirectory(path: WorkspacePath): Promise<FileSystemDirectoryHandle | null> {
    if (!path) return this.root;
    let current = this.root;
    for (const segment of path.split('/')) {
      try {
        current = await current.getDirectoryHandle(segment);
      } catch (error: unknown) {
        if (errorName(error) === 'NotFoundError') return null;
        throw error;
      }
    }
    return current;
  }

  private async getHandle(path: WorkspacePath): Promise<FileSystemHandle | null> {
    if (!path) return this.root;
    const parent = await this.resolveDirectory(workspacePathDirname(path));
    if (!parent) return null;
    const name = workspacePathBasename(path);
    try {
      return await parent.getFileHandle(name);
    } catch (error: unknown) {
      if (!isMissingOrKindError(error)) throw error;
    }
    try {
      return await parent.getDirectoryHandle(name);
    } catch (error: unknown) {
      if (!isMissingOrKindError(error)) throw error;
      return null;
    }
  }

  private async tryScanMetadata(
    path: WorkspacePath,
    operation: FsOperation,
  ): Promise<MetadataScan | null> {
    const handle = await this.getHandle(path);
    return handle ? this.scanMetadataHandle(path, handle, operation) : null;
  }

  private async tryScanSnapshot(
    path: WorkspacePath,
    operation: FsOperation,
  ): Promise<SnapshotScan | null> {
    const handle = await this.getHandle(path);
    return handle ? this.scanSnapshotHandle(path, handle, operation) : null;
  }

  private async requireMetadata(
    path: WorkspacePath,
    operation: FsOperation,
  ): Promise<MetadataScan> {
    const scanned = await this.tryScanMetadata(path, operation);
    if (!scanned) throw this.error('not-found', operation, path, 'Entry does not exist.');
    return scanned;
  }

  private async requireSnapshot(
    path: WorkspacePath,
    operation: FsOperation,
  ): Promise<SnapshotScan> {
    const scanned = await this.tryScanSnapshot(path, operation);
    if (!scanned) throw this.error('not-found', operation, path, 'Entry does not exist.');
    return scanned;
  }

  private scanMetadataHandle(
    path: WorkspacePath,
    handle: FileSystemHandle,
    operation: FsOperation,
  ): Promise<MetadataScan> {
    // File snapshots expose stable size/lastModified metadata without reading payload bytes.
    // Keep stat/list/version checks on this path so directory scans scale with entries, not bytes.
    return this.scanHandle(path, handle, operation, (filePath, fileHandle) =>
      this.scanFileMetadata(filePath, fileHandle, operation),
    );
  }

  private scanSnapshotHandle(
    path: WorkspacePath,
    handle: FileSystemHandle,
    operation: FsOperation,
  ): Promise<SnapshotScan> {
    return this.scanHandle(path, handle, operation, (filePath, fileHandle) =>
      this.scanFileSnapshot(filePath, fileHandle, operation),
    );
  }

  private async scanHandle<TFile extends FileSystemFileSnapshot>(
    path: WorkspacePath,
    handle: FileSystemHandle,
    operation: FsOperation,
    scanFile: (path: WorkspacePath, handle: FileSystemFileHandle) => Promise<TFile>,
  ): Promise<ScannedEntry<TFile>> {
    if (handle.kind === 'file') {
      const entry = await scanFile(path, handle as FileSystemFileHandle);
      return { root: entry, entries: Object.freeze([entry]) };
    }

    const children: ScannedEntry<TFile>[] = [];
    for (const [name, childHandle] of await listDirectory(
      handle as FileSystemDirectoryHandle,
      operation,
      path,
    )) {
      children.push(
        await this.scanHandle(workspacePathJoin(path, name), childHandle, operation, scanFile),
      );
    }
    const childRoots = children.map((child) => child.root).sort(compareSnapshotsByName);
    const version = await metadataVersion(
      'directory',
      new TextEncoder().encode(
        childRoots
          .map((child) => `${child.kind}\0${child.name.length}:${child.name}\0${child.version}`)
          .join('\n'),
      ),
      operation,
      path,
    );
    const directory: FileSystemDirectorySnapshot = Object.freeze({
      kind: 'directory' as const,
      path,
      name: workspacePathBasename(path),
      size: null,
      version,
      lastModified: newestLastModified(childRoots),
    });
    return {
      root: directory,
      entries: Object.freeze([directory, ...children.flatMap((child) => child.entries)]),
    };
  }

  private async scanFileMetadata(
    path: WorkspacePath,
    handle: FileSystemFileHandle,
    operation: FsOperation,
  ): Promise<FileSystemFileSnapshot> {
    const file = await this.getFileSnapshot(handle, path, operation);
    return this.fileMetadata(file, path, operation);
  }

  private async scanFileSnapshot(
    path: WorkspacePath,
    handle: FileSystemFileHandle,
    operation: FsOperation,
  ): Promise<FileSystemSnapshotFile> {
    const file = await this.getFileSnapshot(handle, path, operation);
    const metadata = await this.fileMetadata(file, path, operation);
    let data: ArrayBuffer;
    try {
      data = copyBytes(await file.arrayBuffer());
    } catch (error: unknown) {
      throw this.translateError(error, operation, path, null);
    }
    if (metadata.size !== data.byteLength) {
      throw this.error('io', operation, path, 'Native file metadata is inconsistent.');
    }
    return Object.freeze({ ...metadata, data });
  }

  private async getFileSnapshot(
    handle: FileSystemFileHandle,
    path: WorkspacePath,
    operation: FsOperation,
  ): Promise<File> {
    try {
      return await handle.getFile();
    } catch (error: unknown) {
      throw this.translateError(error, operation, path, null);
    }
  }

  private async fileMetadata(
    file: File,
    path: WorkspacePath,
    operation: FsOperation,
  ): Promise<FileSystemFileSnapshot> {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || !Number.isFinite(file.lastModified)) {
      throw this.error('io', operation, path, 'Native file metadata is inconsistent.');
    }

    let lastModified: string;
    try {
      lastModified = new Date(file.lastModified).toISOString();
    } catch {
      throw this.error('io', operation, path, 'Native file metadata is inconsistent.');
    }

    return Object.freeze({
      kind: 'file',
      path,
      name: workspacePathBasename(path),
      // Derived from size + mtime, never from content. This keeps stat/list
      // proportional to entry count instead of bytes (see scanMetadataHandle),
      // which is what makes large workspaces listable in a browser tab at all.
      //
      // The cost is a real blind spot: an external same-size rewrite inside one
      // mtime tick is invisible here. FAT/exFAT stamp mtime at 2-second
      // granularity, and network shares can be coarser, so this is reachable on
      // removable and mounted volumes rather than merely theoretical. Two
      // consequences follow, and neither is hypothetical:
      //   - a conditional write guarded on expectedVersion accepts, silently
      //     overwriting the external edit;
      //   - move() re-checks this version to prove the source is unchanged
      //     before deleting it, so it can delete a source whose bytes it never
      //     copied, losing the edit outright.
      // `conditionalWrite: 'process'` declares the first (expectedVersion binds
      // only against writers in this process). The second is a provider-internal
      // check that the token cannot actually support; closing it means
      // byte-comparing the captured source before the delete, not hashing
      // content here, which would undo the scan-by-metadata property above.
      size: file.size,
      version: await metadataVersion(
        'file',
        new TextEncoder().encode(`${file.size}\0${file.lastModified}`),
        operation,
        path,
      ),
      lastModified,
    });
  }

  private async planParents(
    path: WorkspacePath,
    createParents: boolean,
    operation: FsOperation,
  ): Promise<WorkspacePath[]> {
    const missing: WorkspacePath[] = [];
    for (const parent of parentChain(path)) {
      const handle = await this.getHandle(parent);
      if (handle?.kind === 'file') {
        throw this.error('type-mismatch', operation, parent, 'A parent path is a file.');
      }
      if (!handle) {
        if (!createParents) {
          throw this.error('not-found', operation, parent, 'Parent directory does not exist.');
        }
        missing.push(parent);
      }
    }
    return missing;
  }

  private async createDirectories(paths: readonly WorkspacePath[]): Promise<WorkspacePath[]> {
    const created: WorkspacePath[] = [];
    try {
      for (const path of paths) {
        if (!path) continue;
        const parent = await this.resolveDirectory(workspacePathDirname(path));
        if (!parent) {
          throw new DOMException('Parent directory does not exist.', 'NotFoundError');
        }
        await parent.getDirectoryHandle(workspacePathBasename(path), { create: true });
        created.push(path);
      }
      return created;
    } catch (error: unknown) {
      await this.rollbackDirectories(created);
      throw error;
    }
  }

  private async rollbackDirectories(paths: readonly WorkspacePath[]): Promise<void> {
    for (const path of [...paths].reverse()) {
      try {
        await this.removeEntry(path, false);
      } catch {
        // Best effort: a non-empty directory may now contain external data.
      }
    }
  }

  private async writeBytes(path: WorkspacePath, data: ArrayBuffer): Promise<void> {
    const parent = await this.resolveDirectory(workspacePathDirname(path));
    if (!parent) throw new DOMException('Parent directory does not exist.', 'NotFoundError');
    const fileHandle = await parent.getFileHandle(workspacePathBasename(path), { create: true });
    const writable = await fileHandle.createWritable();
    await writeAndClose(writable, data);
  }

  private async removeEntry(path: WorkspacePath, recursive: boolean): Promise<void> {
    const parent = await this.resolveDirectory(workspacePathDirname(path));
    if (!parent) throw new DOMException('Parent directory does not exist.', 'NotFoundError');
    await parent.removeEntry(workspacePathBasename(path), { recursive });
  }

  private async removeEmptyFileIfPresent(path: WorkspacePath): Promise<void> {
    const current = await this.tryScanMetadata(path, 'write');
    if (current?.root.kind !== 'file' || current.root.size !== 0) return;
    await this.removeEntry(path, false);
  }

  private async currentTreeVersion(operation: FsOperation): Promise<FileSystemVersion> {
    return (await this.scanMetadataHandle(WORKSPACE_ROOT, this.root, operation)).root.version;
  }

  private async writeTree(
    source: SnapshotScan,
    sourcePath: WorkspacePath,
    destinationPath: WorkspacePath,
  ): Promise<void> {
    const remapped = source.entries.map((entry) => {
      const suffix = entry.path.slice(sourcePath.length);
      return [entry, parseWorkspacePath(`${destinationPath}${suffix}`)] as const;
    });
    const directories = remapped
      .filter(
        (item): item is readonly [FileSystemDirectorySnapshot, WorkspacePath] =>
          item[0].kind === 'directory',
      )
      .sort((left, right) => pathDepth(left[1]) - pathDepth(right[1]));
    for (const [, path] of directories) {
      const parent = await this.resolveDirectory(workspacePathDirname(path));
      if (!parent) throw new DOMException('Parent directory does not exist.', 'NotFoundError');
      await parent.getDirectoryHandle(workspacePathBasename(path), { create: true });
    }
    for (const [entry, path] of remapped) {
      if (entry.kind === 'file') await this.writeBytes(path, entry.data);
    }
  }

  private async rollbackMoveAndThrow(
    sourcePath: WorkspacePath,
    destinationPath: WorkspacePath,
    source: SnapshotScan,
    createdParents: readonly WorkspacePath[],
    destinationVersion: FileSystemVersion | null,
    sourceDeleteAttempted: boolean,
    primary: unknown,
  ): Promise<never> {
    const primaryError = this.translateError(primary, 'move', sourcePath, destinationPath);
    const recoveryErrors: FsError[] = [];

    // Whether the source still holds everything the move captured. If this move
    // never reached the delete, the source is untouched and is not ours to
    // rewrite — a source that changed underneath us is the caller's conflict,
    // and restoring the captured copy over it would destroy that change.
    let sourceWhole = true;
    if (sourceDeleteAttempted) {
      sourceWhole = await this.matchesCapturedSource(sourcePath, source);
      if (!sourceWhole) {
        try {
          await this.writeTree(source, sourcePath, sourcePath);
          const restored = await this.probeSnapshot(sourcePath);
          if (!restored || !equalTreeContents(source, sourcePath, restored, sourcePath)) {
            throw new FsError('conflict', 'Restored source does not match its captured state.', {
              operation: 'move',
              path: sourcePath,
              destinationPath,
            });
          }
          sourceWhole = true;
        } catch (error: unknown) {
          recoveryErrors.push(this.translateError(error, 'move', sourcePath, destinationPath));
        }
      }
    }

    const destinationCurrent = await this.probeScan(destinationPath);
    if (destinationCurrent) {
      if (!sourceWhole) {
        // Removing a directory is not atomic, so the delete above can fail with
        // the source root still present but children already gone. The copy at
        // the destination is then the only complete one in existence: deleting
        // it to "undo" the move would destroy the user's data outright. Keep it
        // and report loudly instead.
        recoveryErrors.push(
          new FsError(
            'conflict',
            'Source is incomplete; rollback kept the copy at the destination.',
            {
              operation: 'move',
              path: sourcePath,
              destinationPath,
            },
          ),
        );
      } else if (destinationVersion && destinationCurrent.root.version !== destinationVersion) {
        recoveryErrors.push(
          new FsError('conflict', 'Destination changed; rollback will not delete it.', {
            operation: 'move',
            path: sourcePath,
            destinationPath,
          }),
        );
      } else {
        try {
          await this.removeEntry(destinationPath, destinationCurrent.root.kind === 'directory');
        } catch (error: unknown) {
          recoveryErrors.push(this.translateError(error, 'move', sourcePath, destinationPath));
        }
      }
    }
    await this.rollbackDirectories(createdParents);

    const state: NativeFileSystemMoveRecoveryState = {
      source: await this.probePresence(sourcePath),
      destination: await this.probePresence(destinationPath),
    };
    if (
      recoveryErrors.length === 0 &&
      state.source === 'present' &&
      state.destination === 'missing'
    ) {
      throw primaryError;
    }
    throw new NativeFileSystemMoveRecoveryError(
      sourcePath,
      destinationPath,
      primaryError,
      recoveryErrors,
      state,
    );
  }

  /**
   * Whether the source still holds exactly the bytes the move captured.
   *
   * A probe that fails answers "no": rollback must never treat an unverifiable
   * source as whole, because that is precisely what licenses deleting the copy
   * at the destination.
   */
  private async matchesCapturedSource(
    sourcePath: WorkspacePath,
    source: SnapshotScan,
  ): Promise<boolean> {
    const current = await this.probeSnapshot(sourcePath);
    if (!current) return false;
    return equalTreeContents(source, sourcePath, current, sourcePath);
  }

  private async probeScan(path: WorkspacePath): Promise<MetadataScan | null | undefined> {
    try {
      return await this.tryScanMetadata(path, 'move');
    } catch {
      return undefined;
    }
  }

  private async probeSnapshot(path: WorkspacePath): Promise<SnapshotScan | null | undefined> {
    try {
      return await this.tryScanSnapshot(path, 'move');
    } catch {
      return undefined;
    }
  }

  private async probePresence(path: WorkspacePath): Promise<NativeFileSystemMovePathState> {
    try {
      return (await this.getHandle(path)) ? 'present' : 'missing';
    } catch {
      return 'unknown';
    }
  }
}

async function listDirectory(
  directory: FileSystemDirectoryHandle,
  operation: FsOperation,
  path: WorkspacePath,
): Promise<readonly (readonly [string, FileSystemHandle])[]> {
  const entries: Array<readonly [string, FileSystemHandle]> = [];
  try {
    for await (const entry of directory as unknown as AsyncIterable<
      readonly [string, FileSystemHandle]
    >) {
      const [name, handle] = entry;
      if (
        typeof name !== 'string' ||
        !handle ||
        (handle.kind !== 'file' && handle.kind !== 'directory')
      ) {
        throw new FsError('io', 'Native directory returned an invalid entry.', {
          operation,
          path,
        });
      }
      entries.push([name, handle]);
    }
  } catch (error: unknown) {
    throw fsErrorFromUnknown(error, { operation, path });
  }
  entries.sort(([left], [right]) => compareText(left, right));
  return entries;
}

async function writeAndClose(
  writable: FileSystemWritableFileStream,
  data: ArrayBuffer,
): Promise<void> {
  try {
    await writable.write(data);
    await writable.close();
  } catch (error: unknown) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
}

async function metadataVersion(
  kind: 'file' | 'directory',
  metadata: Uint8Array,
  operation: FsOperation,
  path: WorkspacePath,
): Promise<FileSystemVersion> {
  const prefix = new TextEncoder().encode(`${kind}\0`);
  const input = new Uint8Array(prefix.byteLength + metadata.byteLength);
  input.set(prefix);
  input.set(metadata, prefix.byteLength);
  let digest: ArrayBuffer;
  try {
    digest = await globalThis.crypto.subtle.digest('SHA-256', input.buffer as ArrayBuffer);
  } catch (error: unknown) {
    throw fsErrorFromUnknown(error, {
      operation,
      path,
      defaultCode: 'not-supported',
    });
  }
  const hex = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return parseFileSystemVersion(`sha256:${hex}`);
}

function pathDepth(path: WorkspacePath): number {
  return path ? path.split('/').length : 0;
}

function errorName(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' ? name : null;
}

function isMissingOrKindError(error: unknown): boolean {
  const name = errorName(error);
  return name === 'NotFoundError' || name === 'TypeMismatchError';
}

function equalTreeContents(
  left: SnapshotScan,
  leftRoot: WorkspacePath,
  right: SnapshotScan,
  rightRoot: WorkspacePath,
): boolean {
  if (left.entries.length !== right.entries.length) return false;

  const rightByRelativePath = new Map<
    string,
    FileSystemDirectorySnapshot | FileSystemSnapshotFile
  >();
  for (const entry of right.entries) {
    const relativePath = treeRelativePath(rightRoot, entry.path);
    if (relativePath === null || rightByRelativePath.has(relativePath)) return false;
    rightByRelativePath.set(relativePath, entry);
  }

  for (const entry of left.entries) {
    const relativePath = treeRelativePath(leftRoot, entry.path);
    if (relativePath === null) return false;
    const counterpart = rightByRelativePath.get(relativePath);
    if (!counterpart || counterpart.kind !== entry.kind) return false;
    if (entry.kind === 'file') {
      if (counterpart.kind !== 'file' || !bytesEqual(entry.data, counterpart.data)) return false;
    }
  }
  return true;
}

function treeRelativePath(root: WorkspacePath, path: WorkspacePath): string | null {
  if (path === root) return '';
  const prefix = root ? `${root}/` : '';
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

function withoutData(entry: FileSystemEntrySnapshot): FileSystemEntrySnapshot {
  if (entry.kind === 'directory') return Object.freeze({ ...entry });
  return Object.freeze({
    kind: 'file',
    path: entry.path,
    name: entry.name,
    size: entry.size,
    version: entry.version,
    lastModified: entry.lastModified,
  });
}

function copySnapshotEntry(entry: FileSystemSnapshotEntry): FileSystemSnapshotEntry {
  if (entry.kind === 'directory') return Object.freeze({ ...entry });
  return Object.freeze({
    kind: 'file',
    path: entry.path,
    name: entry.name,
    size: entry.size,
    version: entry.version,
    lastModified: entry.lastModified,
    data: entry.data.slice(0),
  });
}

function newestLastModified(children: readonly FileSystemEntrySnapshot[]): string {
  let newest = 0;
  for (const child of children) {
    const timestamp = Date.parse(child.lastModified);
    if (Number.isFinite(timestamp)) newest = Math.max(newest, timestamp);
  }
  return newest ? new Date(newest).toISOString() : EPOCH;
}
