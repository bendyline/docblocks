import {
  FsError,
  fsErrorFromUnknown,
  type FsErrorCode,
  type FsErrorContext,
  type FsOperation,
} from './fs-error.js';
import { withFileCommitLock } from './commit-lock.js';
import {
  RawIndexedDBFileSystemStore,
  indexedDBWorkspaceDatabaseName,
  type IndexedDBFileSystemStore,
  type IndexedDBFileSystemTransaction,
  type IndexedDBFileSystemTransactionMode,
} from './indexeddb-store.js';
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
  type WorkspacePath,
} from './workspace-path.js';
import type { FileMeta } from './types.js';

const ENTRY_SCHEMA_VERSION = 1;
const STATE_SCHEMA_VERSION = 1;
const LEGACY_CONFLICT_SCHEMA_VERSION = 2;
const LEGACY_CONFLICT_SCHEMA_VERSION_V1 = 1;
const ENTRY_PREFIX = 'v2:entry:';
const STATE_KEY = 'v2:state';
const LEGACY_CONFLICT_PREFIX = 'v2:legacy-conflict:';
const LEGACY_IGNORED_PREFIX = 'v2:legacy-ignored:';
const LEGACY_OPAQUE_PREFIX = 'v2:legacy-opaque:';
const LEGACY_DIRS_KEY = 'fs:dirs';
const LEGACY_PREFIX = 'fs:';
const LEGACY_CONTENT_SUFFIX = ':content';
const LEGACY_BINARY_SUFFIX = ':binary';
const LEGACY_META_SUFFIX = ':meta';

class LegacyNamespaceDetectedError extends Error {}

const INDEXEDDB_V2_CAPABILITIES: FileSystemProviderCapabilities = Object.freeze({
  writeAtomicity: 'cross-context',
  moveAtomicity: 'cross-context',
  snapshotAtomicity: 'cross-context',
  conditionalWrite: 'storage-atomic',
  recursiveRemove: true,
  watch: false,
  caseSensitivity: 'sensitive',
  symlinkPolicy: 'unsupported',
  durability: 'best-effort',
});

interface PersistedEntryBase {
  readonly schemaVersion: typeof ENTRY_SCHEMA_VERSION;
  readonly path: WorkspacePath;
  readonly version: string;
  readonly lastModified: string;
}

interface PersistedFileEntry extends PersistedEntryBase {
  readonly kind: 'file';
  readonly data: ArrayBuffer;
}

interface PersistedDirectoryEntry extends PersistedEntryBase {
  readonly kind: 'directory';
}

type PersistedEntry = PersistedFileEntry | PersistedDirectoryEntry;

interface PersistedState {
  readonly schemaVersion: typeof STATE_SCHEMA_VERSION;
  readonly migrationVersion: 1 | 2;
  readonly mutationCounter: number;
  readonly treeVersion: string;
}

export type IndexedDBLegacyConflictReason =
  | 'dual-payload'
  | 'kind-collision'
  | 'authority-collision'
  | 'stale-client-write';

export type IndexedDBLegacyRecoveryKind = 'file' | 'directory';

interface PersistedLegacyRecoveryCandidate {
  readonly kind: IndexedDBLegacyRecoveryKind;
  readonly reason: IndexedDBLegacyConflictReason;
  readonly text: string | null;
  readonly binary: ArrayBuffer | null;
  readonly metadata: FileMeta | null;
  readonly detectedAt: string;
}

interface PersistedLegacyConflict {
  readonly schemaVersion: typeof LEGACY_CONFLICT_SCHEMA_VERSION;
  readonly path: WorkspacePath;
  readonly candidates: readonly PersistedLegacyRecoveryCandidate[];
}

export interface IndexedDBLegacyRecoveryCandidate {
  readonly kind: IndexedDBLegacyRecoveryKind;
  readonly reason: IndexedDBLegacyConflictReason;
  readonly text: string | null;
  readonly binary: ArrayBuffer | null;
  readonly metadata: FileMeta | null;
  readonly detectedAt: string;
}

export interface IndexedDBLegacyMigrationConflict {
  readonly path: WorkspacePath;
  /** Backward-compatible projection of the newest quarantined candidate. */
  readonly reason: IndexedDBLegacyConflictReason;
  readonly kind: IndexedDBLegacyRecoveryKind;
  readonly text: string | null;
  readonly binary: ArrayBuffer | null;
  readonly metadata: FileMeta | null;
  readonly detectedAt: string;
  readonly candidates: readonly IndexedDBLegacyRecoveryCandidate[];
}

export type IndexedDBLegacyConflictResolution =
  | 'v2'
  | 'text'
  | 'binary'
  | {
      readonly candidate: number;
      readonly payload: 'text' | 'binary' | 'directory';
    };

export interface IndexedDBFileSystemProviderV2Options {
  /** Injectable store for fault, migration, and concurrency tests. */
  readonly store?: IndexedDBFileSystemStore;
  readonly now?: () => Date;
  /** Shared-store owners can retain the connection when this facade is disposed. */
  readonly closeStoreOnDispose?: boolean;
}

interface MutationVersion {
  readonly state: PersistedState;
  readonly version: FileSystemVersion;
  readonly lastModified: string;
}

/**
 * IndexedDB implementation of the correctness-first filesystem contract.
 *
 * Each canonical path has one authoritative structured-clone record containing
 * its kind, owned bytes (for files), version, and metadata. Every mutation and
 * snapshot is one IndexedDB transaction. Legacy v1 keys are imported once;
 * ambiguous or stale branches move into durable recovery records before the
 * legacy namespace is deleted, leaving one live authority.
 */
export class IndexedDBFileSystemProviderV2 implements FileSystemProviderV2 {
  public readonly id: string;
  public readonly label: string;
  public readonly capabilities = INDEXEDDB_V2_CAPABILITIES;

  private readonly store: IndexedDBFileSystemStore;
  private readonly now: () => Date;
  private readonly closeStoreOnDispose: boolean;
  private readonly versionPrefix: string;
  private readonly subscriptions = new Set<FileSystemWatchSubscription>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private initialization: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;
  private storeClosed = false;
  private disposed = false;

  public constructor(
    id: string,
    label: string,
    options: IndexedDBFileSystemProviderV2Options = {},
  ) {
    this.id = id;
    this.label = label;
    this.store =
      options.store ?? new RawIndexedDBFileSystemStore(indexedDBWorkspaceDatabaseName(id), 'files');
    this.now = options.now ?? (() => new Date());
    this.closeStoreOnDispose = options.closeStoreOnDispose ?? true;
    this.versionPrefix = `idb-${encodeURIComponent(id).slice(0, 900) || 'workspace'}`;
  }

  /** Track accepted storage work so disposal can join it before closing. */
  private runSharedTransaction<T>(
    mode: IndexedDBFileSystemTransactionMode,
    operation: FsOperation,
    work: (transaction: IndexedDBFileSystemTransaction) => Promise<T>,
  ): Promise<T> {
    this.assertOpen(operation);
    const transaction = this.store.transaction(mode, work);
    this.inFlight.add(transaction);
    void transaction.then(
      () => this.inFlight.delete(transaction),
      () => this.inFlight.delete(transaction),
    );
    return transaction;
  }

  public async stat(path: WorkspacePath): Promise<FileSystemEntrySnapshot | null> {
    this.assertOpen('stat');
    const canonical = parseWorkspacePath(path);
    await this.ensureInitialized('stat');
    return this.transaction('readonly', { operation: 'stat', path: canonical }, async (tx) => {
      const entry = await readEntry(tx, canonical);
      return entry ? toEntrySnapshot(entry) : null;
    });
  }

  public async readFile(path: WorkspacePath): Promise<FileSystemFileRead | null> {
    this.assertOpen('read');
    const canonical = parseWorkspacePath(path);
    await this.ensureInitialized('read');
    return this.transaction('readonly', { operation: 'read', path: canonical }, async (tx) => {
      const entry = await readEntry(tx, canonical);
      if (!entry) return null;
      if (entry.kind !== 'file') {
        throw this.error(
          'type-mismatch',
          'read',
          canonical,
          'Expected a file but found a directory.',
        );
      }
      return Object.freeze({ entry: toFileSnapshot(entry), data: copyBytes(entry.data) });
    });
  }

  public async readDirectory(path: WorkspacePath): Promise<readonly FileSystemEntrySnapshot[]> {
    this.assertOpen('list');
    const canonical = parseWorkspacePath(path);
    await this.ensureInitialized('list');
    return this.transaction('readonly', { operation: 'list', path: canonical }, async (tx) => {
      const directory = await readEntry(tx, canonical);
      if (!directory) {
        throw this.error('not-found', 'list', canonical, 'Directory does not exist.');
      }
      if (directory.kind !== 'directory') {
        throw this.error(
          'type-mismatch',
          'list',
          canonical,
          'Expected a directory but found a file.',
        );
      }
      const paths = await listEntryPaths(tx);
      const children: FileSystemEntrySnapshot[] = [];
      for (const candidate of paths) {
        if (candidate && workspacePathDirname(candidate) === canonical) {
          const entry = await readRequiredEntry(tx, candidate);
          children.push(toEntrySnapshot(entry));
        }
      }
      children.sort(compareSnapshots);
      return Object.freeze(children);
    });
  }

  public async writeFile(
    path: WorkspacePath,
    data: ArrayBuffer | Uint8Array,
    options: FileSystemWriteOptions = {},
  ): Promise<FileSystemFileSnapshot> {
    this.assertOpen('write');
    const canonical = this.canonicalNonRoot(path, 'write');
    const ownedData = copyBytes(data);
    await this.ensureInitialized('write');
    return this.withMutationLock(() =>
      this.transaction('readwrite', { operation: 'write', path: canonical }, async (tx) => {
        await assertNoLegacyConflict(tx, canonical, 'write');
        const mutation = new EntryMutation(tx);
        const existing = await mutation.get(canonical);
        if (existing?.kind === 'directory') {
          throw this.error(
            'type-mismatch',
            'write',
            canonical,
            'Cannot replace a directory with a file.',
          );
        }
        const mode = options.mode ?? 'upsert';
        if (mode === 'create' && existing) {
          throw this.error('already-exists', 'write', canonical, 'File already exists.');
        }
        if (mode === 'replace' && !existing) {
          throw this.error('not-found', 'write', canonical, 'File does not exist.');
        }
        this.assertExpectedVersion(existing, options.expectedVersion, 'write', canonical);
        const missingParents = await this.planParents(
          mutation,
          canonical,
          options.createParents ?? false,
          'write',
        );
        const next = await this.nextMutationVersion(tx);
        this.addDirectories(mutation, missingParents, next);
        const file: PersistedFileEntry = {
          schemaVersion: ENTRY_SCHEMA_VERSION,
          kind: 'file',
          path: canonical,
          data: ownedData,
          version: next.version,
          lastModified: next.lastModified,
        };
        mutation.set(canonical, file);
        await this.touchParents(mutation, canonical, next);
        await mutation.commit(next.state);
        return toFileSnapshot(file);
      }),
    );
  }

  public async createDirectory(
    path: WorkspacePath,
    options: FileSystemCreateDirectoryOptions = {},
  ): Promise<FileSystemDirectorySnapshot> {
    this.assertOpen('create-directory');
    const canonical = parseWorkspacePath(path);
    await this.ensureInitialized('create-directory');
    return this.withMutationLock(() =>
      this.transaction(
        'readwrite',
        { operation: 'create-directory', path: canonical },
        async (tx) => {
          await assertNoLegacyConflict(tx, canonical, 'create-directory');
          const mutation = new EntryMutation(tx);
          const existing = await mutation.get(canonical);
          if (existing) {
            if (existing.kind !== 'directory') {
              throw this.error(
                'type-mismatch',
                'create-directory',
                canonical,
                'Cannot replace a file with a directory.',
              );
            }
            if ((options.mode ?? 'ensure') === 'create') {
              throw this.error(
                'already-exists',
                'create-directory',
                canonical,
                'Directory already exists.',
              );
            }
            return toDirectorySnapshot(existing);
          }
          const missingParents = await this.planParents(
            mutation,
            canonical,
            options.createParents ?? false,
            'create-directory',
          );
          const next = await this.nextMutationVersion(tx);
          this.addDirectories(mutation, [...missingParents, canonical], next);
          await this.touchParents(mutation, canonical, next);
          await mutation.commit(next.state);
          const created = await mutation.get(canonical);
          if (!created || created.kind !== 'directory') {
            throw corrupt('Created directory was not staged.', canonical);
          }
          return toDirectorySnapshot(created);
        },
      ),
    );
  }

  public async remove(
    path: WorkspacePath,
    options: FileSystemRemoveOptions = {},
  ): Promise<FileSystemRemoveResult> {
    this.assertOpen('remove');
    const canonical = this.canonicalNonRoot(path, 'remove');
    await this.ensureInitialized('remove');
    return this.withMutationLock(() =>
      this.transaction('readwrite', { operation: 'remove', path: canonical }, async (tx) => {
        const mutation = new EntryMutation(tx);
        const existing = await mutation.get(canonical);
        const state = await readRequiredState(tx);
        if (!existing) {
          if ((options.missing ?? 'error') === 'ignore') {
            return Object.freeze({
              removed: false,
              version: parseFileSystemVersion(state.treeVersion),
            });
          }
          throw this.error('not-found', 'remove', canonical, 'Entry does not exist.');
        }
        this.assertExpectedVersion(existing, options.expectedVersion, 'remove', canonical);
        const paths = await mutation.paths();
        const descendants = paths.filter((candidate) =>
          workspacePathContains(canonical, candidate, false),
        );
        if (existing.kind === 'directory' && descendants.length > 0 && !options.recursive) {
          throw this.error('not-empty', 'remove', canonical, 'Directory is not empty.');
        }
        const next = this.advanceState(state);
        mutation.delete(canonical);
        if (existing.kind === 'directory') {
          for (const descendant of descendants) mutation.delete(descendant);
        }
        await this.touchParents(mutation, canonical, next);
        await mutation.commit(next.state);
        return Object.freeze({ removed: true, version: next.version });
      }),
    );
  }

  public async move(
    oldPath: WorkspacePath,
    newPath: WorkspacePath,
    options: FileSystemMoveOptions = {},
  ): Promise<FileSystemEntrySnapshot> {
    this.assertOpen('move');
    const sourcePath = this.canonicalNonRoot(oldPath, 'move');
    const destinationPath = this.canonicalNonRoot(newPath, 'move');
    await this.ensureInitialized('move');
    return this.withMutationLock(() =>
      this.transaction(
        'readwrite',
        { operation: 'move', path: sourcePath, destinationPath },
        async (tx) => {
          await assertNoLegacyConflict(tx, sourcePath, 'move');
          await assertNoLegacyConflict(tx, destinationPath, 'move');
          const mutation = new EntryMutation(tx);
          const source = await mutation.get(sourcePath);
          if (!source) {
            throw this.error('not-found', 'move', sourcePath, 'Source does not exist.');
          }
          this.assertExpectedVersion(source, options.expectedVersion, 'move', sourcePath);
          if (sourcePath === destinationPath) return toEntrySnapshot(source);
          if (await mutation.get(destinationPath)) {
            throw new FsError('already-exists', 'Destination already exists.', {
              operation: 'move',
              path: sourcePath,
              destinationPath,
            });
          }
          if (
            source.kind === 'directory' &&
            workspacePathContains(sourcePath, destinationPath, false)
          ) {
            throw new FsError('invalid-path', 'Cannot move a directory into itself.', {
              operation: 'move',
              path: sourcePath,
              destinationPath,
            });
          }
          const missingParents = await this.planParents(
            mutation,
            destinationPath,
            options.createParents ?? false,
            'move',
          );
          const paths = await mutation.paths();
          const sourcePaths = paths.filter((candidate) =>
            workspacePathContains(sourcePath, candidate),
          );
          const sourceSet = new Set(sourcePaths);
          const remapped: Array<readonly [WorkspacePath, WorkspacePath, PersistedEntry]> = [];
          for (const currentPath of sourcePaths) {
            const suffix = currentPath.slice(sourcePath.length);
            const targetPath = parseWorkspacePath(`${destinationPath}${suffix}`);
            const collision = await mutation.get(targetPath);
            if (collision && !sourceSet.has(targetPath)) {
              throw new FsError('already-exists', 'A destination descendant already exists.', {
                operation: 'move',
                path: currentPath,
                destinationPath: targetPath,
              });
            }
            remapped.push([currentPath, targetPath, await mutation.require(currentPath)]);
          }
          const state = await readRequiredState(tx);
          const next = this.advanceState(state);
          for (const currentPath of sourcePaths) mutation.delete(currentPath);
          this.addDirectories(mutation, missingParents, next);
          for (const [, targetPath, current] of remapped) {
            mutation.set(targetPath, withPathAndVersion(current, targetPath, next));
          }
          await this.touchParents(mutation, sourcePath, next);
          await this.touchParents(mutation, destinationPath, next);
          await mutation.commit(next.state);
          return toEntrySnapshot(await mutation.require(destinationPath));
        },
      ),
    );
  }

  public async snapshot(): Promise<FileSystemSnapshot> {
    this.assertOpen('snapshot');
    await this.ensureInitialized('snapshot');
    return this.transaction('readonly', { operation: 'snapshot' }, async (tx) => {
      const [state, paths] = await Promise.all([readRequiredState(tx), listEntryPaths(tx)]);
      const entries: FileSystemSnapshotEntry[] = [];
      for (const path of paths.sort(compareText)) {
        const entry = await readRequiredEntry(tx, path);
        entries.push(
          entry.kind === 'file'
            ? Object.freeze({ ...toFileSnapshot(entry), data: copyBytes(entry.data) })
            : toDirectorySnapshot(entry),
        );
      }
      return Object.freeze({
        version: parseFileSystemVersion(state.treeVersion),
        entries: Object.freeze(entries),
      });
    });
  }

  /** IndexedDB has no reliable cross-browser external-change observer. */
  public watch(
    _listener: FileSystemWatchListener,
    options: FileSystemWatchOptions = {},
  ): FileSystemWatchSubscription {
    this.assertOpen('watch');
    const error = new FsError('not-supported', 'IndexedDB filesystem watching is unavailable.', {
      operation: 'watch',
    });
    let closed = false;
    let disposePromise: Promise<void> | null = null;
    const ready = Promise.reject(error);
    void ready.catch((caught: FsError) => {
      try {
        options.onError?.(caught);
      } catch {
        // An observational error callback cannot change subscription state.
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
      try {
        await Promise.allSettled([...this.inFlight]);
        await Promise.all([...this.subscriptions].map((subscription) => subscription.dispose()));
      } finally {
        if (this.closeStoreOnDispose && !this.storeClosed) {
          this.storeClosed = true;
          this.store.close?.();
        }
      }
    })();
    return this.disposePromise;
  }

  /** List unresolved, byte-preserving conflicts found during v1 migration. */
  public async listLegacyMigrationConflicts(): Promise<
    readonly IndexedDBLegacyMigrationConflict[]
  > {
    this.assertOpen('read');
    await this.ensureInitialized('read');
    return this.transaction('readonly', { operation: 'read' }, async (tx) => {
      const keys = (await tx.keys()).filter((key) => key.startsWith(LEGACY_CONFLICT_PREFIX));
      const conflicts: IndexedDBLegacyMigrationConflict[] = [];
      for (const key of keys) {
        const raw = await tx.get<unknown>(key);
        conflicts.push(toPublicLegacyConflict(validateLegacyConflict(raw)));
      }
      conflicts.sort((left, right) => compareText(left.path, right.path));
      return Object.freeze(conflicts);
    });
  }

  /** Resolve quarantined legacy data by choosing v2 or one legacy byte payload. */
  public async resolveLegacyMigrationConflict(
    path: WorkspacePath,
    resolution: IndexedDBLegacyConflictResolution,
  ): Promise<FileSystemEntrySnapshot> {
    this.assertOpen('write');
    const canonical = this.canonicalNonRoot(path, 'write');
    await this.ensureInitialized('write');
    return this.withMutationLock(() =>
      this.transaction('readwrite', { operation: 'write', path: canonical }, async (tx) => {
        const key = legacyConflictKey(canonical);
        const conflict = validateLegacyConflict(await tx.get<unknown>(key));
        if (conflict.path !== canonical) throw corrupt('Legacy conflict key mismatch.', canonical);
        const mutation = new EntryMutation(tx);
        const existing = await mutation.get(canonical);
        if (resolution === 'v2') {
          if (!existing) {
            throw this.error(
              'type-mismatch',
              'write',
              canonical,
              'There is no v2 authority to keep at this path.',
            );
          }
          await tx.delete(key);
          return toEntrySnapshot(existing);
        }

        const selected = selectLegacyPayload(conflict, resolution, canonical);
        if (selected.kind === 'directory') {
          if (existing?.kind === 'file') {
            throw this.error(
              'type-mismatch',
              'write',
              canonical,
              'Move or remove the v2 file before restoring a legacy directory at this path.',
            );
          }
          if (existing) {
            await tx.delete(key);
            return toDirectorySnapshot(existing);
          }
          const missingParents = await this.planParents(mutation, canonical, true, 'write');
          const next = await this.nextMutationVersion(tx);
          this.addDirectories(mutation, [...missingParents, canonical], next);
          await this.touchParents(mutation, canonical, next);
          await mutation.commit(next.state);
          await tx.delete(key);
          const restored = await mutation.require(canonical);
          if (restored.kind !== 'directory') {
            throw corrupt('Restored legacy directory was not staged as a directory.', canonical);
          }
          return toDirectorySnapshot(restored);
        }
        if (existing?.kind === 'directory') {
          throw this.error(
            'type-mismatch',
            'write',
            canonical,
            'Move or remove the v2 directory before restoring a legacy file at this path.',
          );
        }
        const missingParents = await this.planParents(mutation, canonical, true, 'write');
        const next = await this.nextMutationVersion(tx);
        this.addDirectories(mutation, missingParents, next);
        const file: PersistedFileEntry = {
          schemaVersion: ENTRY_SCHEMA_VERSION,
          kind: 'file',
          path: canonical,
          data: copyBytes(selected.data),
          version: next.version,
          lastModified: next.lastModified,
        };
        mutation.set(canonical, file);
        await this.touchParents(mutation, canonical, next);
        await mutation.commit(next.state);
        await tx.delete(key);
        return toFileSnapshot(file);
      }),
    );
  }

  /** Explicitly discard every quarantined legacy candidate at a path. */
  public async discardLegacyMigrationConflict(path: WorkspacePath): Promise<boolean> {
    this.assertOpen('remove');
    const canonical = this.canonicalNonRoot(path, 'remove');
    await this.ensureInitialized('remove');
    return this.withMutationLock(() =>
      this.transaction('readwrite', { operation: 'remove', path: canonical }, async (tx) => {
        const key = legacyConflictKey(canonical);
        if ((await tx.get<unknown>(key)) === null) return false;
        await tx.delete(key);
        return true;
      }),
    );
  }

  private async ensureInitialized(operation: FsOperation): Promise<void> {
    this.assertOpen(operation);
    if (this.initialization) return this.initialization;
    const attempt = this.withMutationLock(() =>
      this.runSharedTransaction('readwrite', operation, (tx) => this.migrateLegacy(tx)),
    );
    this.initialization = attempt.catch((error: unknown) => {
      this.initialization = null;
      throw fsErrorFromUnknown(error, { operation });
    });
    return this.initialization;
  }

  private async migrateLegacy(tx: IndexedDBFileSystemTransaction): Promise<void> {
    const existingState = await readState(tx);
    const keys = await tx.keys();
    if (existingState) {
      const root = await readEntry(tx, WORKSPACE_ROOT);
      if (!root || root.kind !== 'directory') {
        throw corrupt('Initialized v2 filesystem has no root directory.', WORKSPACE_ROOT);
      }
      if (
        existingState.migrationVersion === 1 ||
        keys.some((key) => key.startsWith(LEGACY_PREFIX))
      ) {
        await this.quarantineExistingLegacy(
          tx,
          keys,
          existingState,
          existingState.migrationVersion === 1 ? 'authority-collision' : 'stale-client-write',
        );
      }
      return;
    }

    const now = this.now().toISOString();
    const version = this.makeVersion(1);
    const entries = new Map<WorkspacePath, PersistedEntry>();

    // Preserve any authoritative v2 records left by a pre-release build.
    for (const path of entryPathsFromKeys(keys)) {
      entries.set(path, await readRequiredEntry(tx, path));
    }
    if (entries.get(WORKSPACE_ROOT)?.kind === 'file') {
      throw corrupt(
        'Pre-release v2 authority stored a file at the workspace root.',
        WORKSPACE_ROOT,
      );
    }
    entries.set(
      WORKSPACE_ROOT,
      entries.get(WORKSPACE_ROOT) ?? directoryRecord(WORKSPACE_ROOT, version, now),
    );

    const legacyDirectories = await readLegacyDirectories(tx);
    const legacyFilePaths = legacyPathsFromKeys(keys);
    for (const directory of legacyDirectories) {
      const existing = entries.get(directory);
      if (existing?.kind === 'file' || hasFileAncestor(entries, directory)) {
        await appendLegacyConflict(
          tx,
          directory,
          directoryRecoveryCandidate('authority-collision', now),
        );
        continue;
      }
      addParentDirectories(entries, directory, version, now);
      if (!existing) entries.set(directory, directoryRecord(directory, version, now));
    }

    for (const path of legacyFilePaths) {
      const legacy = await readLegacyFile(tx, path);
      const existing = entries.get(path);
      if (existing?.kind === 'file') {
        if (!legacyPayloadsMatchEntry(legacy, existing)) {
          await appendLegacyConflict(
            tx,
            path,
            fileRecoveryCandidate(legacy, 'authority-collision', now),
          );
        }
        continue;
      }
      const kindCollision = existing?.kind === 'directory' || hasFileAncestor(entries, path);
      const payloadsDisagree =
        legacy.content !== null &&
        legacy.binary !== null &&
        !bytesEqual(new TextEncoder().encode(legacy.content), legacy.binary);
      if (
        payloadsDisagree ||
        kindCollision ||
        (legacy.content === null && legacy.binary === null)
      ) {
        await appendLegacyConflict(
          tx,
          path,
          fileRecoveryCandidate(
            legacy,
            kindCollision
              ? 'kind-collision'
              : payloadsDisagree
                ? 'dual-payload'
                : 'authority-collision',
            now,
          ),
        );
        continue;
      }
      addParentDirectories(entries, path, version, now);
      const data =
        legacy.content !== null
          ? new TextEncoder().encode(legacy.content).buffer
          : copyBytes(legacy.binary!);
      entries.set(path, {
        schemaVersion: ENTRY_SCHEMA_VERSION,
        kind: 'file',
        path,
        data: copyBytes(data),
        version,
        lastModified: legacy.metadata?.lastModified ?? now,
      });
    }

    for (const entry of entries.values()) {
      await tx.put(entryKey(entry.path), entry);
    }
    await deleteLegacyNamespace(tx, keys);
    const state: PersistedState = {
      schemaVersion: STATE_SCHEMA_VERSION,
      migrationVersion: 2,
      mutationCounter: 1,
      treeVersion: version,
    };
    await tx.put(STATE_KEY, state);
  }

  private async quarantineExistingLegacy(
    tx: IndexedDBFileSystemTransaction,
    keys: readonly string[],
    state: PersistedState,
    reason: 'authority-collision' | 'stale-client-write',
  ): Promise<void> {
    const now = this.now().toISOString();
    const ignored = await readMarkerPaths(
      tx,
      keys,
      LEGACY_IGNORED_PREFIX,
      validateIgnoredLegacyPath,
    );
    const legacyDirectories = await readLegacyDirectories(tx);
    for (const path of legacyDirectories) {
      if (ignored.has(path)) continue;
      const entry = await readEntry(tx, path);
      if (entry?.kind === 'directory') continue;
      await appendLegacyConflict(
        tx,
        path,
        directoryRecoveryCandidate(entry ? 'kind-collision' : reason, now),
      );
    }

    for (const path of legacyPathsFromKeys(keys)) {
      if (ignored.has(path)) continue;
      const legacy = await readLegacyFile(tx, path);
      const entry = await readEntry(tx, path);
      if (entry?.kind === 'file' && legacyPayloadsMatchEntry(legacy, entry)) continue;
      await appendLegacyConflict(
        tx,
        path,
        fileRecoveryCandidate(legacy, entry?.kind === 'directory' ? 'kind-collision' : reason, now),
      );
    }

    await deleteLegacyNamespace(tx, keys);
    for (const key of keys) {
      if (key.startsWith(LEGACY_IGNORED_PREFIX)) await tx.delete(key);
    }
    if (state.migrationVersion === 1) {
      await tx.put(STATE_KEY, { ...state, migrationVersion: 2 } satisfies PersistedState);
    }
  }

  private async transaction<T>(
    mode: IndexedDBFileSystemTransactionMode,
    context: FsErrorContext,
    operation: (transaction: IndexedDBFileSystemTransaction) => Promise<T>,
  ): Promise<T> {
    this.assertOpen(context.operation ?? 'read');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const outcome = await this.runSharedTransaction(
          mode,
          context.operation ?? 'read',
          async (transaction) => {
            if (await transaction.hasKeyWithPrefix(LEGACY_PREFIX)) {
              if (mode === 'readonly') throw new LegacyNamespaceDetectedError();
              const state = await readRequiredState(transaction);
              await this.quarantineExistingLegacy(
                transaction,
                await transaction.keys(),
                state,
                'stale-client-write',
              );
              return { retry: true as const };
            }
            return { retry: false as const, value: await operation(transaction) };
          },
        );
        if (outcome.retry) continue;
        return outcome.value;
      } catch (error: unknown) {
        if (!(error instanceof LegacyNamespaceDetectedError)) {
          throw fsErrorFromUnknown(error, context);
        }
        try {
          await this.withMutationLock(() =>
            this.runSharedTransaction(
              'readwrite',
              context.operation ?? 'read',
              async (transaction) => {
                if (!(await transaction.hasKeyWithPrefix(LEGACY_PREFIX))) return;
                const state = await readRequiredState(transaction);
                await this.quarantineExistingLegacy(
                  transaction,
                  await transaction.keys(),
                  state,
                  'stale-client-write',
                );
              },
            ),
          );
        } catch (quarantineError: unknown) {
          throw fsErrorFromUnknown(quarantineError, context);
        }
      }
    }
    throw new FsError('busy', 'A stale IndexedDB client is continuously writing legacy records.', {
      ...context,
      retryable: true,
    });
  }

  private withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    return withFileCommitLock(`indexeddb:${this.id}:workspace`, operation);
  }

  private async nextMutationVersion(tx: IndexedDBFileSystemTransaction): Promise<MutationVersion> {
    return this.advanceState(await readRequiredState(tx));
  }

  private advanceState(state: PersistedState): MutationVersion {
    if (state.mutationCounter >= Number.MAX_SAFE_INTEGER) {
      throw corrupt('IndexedDB filesystem mutation counter overflowed.');
    }
    const mutationCounter = state.mutationCounter + 1;
    const version = this.makeVersion(mutationCounter);
    const nextState: PersistedState = {
      ...state,
      mutationCounter,
      treeVersion: version,
    };
    return { state: nextState, version, lastModified: this.now().toISOString() };
  }

  private makeVersion(counter: number): FileSystemVersion {
    return parseFileSystemVersion(`${this.versionPrefix}:${counter}`);
  }

  private async planParents(
    mutation: EntryMutation,
    path: WorkspacePath,
    createParents: boolean,
    operation: FsOperation,
  ): Promise<WorkspacePath[]> {
    const missing: WorkspacePath[] = [];
    for (const parent of parentChain(path)) {
      const entry = await mutation.get(parent);
      if (entry?.kind === 'file') {
        throw this.error(
          'type-mismatch',
          operation,
          parent,
          'A parent path is a file, not a directory.',
        );
      }
      if (!entry) {
        if (!createParents) {
          throw this.error('not-found', operation, parent, 'Parent directory does not exist.');
        }
        missing.push(parent);
      }
    }
    return missing;
  }

  private addDirectories(
    mutation: EntryMutation,
    paths: readonly WorkspacePath[],
    next: MutationVersion,
  ): void {
    for (const path of paths) {
      mutation.set(path, directoryRecord(path, next.version, next.lastModified));
    }
  }

  private async touchParents(
    mutation: EntryMutation,
    path: WorkspacePath,
    next: MutationVersion,
  ): Promise<void> {
    for (const parent of parentChain(path)) {
      const entry = await mutation.get(parent);
      if (entry?.kind === 'directory') {
        mutation.set(parent, directoryRecord(parent, next.version, next.lastModified));
      }
    }
  }

  private canonicalNonRoot(path: WorkspacePath, operation: FsOperation): WorkspacePath {
    const canonical = parseWorkspacePath(path);
    if (!canonical) {
      throw this.error(
        'invalid-path',
        operation,
        canonical,
        'The workspace root is not a file entry.',
      );
    }
    return canonical;
  }

  private assertExpectedVersion(
    entry: PersistedEntry | null,
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

  private assertOpen(operation: FsOperation): void {
    if (!this.disposed) return;
    throw new FsError('disposed', 'Filesystem provider is disposed.', { operation });
  }

  private error(
    code: FsErrorCode,
    operation: FsOperation,
    path: WorkspacePath,
    message: string,
  ): FsError {
    return new FsError(code, message, { operation, path });
  }
}

class EntryMutation {
  private readonly cache = new Map<WorkspacePath, PersistedEntry | null>();
  private readonly changed = new Map<WorkspacePath, PersistedEntry>();
  private readonly deleted = new Set<WorkspacePath>();

  public constructor(private readonly transaction: IndexedDBFileSystemTransaction) {}

  public async get(path: WorkspacePath): Promise<PersistedEntry | null> {
    if (this.deleted.has(path)) return null;
    const cached = this.cache.get(path);
    if (cached !== undefined) return cached;
    const entry = await readEntry(this.transaction, path);
    this.cache.set(path, entry);
    return entry;
  }

  public async require(path: WorkspacePath): Promise<PersistedEntry> {
    const entry = await this.get(path);
    if (!entry) throw corrupt(`Missing staged entry: ${path}.`, path);
    return entry;
  }

  public set(path: WorkspacePath, entry: PersistedEntry): void {
    const owned = copyEntry(entry);
    this.cache.set(path, owned);
    this.changed.set(path, owned);
    this.deleted.delete(path);
  }

  public delete(path: WorkspacePath): void {
    this.cache.set(path, null);
    this.changed.delete(path);
    this.deleted.add(path);
  }

  public async paths(): Promise<WorkspacePath[]> {
    const paths = new Set(await listEntryPaths(this.transaction));
    for (const path of this.deleted) paths.delete(path);
    for (const path of this.changed.keys()) paths.add(path);
    return [...paths];
  }

  public async commit(state: PersistedState): Promise<void> {
    for (const path of this.deleted) await this.transaction.delete(entryKey(path));
    for (const [path, entry] of this.changed) await this.transaction.put(entryKey(path), entry);
    await this.transaction.put(STATE_KEY, state);
  }
}

function entryKey(path: WorkspacePath): string {
  return `${ENTRY_PREFIX}${path}`;
}

function legacyConflictKey(path: WorkspacePath): string {
  return `${LEGACY_CONFLICT_PREFIX}${path}`;
}

function entryPathsFromKeys(keys: readonly string[]): WorkspacePath[] {
  return keys
    .filter((key) => key.startsWith(ENTRY_PREFIX))
    .map((key) => {
      const rawPath = key.slice(ENTRY_PREFIX.length);
      const path = parseWorkspacePath(rawPath);
      if (path !== rawPath) throw corrupt(`Non-canonical v2 entry key: ${key}.`);
      return path;
    });
}

async function listEntryPaths(tx: IndexedDBFileSystemTransaction): Promise<WorkspacePath[]> {
  return entryPathsFromKeys(await tx.keys());
}

async function readEntry(
  tx: IndexedDBFileSystemTransaction,
  path: WorkspacePath,
): Promise<PersistedEntry | null> {
  const raw = await tx.get<unknown>(entryKey(path));
  return raw === null ? null : validateEntry(raw, path);
}

async function readRequiredEntry(
  tx: IndexedDBFileSystemTransaction,
  path: WorkspacePath,
): Promise<PersistedEntry> {
  const entry = await readEntry(tx, path);
  if (!entry) throw corrupt(`Missing v2 entry record: ${path}.`, path);
  return entry;
}

function validateEntry(value: unknown, expectedPath: WorkspacePath): PersistedEntry {
  if (!isRecord(value)) throw corrupt(`Corrupt v2 entry record: ${expectedPath}.`, expectedPath);
  const path = parseWorkspacePath(readString(value.path, 'entry path'));
  if (path !== expectedPath) throw corrupt(`V2 entry path does not match key: ${expectedPath}.`);
  if (value.schemaVersion !== ENTRY_SCHEMA_VERSION) {
    throw corrupt(`Unsupported v2 entry schema at ${expectedPath}.`, expectedPath);
  }
  const version = parseFileSystemVersion(value.version);
  const lastModified = readString(value.lastModified, 'lastModified');
  if (value.kind === 'directory') {
    return { schemaVersion: ENTRY_SCHEMA_VERSION, kind: 'directory', path, version, lastModified };
  }
  if (value.kind !== 'file') throw corrupt(`Unknown entry kind at ${expectedPath}.`, expectedPath);
  return {
    schemaVersion: ENTRY_SCHEMA_VERSION,
    kind: 'file',
    path,
    version,
    lastModified,
    data: validateBytes(value.data, expectedPath),
  };
}

async function readState(tx: IndexedDBFileSystemTransaction): Promise<PersistedState | null> {
  const raw = await tx.get<unknown>(STATE_KEY);
  return raw === null ? null : validateState(raw);
}

async function readRequiredState(tx: IndexedDBFileSystemTransaction): Promise<PersistedState> {
  const state = await readState(tx);
  if (!state) throw corrupt('IndexedDB v2 state record is missing.');
  return state;
}

function validateState(value: unknown): PersistedState {
  if (
    !isRecord(value) ||
    value.schemaVersion !== STATE_SCHEMA_VERSION ||
    (value.migrationVersion !== 1 && value.migrationVersion !== 2) ||
    typeof value.mutationCounter !== 'number' ||
    !Number.isSafeInteger(value.mutationCounter) ||
    value.mutationCounter < 0
  ) {
    throw corrupt('IndexedDB v2 state record is corrupt.');
  }
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    migrationVersion: value.migrationVersion,
    mutationCounter: value.mutationCounter,
    treeVersion: parseFileSystemVersion(value.treeVersion),
  };
}

async function readLegacyDirectories(tx: IndexedDBFileSystemTransaction): Promise<WorkspacePath[]> {
  const raw = await tx.get<unknown>(LEGACY_DIRS_KEY);
  if (raw === null) return [];
  if (!Array.isArray(raw)) throw corrupt('Legacy directory index is corrupt.');
  const directories: WorkspacePath[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') throw corrupt('Legacy directory index is corrupt.');
    const path = parseWorkspacePath(value);
    if (path) directories.push(path);
  }
  return directories;
}

function legacyPathsFromKeys(keys: readonly string[]): WorkspacePath[] {
  const paths = new Set<WorkspacePath>();
  for (const key of keys) {
    if (!key.startsWith(LEGACY_PREFIX) || key === LEGACY_DIRS_KEY) continue;
    const suffix = [LEGACY_CONTENT_SUFFIX, LEGACY_BINARY_SUFFIX, LEGACY_META_SUFFIX].find(
      (candidate) => key.endsWith(candidate),
    );
    if (!suffix) continue;
    const rawPath = key.slice(LEGACY_PREFIX.length, -suffix.length);
    try {
      const path = parseWorkspacePath(rawPath);
      if (path) paths.add(path);
    } catch {
      // Invalid legacy keys remain untouched. They are not valid v2 paths.
    }
  }
  return [...paths];
}

async function readLegacyFile(
  tx: IndexedDBFileSystemTransaction,
  path: WorkspacePath,
): Promise<{ content: string | null; binary: ArrayBuffer | null; metadata: FileMeta | null }> {
  const [rawContent, rawBinary, rawMetadata] = await Promise.all([
    tx.get<unknown>(`${LEGACY_PREFIX}${path}${LEGACY_CONTENT_SUFFIX}`),
    tx.get<unknown>(`${LEGACY_PREFIX}${path}${LEGACY_BINARY_SUFFIX}`),
    tx.get<unknown>(`${LEGACY_PREFIX}${path}${LEGACY_META_SUFFIX}`),
  ]);
  if (rawContent !== null && typeof rawContent !== 'string') {
    throw corrupt(`Legacy text payload is corrupt: ${path}.`, path);
  }
  return {
    content: rawContent,
    binary: rawBinary === null ? null : validateBytes(rawBinary, path),
    metadata: validateLegacyMetadata(rawMetadata, path),
  };
}

async function readMarkerPaths(
  transaction: IndexedDBFileSystemTransaction,
  keys: readonly string[],
  prefix: string,
  validate: (value: unknown) => WorkspacePath,
): Promise<Set<WorkspacePath>> {
  const paths = new Set<WorkspacePath>();
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const expectedPath = parseWorkspacePath(key.slice(prefix.length));
    if (!expectedPath) throw corrupt(`Recovery marker cannot target the workspace root: ${key}.`);
    const value = await transaction.get<unknown>(key);
    const path = validate(value);
    if (path !== expectedPath)
      throw corrupt(`Recovery marker path does not match its key: ${key}.`);
    paths.add(path);
  }
  return paths;
}

function validateIgnoredLegacyPath(value: unknown): WorkspacePath {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.ignoredAt !== 'string') {
    throw corrupt('Ignored legacy recovery marker is corrupt.');
  }
  const path = parseWorkspacePath(readString(value.path, 'ignored legacy path'));
  if (!path) throw corrupt('Ignored legacy recovery marker cannot target the workspace root.');
  return path;
}

function bytesEqual(left: ArrayBuffer | Uint8Array, right: ArrayBuffer | Uint8Array): boolean {
  const leftBytes = ArrayBuffer.isView(left)
    ? new Uint8Array(left.buffer, left.byteOffset, left.byteLength)
    : new Uint8Array(left);
  const rightBytes = ArrayBuffer.isView(right)
    ? new Uint8Array(right.buffer, right.byteOffset, right.byteLength)
    : new Uint8Array(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  return leftBytes.every((byte, index) => byte === rightBytes[index]);
}

async function assertNoLegacyConflict(
  transaction: IndexedDBFileSystemTransaction,
  path: WorkspacePath,
  operation: FsOperation,
): Promise<void> {
  if ((await transaction.get<unknown>(legacyConflictKey(path))) === null) return;
  throw new FsError(
    'conflict',
    'Resolve the legacy migration conflict before mutating this path.',
    {
      operation,
      path,
      retryable: false,
    },
  );
}

function validateLegacyMetadata(value: unknown, path: WorkspacePath): FileMeta | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.path !== 'string' ||
    typeof value.size !== 'number' ||
    !Number.isFinite(value.size) ||
    typeof value.lastModified !== 'string'
  ) {
    throw corrupt(`Legacy metadata is corrupt: ${path}.`, path);
  }
  return {
    name: value.name,
    path: value.path,
    size: value.size,
    lastModified: value.lastModified,
  };
}

function validateLegacyConflict(value: unknown): PersistedLegacyConflict {
  if (!isRecord(value)) {
    throw corrupt('Legacy migration conflict record is corrupt.');
  }
  const path = parseWorkspacePath(readString(value.path, 'legacy conflict path'));
  if (!path) throw corrupt('Legacy migration conflict cannot target the workspace root.');

  if (value.schemaVersion === LEGACY_CONFLICT_SCHEMA_VERSION_V1) {
    const reason = validateLegacyConflictReason(value.reason);
    const candidate: PersistedLegacyRecoveryCandidate = {
      kind: 'file',
      reason,
      text: value.text === null ? null : readString(value.text, 'legacy conflict text'),
      binary: value.binary === null ? null : validateBytes(value.binary, path),
      metadata: validateLegacyMetadata(value.metadata, path),
      detectedAt: readString(value.detectedAt, 'legacy conflict detectedAt'),
    };
    return {
      schemaVersion: LEGACY_CONFLICT_SCHEMA_VERSION,
      path,
      candidates: Object.freeze([candidate]),
    };
  }
  if (value.schemaVersion !== LEGACY_CONFLICT_SCHEMA_VERSION || !Array.isArray(value.candidates)) {
    throw corrupt('Legacy migration conflict record is corrupt.');
  }
  const candidates = value.candidates.map((candidate) =>
    validateLegacyRecoveryCandidate(candidate, path),
  );
  if (candidates.length === 0) throw corrupt('Legacy migration conflict has no candidates.', path);
  return {
    schemaVersion: LEGACY_CONFLICT_SCHEMA_VERSION,
    path,
    candidates: Object.freeze(candidates),
  };
}

function toPublicLegacyConflict(
  conflict: PersistedLegacyConflict,
): IndexedDBLegacyMigrationConflict {
  const candidates = conflict.candidates.map(toPublicLegacyCandidate);
  const latest = candidates[candidates.length - 1]!;
  return Object.freeze({
    path: parseWorkspacePath(conflict.path),
    reason: latest.reason,
    kind: latest.kind,
    text: latest.text,
    binary: latest.binary,
    metadata: latest.metadata,
    detectedAt: latest.detectedAt,
    candidates: Object.freeze(candidates),
  });
}

function validateLegacyRecoveryCandidate(
  value: unknown,
  path: WorkspacePath,
): PersistedLegacyRecoveryCandidate {
  if (!isRecord(value) || (value.kind !== 'file' && value.kind !== 'directory')) {
    throw corrupt('Legacy recovery candidate is corrupt.', path);
  }
  const kind = value.kind;
  const text = value.text === null ? null : readString(value.text, 'legacy recovery text');
  const binary = value.binary === null ? null : validateBytes(value.binary, path);
  const metadata = validateLegacyMetadata(value.metadata, path);
  if (kind === 'directory' && (text !== null || binary !== null || metadata !== null)) {
    throw corrupt('A legacy directory recovery candidate contains file data.', path);
  }
  return {
    kind,
    reason: validateLegacyConflictReason(value.reason),
    text,
    binary,
    metadata,
    detectedAt: readString(value.detectedAt, 'legacy recovery detectedAt'),
  };
}

function validateLegacyConflictReason(value: unknown): IndexedDBLegacyConflictReason {
  if (
    value === 'dual-payload' ||
    value === 'kind-collision' ||
    value === 'authority-collision' ||
    value === 'stale-client-write'
  ) {
    return value;
  }
  throw corrupt('Legacy recovery reason is invalid.');
}

function toPublicLegacyCandidate(
  candidate: PersistedLegacyRecoveryCandidate,
): IndexedDBLegacyRecoveryCandidate {
  return Object.freeze({
    kind: candidate.kind,
    reason: candidate.reason,
    text: candidate.text,
    binary: candidate.binary ? copyBytes(candidate.binary) : null,
    metadata: candidate.metadata ? Object.freeze({ ...candidate.metadata }) : null,
    detectedAt: candidate.detectedAt,
  });
}

async function appendLegacyConflict(
  transaction: IndexedDBFileSystemTransaction,
  path: WorkspacePath,
  candidate: PersistedLegacyRecoveryCandidate,
): Promise<void> {
  const key = legacyConflictKey(path);
  const raw = await transaction.get<unknown>(key);
  const existing = raw === null ? null : validateLegacyConflict(raw);
  if (existing?.candidates.some((item) => recoveryCandidatesEqual(item, candidate))) return;
  const candidates = [...(existing?.candidates ?? []), copyRecoveryCandidate(candidate)];
  await transaction.put(key, {
    schemaVersion: LEGACY_CONFLICT_SCHEMA_VERSION,
    path,
    candidates,
  } satisfies PersistedLegacyConflict);
}

function fileRecoveryCandidate(
  legacy: { content: string | null; binary: ArrayBuffer | null; metadata: FileMeta | null },
  reason: IndexedDBLegacyConflictReason,
  detectedAt: string,
): PersistedLegacyRecoveryCandidate {
  return {
    kind: 'file',
    reason,
    text: legacy.content,
    binary: legacy.binary ? copyBytes(legacy.binary) : null,
    metadata: legacy.metadata ? { ...legacy.metadata } : null,
    detectedAt,
  };
}

function directoryRecoveryCandidate(
  reason: IndexedDBLegacyConflictReason,
  detectedAt: string,
): PersistedLegacyRecoveryCandidate {
  return { kind: 'directory', reason, text: null, binary: null, metadata: null, detectedAt };
}

function copyRecoveryCandidate(
  candidate: PersistedLegacyRecoveryCandidate,
): PersistedLegacyRecoveryCandidate {
  return {
    ...candidate,
    binary: candidate.binary ? copyBytes(candidate.binary) : null,
    metadata: candidate.metadata ? { ...candidate.metadata } : null,
  };
}

function recoveryCandidatesEqual(
  left: PersistedLegacyRecoveryCandidate,
  right: PersistedLegacyRecoveryCandidate,
): boolean {
  return (
    left.kind === right.kind &&
    left.text === right.text &&
    nullableBytesEqual(left.binary, right.binary) &&
    nullableMetadataEqual(left.metadata, right.metadata)
  );
}

function nullableBytesEqual(left: ArrayBuffer | null, right: ArrayBuffer | null): boolean {
  if (left === null || right === null) return left === right;
  return bytesEqual(left, right);
}

function nullableMetadataEqual(left: FileMeta | null, right: FileMeta | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.name === right.name &&
    left.path === right.path &&
    left.size === right.size &&
    left.lastModified === right.lastModified
  );
}

function legacyPayloadsMatchEntry(
  legacy: { content: string | null; binary: ArrayBuffer | null; metadata: FileMeta | null },
  entry: PersistedFileEntry,
): boolean {
  if (legacy.content === null && legacy.binary === null) return false;
  return (
    (legacy.content === null || bytesEqual(new TextEncoder().encode(legacy.content), entry.data)) &&
    (legacy.binary === null || bytesEqual(legacy.binary, entry.data))
  );
}

function hasFileAncestor(
  entries: ReadonlyMap<WorkspacePath, PersistedEntry>,
  path: WorkspacePath,
): boolean {
  return parentChain(path).some((parent) => entries.get(parent)?.kind === 'file');
}

async function deleteLegacyNamespace(
  transaction: IndexedDBFileSystemTransaction,
  keys: readonly string[],
): Promise<void> {
  for (const key of keys) {
    if (key.startsWith(LEGACY_PREFIX) && !isRecognizedLegacyKey(key)) {
      const archiveKey = `${LEGACY_OPAQUE_PREFIX}${encodeURIComponent(key)}`;
      const existing = await transaction.get<unknown>(archiveKey);
      const values =
        isRecord(existing) &&
        existing.schemaVersion === 1 &&
        existing.key === key &&
        Array.isArray(existing.values)
          ? existing.values
          : [];
      await transaction.put(archiveKey, {
        schemaVersion: 1,
        key,
        values: [...values, await transaction.get<unknown>(key)],
      });
    }
    if (key.startsWith(LEGACY_PREFIX) || key.startsWith(LEGACY_IGNORED_PREFIX))
      await transaction.delete(key);
  }
}

function isRecognizedLegacyKey(key: string): boolean {
  if (key === LEGACY_DIRS_KEY) return true;
  const suffix = [LEGACY_CONTENT_SUFFIX, LEGACY_BINARY_SUFFIX, LEGACY_META_SUFFIX].find((item) =>
    key.endsWith(item),
  );
  if (!suffix) return false;
  const rawPath = key.slice(LEGACY_PREFIX.length, -suffix.length);
  try {
    const path = parseWorkspacePath(rawPath);
    return path !== WORKSPACE_ROOT && path === rawPath;
  } catch {
    return false;
  }
}

function selectLegacyPayload(
  conflict: PersistedLegacyConflict,
  resolution: Exclude<IndexedDBLegacyConflictResolution, 'v2'>,
  path: WorkspacePath,
): { readonly kind: 'file'; readonly data: ArrayBuffer } | { readonly kind: 'directory' } {
  const payload = typeof resolution === 'string' ? resolution : resolution.payload;
  const eligible =
    typeof resolution === 'string'
      ? conflict.candidates.filter(
          (candidate) =>
            candidate.kind === 'file' &&
            (payload === 'text' ? candidate.text !== null : candidate.binary !== null),
        )
      : [conflict.candidates[resolution.candidate]].filter(
          (candidate): candidate is PersistedLegacyRecoveryCandidate => candidate !== undefined,
        );
  if (eligible.length !== 1) {
    throw new FsError(
      'conflict',
      'Choose an explicit recovery candidate because multiple legacy versions are quarantined.',
      { operation: 'write', path, retryable: false },
    );
  }
  const candidate = eligible[0]!;
  if (payload === 'directory') {
    if (candidate.kind !== 'directory') {
      throw new FsError('type-mismatch', 'The selected recovery candidate is not a directory.', {
        operation: 'write',
        path,
      });
    }
    return { kind: 'directory' };
  }
  if (candidate.kind !== 'file') {
    throw new FsError('type-mismatch', 'The selected recovery candidate is a directory.', {
      operation: 'write',
      path,
    });
  }
  const data =
    payload === 'text'
      ? candidate.text === null
        ? null
        : new TextEncoder().encode(candidate.text).buffer
      : candidate.binary;
  if (data === null) {
    throw new FsError('type-mismatch', `The selected candidate has no ${payload} payload.`, {
      operation: 'write',
      path,
    });
  }
  return { kind: 'file', data: copyBytes(data) };
}

function addParentDirectories(
  entries: Map<WorkspacePath, PersistedEntry>,
  path: WorkspacePath,
  version: FileSystemVersion,
  lastModified: string,
): void {
  for (const parent of parentChain(path)) {
    if (!entries.has(parent)) entries.set(parent, directoryRecord(parent, version, lastModified));
  }
}

function parentChain(path: WorkspacePath): WorkspacePath[] {
  const parents: WorkspacePath[] = [];
  let current = workspacePathDirname(path);
  while (true) {
    parents.unshift(current);
    if (!current) return parents;
    current = workspacePathDirname(current);
  }
}

function directoryRecord(
  path: WorkspacePath,
  version: FileSystemVersion,
  lastModified: string,
): PersistedDirectoryEntry {
  return {
    schemaVersion: ENTRY_SCHEMA_VERSION,
    kind: 'directory',
    path,
    version,
    lastModified,
  };
}

function withPathAndVersion(
  entry: PersistedEntry,
  path: WorkspacePath,
  next: MutationVersion,
): PersistedEntry {
  return entry.kind === 'file'
    ? {
        schemaVersion: ENTRY_SCHEMA_VERSION,
        kind: 'file',
        path,
        data: copyBytes(entry.data),
        version: next.version,
        lastModified: next.lastModified,
      }
    : directoryRecord(path, next.version, next.lastModified);
}

function copyEntry(entry: PersistedEntry): PersistedEntry {
  return entry.kind === 'file' ? { ...entry, data: copyBytes(entry.data) } : { ...entry };
}

function toEntrySnapshot(entry: PersistedEntry): FileSystemEntrySnapshot {
  return entry.kind === 'file' ? toFileSnapshot(entry) : toDirectorySnapshot(entry);
}

function toFileSnapshot(entry: PersistedFileEntry): FileSystemFileSnapshot {
  return Object.freeze({
    kind: 'file',
    path: parseWorkspacePath(entry.path),
    name: workspacePathBasename(parseWorkspacePath(entry.path)),
    size: entry.data.byteLength,
    version: parseFileSystemVersion(entry.version),
    lastModified: entry.lastModified,
  });
}

function toDirectorySnapshot(entry: PersistedDirectoryEntry): FileSystemDirectorySnapshot {
  const path = parseWorkspacePath(entry.path);
  return Object.freeze({
    kind: 'directory',
    path,
    name: workspacePathBasename(path),
    size: null,
    version: parseFileSystemVersion(entry.version),
    lastModified: entry.lastModified,
  });
}

function compareSnapshots(left: FileSystemEntrySnapshot, right: FileSystemEntrySnapshot): number {
  if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
  return compareText(left.name, right.name);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function copyBytes(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  const source = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy.buffer as ArrayBuffer;
}

function validateBytes(value: unknown, path: WorkspacePath): ArrayBuffer {
  if (value instanceof ArrayBuffer) return copyBytes(value);
  if (value instanceof Uint8Array) return copyBytes(value);
  throw corrupt(`Stored file bytes are corrupt: ${path}.`, path);
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw corrupt(`Invalid ${label}.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function corrupt(message: string, path?: WorkspacePath): FsError {
  return new FsError('io', message, { operation: 'read', path, retryable: false });
}
