import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  FsError,
  WORKSPACE_ROOT,
  fsErrorFromUnknown,
  parseFileSystemVersion,
  parseWorkspacePath,
  workspacePathBasename,
  workspacePathContains,
  workspacePathDirname,
  workspacePathJoin,
  type FileSystemCreateDirectoryOptions,
  type FileSystemDirectorySnapshot,
  type FileSystemEntryWatchEvent,
  type FileSystemEntrySnapshot,
  type FileSystemFileRead,
  type FileSystemFileSnapshot,
  type FileSystemMoveOptions,
  type FileSystemOverflowWatchEvent,
  type FileSystemProviderCapabilities,
  type FileSystemProviderV2,
  type FileSystemRemoveOptions,
  type FileSystemRemoveResult,
  type FileSystemSnapshot,
  type FileSystemSnapshotEntry,
  type FileSystemSnapshotFile,
  type FileSystemVersion,
  type FileSystemWatchEvent,
  type FileSystemWatchOptions,
  type FileSystemWatchSubscription,
  type FileSystemWriteOptions,
  type FsOperation,
  type WorkspacePath,
} from '@bendyline/docblocks/filesystem';
import { ELECTRON_FILE_SYSTEM_V2_CAPABILITIES, HOST_WIRE_LIMITS } from '@bendyline/docblocks/host';

import { atomicWriteBinary, withFileMutationLocks } from './file-commit.js';
import { WorkspaceRootError, getWorkspaceRoots, type WorkspaceRoots } from './workspace-roots.js';
import {
  acquireWorkspaceWatcher,
  type WorkspaceWatcherEvent,
  type WorkspaceWatcherHandle,
} from './workspace-watchers.js';

interface ScannedEntry {
  readonly root: FileSystemSnapshotEntry;
  readonly entries: FileSystemSnapshotEntry[];
}

interface ScannedFile extends ScannedEntry {
  readonly root: FileSystemSnapshotFile;
}

interface ScanBudget {
  entries: number;
  bytes: number;
}

interface NodeWatcher {
  readonly listener: (event: FileSystemWatchEvent) => void;
  readonly onError: FileSystemWatchOptions['onError'];
}

interface EchoRule {
  readonly path: WorkspacePath;
  readonly recursive: boolean;
  readonly expected: 'present' | 'absent';
}

interface EchoBatch {
  readonly rules: readonly EchoRule[];
  readonly expectedEntries: Map<WorkspacePath, FileSystemEntrySnapshot>;
  readonly invalidatedPaths: Set<WorkspacePath>;
  readonly ready: Promise<void>;
  resolveReady(): void;
  state: 'pending' | 'settled' | 'cancelled';
  expiresAt: number;
}

interface WatchSession {
  state: 'opening' | 'open' | 'closing' | 'closed';
  handle: WorkspaceWatcherHandle | null;
  ready: Promise<void>;
  closePromise: Promise<void> | null;
  removeEventListener: (() => void) | null;
  removeErrorListener: (() => void) | null;
}

/** Minimal descriptor API injected by tests without replacing global node:fs methods. */
export interface NodeWorkspaceReadableFile {
  stat(): Promise<BigIntStats>;
  readFile(): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface NodeWorkspaceFileSystemV2Options {
  readonly acquireWatcher?: (rootPath: string) => WorkspaceWatcherHandle;
  /** Injectable descriptor opener for deterministic read-consistency and I/O tests. */
  readonly openReadableFile?: (absolutePath: string) => Promise<NodeWorkspaceReadableFile>;
}

type PendingWatchEvent =
  | Omit<FileSystemEntryWatchEvent, 'sequence' | 'origin'>
  | Omit<FileSystemOverflowWatchEvent, 'sequence' | 'origin'>;

const CAPABILITIES: FileSystemProviderCapabilities = ELECTRON_FILE_SYSTEM_V2_CAPABILITIES;
const LOCAL_ECHO_WINDOW_MS = 1_000;
const MAX_STABLE_READ_ATTEMPTS = 3;

/**
 * Correctness-first Node implementation used behind Electron IPC.
 *
 * Every renderer path is parsed as a canonical WorkspacePath and then passes
 * the physical workspace-root resolver. All local mutations share the same
 * root lock as the v1 IPC handlers. Conditional versions are stable opaque
 * identities derived from high-resolution filesystem metadata; payload bytes
 * are read only for readFile/snapshot and are coupled to descriptor metadata.
 */
export class NodeWorkspaceFileSystemV2 implements FileSystemProviderV2 {
  public readonly id: string;
  public readonly label: string;
  public readonly capabilities = CAPABILITIES;

  private readonly rootPath: string;
  private readonly rootAbs: string;
  private readonly roots: WorkspaceRoots;
  private readonly watchers = new Set<NodeWatcher>();
  private readonly subscriptions = new Set<FileSystemWatchSubscription>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly knownEntries = new Map<WorkspacePath, FileSystemEntrySnapshot>();
  private readonly echoBatches: EchoBatch[] = [];
  private readonly acquireWatcher: (rootPath: string) => WorkspaceWatcherHandle;
  private readonly openReadableFile: (absolutePath: string) => Promise<NodeWorkspaceReadableFile>;
  private watchSession: WatchSession | null = null;
  private externalEventTail: Promise<void> = Promise.resolve();
  private eventSequence = 0;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  public constructor(
    id: string,
    label: string,
    rootPath: string,
    roots: WorkspaceRoots = getWorkspaceRoots(),
    options: NodeWorkspaceFileSystemV2Options = {},
  ) {
    this.id = id;
    this.label = label;
    this.rootPath = rootPath;
    this.roots = roots;
    this.acquireWatcher = options.acquireWatcher ?? acquireWorkspaceWatcher;
    this.openReadableFile = options.openReadableFile ?? openNodeReadableFile;
    try {
      this.rootAbs = roots.resolve(rootPath, '');
    } catch (error: unknown) {
      if (error instanceof WorkspaceRootError) {
        throw translateWorkspaceRootError(error, 'stat', WORKSPACE_ROOT, null);
      }
      throw error;
    }
  }

  /** Validate the registered physical root before exposing this instance. */
  public async initialize(): Promise<void> {
    await this.execute('stat', WORKSPACE_ROOT, null, async () => {
      const root = await this.roots.resolvePhysical(this.rootPath, '');
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) {
        throw new FsError('type-mismatch', 'Workspace root is not a directory.', {
          operation: 'stat',
          path: WORKSPACE_ROOT,
        });
      }
    });
  }

  public async stat(path: WorkspacePath): Promise<FileSystemEntrySnapshot | null> {
    const canonical = this.canonical(path);
    return this.execute('stat', canonical, null, async () => {
      const scanned = await this.tryScanEntry(canonical, false, 'stat');
      if (!scanned) return null;
      this.remember(scanned.entries);
      return withoutData(scanned.root);
    });
  }

  public async readFile(path: WorkspacePath): Promise<FileSystemFileRead | null> {
    const canonical = this.canonical(path);
    return this.execute('read', canonical, null, async () => {
      const scanned = await this.tryReadStableFile(canonical, 'read');
      if (!scanned) return null;
      this.remember(scanned.entries);
      return Object.freeze({
        entry: withoutData(scanned.root) as FileSystemFileSnapshot,
        data: scanned.root.data.slice(0),
      });
    });
  }

  public async readDirectory(path: WorkspacePath): Promise<readonly FileSystemEntrySnapshot[]> {
    const canonical = this.canonical(path);
    return this.execute('list', canonical, null, async () => {
      const kind = await this.nativeKind(canonical, 'list');
      if (kind === null) throw this.error('not-found', 'list', canonical, 'Directory not found.');
      if (kind !== 'directory') {
        throw this.error('type-mismatch', 'list', canonical, 'Expected a directory, found a file.');
      }

      const abs = await this.resolveRead(canonical, 'list');
      const children = await fs.readdir(abs, { withFileTypes: true });
      if (children.length > HOST_WIRE_LIMITS.arrayEntries) {
        throw this.error(
          'quota-exceeded',
          'list',
          canonical,
          'Directory exceeds the host entry limit.',
        );
      }
      const snapshots: FileSystemEntrySnapshot[] = [];
      for (const child of children) {
        const childPath = workspacePathJoin(canonical, child.name);
        const scanned = await this.scanEntry(childPath, false, new Set(), 'list');
        this.remember(scanned.entries);
        snapshots.push(withoutData(scanned.root));
      }
      snapshots.sort(compareSnapshots);
      return Object.freeze(snapshots);
    });
  }

  public async writeFile(
    path: WorkspacePath,
    data: ArrayBuffer | Uint8Array,
    options: FileSystemWriteOptions = {},
  ): Promise<FileSystemFileSnapshot> {
    const canonical = this.canonicalNonRoot(path, 'write');
    const bytes = copyBytes(data);
    return this.mutate('write', canonical, null, async () => {
      const mode = options.mode ?? 'upsert';
      if (mode !== 'upsert' && mode !== 'create' && mode !== 'replace') {
        throw this.error('invalid-path', 'write', canonical, 'Invalid write mode.');
      }

      const existing = await this.tryScanEntry(canonical, false, 'write');
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
      const echo = this.beginEchoBatch(
        [...missingParents, canonical].map((itemPath) => ({
          path: itemPath,
          recursive: false,
          expected: 'present' as const,
        })),
      );
      try {
        await this.createDirectories(missingParents);
        const abs = await this.resolveMutation(canonical, 'write');
        await atomicWriteBinary(abs, bytes);
        await this.assertMutationTarget(canonical, 'write', abs);

        const scanned = await this.scanEntry(canonical, false, new Set(), 'write');
        this.remember(scanned.entries);
        await this.emitCreatedDirectories(missingParents, 'write');
        this.settleEchoBatch(echo);
        this.emit({
          type: existing ? 'modified' : 'created',
          kind: 'file',
          path: canonical,
          destinationPath: null,
          version: scanned.root.version,
          previousVersion: existing?.root.version ?? null,
        });
        return withoutData(scanned.root) as FileSystemFileSnapshot;
      } catch (error: unknown) {
        this.cancelEchoBatch(echo);
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
      const existing = await this.tryScanEntry(canonical, false, 'create-directory');
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
      const created = [...missingParents, canonical];
      const echo = this.beginEchoBatch(
        created.map((itemPath) => ({
          path: itemPath,
          recursive: false,
          expected: 'present' as const,
        })),
      );
      try {
        await this.createDirectories(created);
        const scanned = await this.scanEntry(canonical, false, new Set(), 'create-directory');
        this.remember(scanned.entries);
        await this.emitCreatedDirectories(created, 'create-directory');
        this.settleEchoBatch(echo);
        return withoutData(scanned.root) as FileSystemDirectorySnapshot;
      } catch (error: unknown) {
        this.cancelEchoBatch(echo);
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
      const existing = await this.tryScanEntry(canonical, false, 'remove');
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
        const abs = await this.resolveRead(canonical, 'remove');
        if ((await fs.readdir(abs)).length > 0) {
          throw this.error('not-empty', 'remove', canonical, 'Directory is not empty.');
        }
      }

      const echo = this.beginEchoBatch([
        {
          path: canonical,
          recursive: existing.root.kind === 'directory',
          expected: 'absent',
        },
      ]);
      try {
        const abs = await this.resolveMutation(canonical, 'remove');
        if (existing.root.kind === 'file') {
          await fs.unlink(abs);
        } else if (options.recursive) {
          await fs.rm(abs, { recursive: true, force: false });
        } else {
          await fs.rmdir(abs);
        }
        this.forget(canonical, existing.root.kind === 'directory');
        const version = await this.currentTreeVersion('remove');
        this.settleEchoBatch(echo);
        this.emit({
          type: 'removed',
          kind: existing.root.kind,
          path: canonical,
          destinationPath: null,
          version: null,
          previousVersion: existing.root.version,
        });
        return Object.freeze({ removed: true, version });
      } catch (error: unknown) {
        this.cancelEchoBatch(echo);
        throw error;
      }
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
      const source = await this.tryScanEntry(sourcePath, false, 'move');
      if (!source) throw this.error('not-found', 'move', sourcePath, 'Source does not exist.');
      this.assertExpectedVersion(source.root, options.expectedVersion, 'move', sourcePath);
      if (sourcePath === destinationPath) return withoutData(source.root);
      if (
        source.root.kind === 'directory' &&
        workspacePathContains(sourcePath, destinationPath, false)
      ) {
        throw new FsError('invalid-path', 'Cannot move a directory into itself.', {
          operation: 'move',
          path: sourcePath,
          destinationPath,
        });
      }
      if (await this.tryScanEntry(destinationPath, false, 'move')) {
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
      const echo = this.beginEchoBatch([
        ...missingParents.map((itemPath) => ({
          path: itemPath,
          recursive: false,
          expected: 'present' as const,
        })),
        {
          path: sourcePath,
          recursive: source.root.kind === 'directory',
          expected: 'absent',
        },
        {
          path: destinationPath,
          recursive: source.root.kind === 'directory',
          expected: 'present',
        },
      ]);
      try {
        await this.createDirectories(missingParents);
        try {
          const sourceAbs = await this.resolveMutation(sourcePath, 'move');
          const destinationAbs = await this.resolveMutation(destinationPath, 'move');
          await fs.rename(sourceAbs, destinationAbs);
          await this.assertMutationTarget(destinationPath, 'move', destinationAbs);
        } catch (error: unknown) {
          await this.rollbackDirectories(missingParents);
          throw error;
        }

        this.forget(sourcePath, source.root.kind === 'directory');
        const moved = await this.scanEntry(destinationPath, false, new Set(), 'move');
        this.remember(moved.entries);
        await this.emitCreatedDirectories(missingParents, 'move');
        this.settleEchoBatch(echo);
        this.emit({
          type: 'moved',
          kind: source.root.kind,
          path: sourcePath,
          destinationPath,
          version: moved.root.version,
          previousVersion: source.root.version,
        });
        return withoutData(moved.root);
      } catch (error: unknown) {
        this.cancelEchoBatch(echo);
        throw error;
      }
    });
  }

  public async snapshot(): Promise<FileSystemSnapshot> {
    return this.mutate('snapshot', WORKSPACE_ROOT, null, async () => this.scanSnapshot());
  }

  public watch(
    listener: (event: FileSystemWatchEvent) => void,
    options: FileSystemWatchOptions = {},
  ): FileSystemWatchSubscription {
    this.assertOpen('watch');
    const watcher: NodeWatcher = { listener, onError: options.onError };
    this.watchers.add(watcher);
    let closed = false;
    let closePromise: Promise<void> | null = null;
    const ready = this.ensureWatchSession();
    const subscription: FileSystemWatchSubscription = {
      get closed() {
        return closed;
      },
      ready,
      dispose: () => {
        if (closePromise) return closePromise;
        closed = true;
        this.watchers.delete(watcher);
        this.subscriptions.delete(subscription);
        closePromise = this.watchers.size === 0 ? this.closeWatchSession() : Promise.resolve();
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
      await this.closeWatchSession();
    })();
    return this.disposePromise;
  }

  private canonical(value: WorkspacePath): WorkspacePath {
    return parseWorkspacePath(String(value));
  }

  private canonicalNonRoot(value: WorkspacePath, operation: FsOperation): WorkspacePath {
    const canonical = this.canonical(value);
    if (!canonical) {
      throw this.error('invalid-path', operation, canonical, 'Workspace root cannot be mutated.');
    }
    return canonical;
  }

  private execute<T>(
    operation: FsOperation,
    itemPath: WorkspacePath | null,
    destinationPath: WorkspacePath | null,
    work: () => Promise<T>,
  ): Promise<T> {
    this.assertOpen(operation);
    const promise = (async () => {
      try {
        return await work();
      } catch (error: unknown) {
        throw this.translateError(error, operation, itemPath, destinationPath);
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
    itemPath: WorkspacePath,
    destinationPath: WorkspacePath | null,
    work: () => Promise<T>,
  ): Promise<T> {
    return this.execute(operation, itemPath, destinationPath, () =>
      withFileMutationLocks([this.rootAbs], work),
    );
  }

  private assertOpen(operation: FsOperation): void {
    if (!this.disposed) return;
    throw new FsError('disposed', 'Filesystem provider is disposed.', { operation });
  }

  private translateError(
    error: unknown,
    operation: FsOperation,
    itemPath: WorkspacePath | null,
    destinationPath: WorkspacePath | null,
  ): FsError {
    if (error instanceof FsError) return error;
    if (error instanceof WorkspaceRootError) {
      return translateWorkspaceRootError(error, operation, itemPath, destinationPath);
    }
    return fsErrorFromUnknown(error, {
      operation,
      path: itemPath ?? undefined,
      destinationPath: destinationPath ?? undefined,
    });
  }

  private error(
    code: ConstructorParameters<typeof FsError>[0],
    operation: FsOperation,
    itemPath: WorkspacePath,
    message: string,
  ): FsError {
    return new FsError(code, message, { operation, path: itemPath });
  }

  private async resolveRead(itemPath: WorkspacePath, operation: FsOperation): Promise<string> {
    try {
      return await this.roots.resolvePhysical(this.rootPath, itemPath);
    } catch (error: unknown) {
      throw this.translateError(error, operation, itemPath, null);
    }
  }

  private async resolveMutation(itemPath: WorkspacePath, operation: FsOperation): Promise<string> {
    try {
      return await this.roots.resolveMutation(this.rootPath, itemPath);
    } catch (error: unknown) {
      throw this.translateError(error, operation, itemPath, null);
    }
  }

  private async assertMutationTarget(
    itemPath: WorkspacePath,
    operation: FsOperation,
    expectedAbsolutePath: string,
  ): Promise<void> {
    const current = await this.resolveMutation(itemPath, operation);
    const normalize = (value: string): string => {
      const resolved = path.resolve(value);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    if (normalize(current) !== normalize(expectedAbsolutePath)) {
      throw this.error(
        'conflict',
        operation,
        itemPath,
        'Mutation target changed physical identity during the operation.',
      );
    }
  }

  private async nativeKind(
    itemPath: WorkspacePath,
    operation: FsOperation,
  ): Promise<'file' | 'directory' | null> {
    const abs = await this.resolveRead(itemPath, operation);
    try {
      const stat = await fs.stat(abs);
      if (stat.isFile()) return 'file';
      if (stat.isDirectory()) return 'directory';
      throw this.error('not-supported', operation, itemPath, 'Unsupported filesystem entry type.');
    } catch (error: unknown) {
      const translated = this.translateError(error, operation, itemPath, null);
      if (translated.code === 'not-found') return null;
      throw translated;
    }
  }

  private async tryScanEntry(
    itemPath: WorkspacePath,
    includeData: boolean,
    operation: FsOperation,
  ): Promise<ScannedEntry | null> {
    try {
      return await this.scanEntry(itemPath, includeData, new Set(), operation);
    } catch (error: unknown) {
      const translated = this.translateError(error, operation, itemPath, null);
      if (translated.code === 'not-found') return null;
      throw translated;
    }
  }

  private async tryReadStableFile(
    itemPath: WorkspacePath,
    operation: FsOperation,
  ): Promise<ScannedFile | null> {
    try {
      const kind = await this.nativeKind(itemPath, operation);
      if (kind === null) return null;
      if (kind !== 'file') {
        throw this.error(
          'type-mismatch',
          operation,
          itemPath,
          'Expected a file, found a directory.',
        );
      }
      return await this.readStableFile(itemPath, operation);
    } catch (error: unknown) {
      const translated = this.translateError(error, operation, itemPath, null);
      if (translated.code === 'not-found') return null;
      throw translated;
    }
  }

  /**
   * Couple returned bytes to one stable descriptor observation. A pathname can
   * be atomically replaced while its old descriptor is still readable, so the
   * post-read pathname stat must also match before the result is published.
   */
  private async readStableFile(
    itemPath: WorkspacePath,
    operation: FsOperation,
    budget?: ScanBudget,
  ): Promise<ScannedFile> {
    for (let attempt = 1; attempt <= MAX_STABLE_READ_ATTEMPTS; attempt += 1) {
      const abs = await this.resolveRead(itemPath, operation);
      const handle = await this.openReadableFile(abs);
      let stable: ScannedFile | null = null;
      try {
        const before = await handle.stat();
        if (!before.isFile()) {
          throw this.error(
            'type-mismatch',
            operation,
            itemPath,
            'Expected a file, found a directory.',
          );
        }
        if (before.size > BigInt(HOST_WIRE_LIMITS.binaryBytes)) {
          throw this.error(
            'quota-exceeded',
            operation,
            itemPath,
            'File exceeds the host message size limit.',
          );
        }
        if (budget && budget.bytes + Number(before.size) > HOST_WIRE_LIMITS.binaryBytes) {
          throw this.error(
            'quota-exceeded',
            operation,
            itemPath,
            'Filesystem snapshot exceeds the host message size limit.',
          );
        }
        const data = copyBytes(await handle.readFile());
        const after = await handle.stat();
        const validatedAfter = await this.resolveRead(itemPath, operation);
        const pathAfter = await fs.stat(validatedAfter, { bigint: true });
        if (
          sameFileMetadata(before, after) &&
          sameFileMetadata(after, pathAfter) &&
          after.size === BigInt(data.byteLength)
        ) {
          stable = scannedFile(itemPath, after, data, operation);
          if (budget) budget.bytes += data.byteLength;
        }
      } finally {
        await handle.close();
      }
      if (stable) return stable;
    }
    throw this.error('busy', operation, itemPath, 'File kept changing while it was being read.');
  }

  private async scanEntry(
    itemPath: WorkspacePath,
    includeData: boolean,
    ancestors: ReadonlySet<string>,
    operation: FsOperation,
    budget: ScanBudget = { entries: 0, bytes: 0 },
  ): Promise<ScannedEntry> {
    budget.entries += 1;
    if (budget.entries > HOST_WIRE_LIMITS.arrayEntries) {
      throw this.error(
        'quota-exceeded',
        operation,
        itemPath,
        'Filesystem traversal exceeds the entry limit.',
      );
    }
    const abs = await this.resolveRead(itemPath, operation);
    const stat = await fs.stat(abs, { bigint: true });
    if (stat.isFile()) {
      return includeData
        ? this.readStableFile(itemPath, operation, budget)
        : scannedFile(itemPath, stat, null, operation);
    }
    if (!stat.isDirectory()) {
      throw this.error('not-supported', operation, itemPath, 'Unsupported filesystem entry type.');
    }

    const real = await fs.realpath(abs);
    if (ancestors.has(real)) {
      throw this.error('invalid-path', operation, itemPath, 'Symbolic-link cycle detected.');
    }
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(real);
    const children = (await fs.readdir(abs, { withFileTypes: true })).sort((left, right) =>
      compareText(left.name, right.name),
    );
    const childScans: ScannedEntry[] = [];
    for (const child of children) {
      childScans.push(
        await this.scanEntry(
          workspacePathJoin(itemPath, child.name),
          includeData,
          nextAncestors,
          operation,
          budget,
        ),
      );
    }
    const version = versionForDirectory(
      itemPath,
      stat,
      childScans.map((child) => child.root),
    );
    const root: FileSystemDirectorySnapshot = Object.freeze({
      kind: 'directory',
      path: itemPath,
      name: workspacePathBasename(itemPath),
      size: null,
      version,
      lastModified: stat.mtime.toISOString(),
    });
    return {
      root,
      entries: [root, ...childScans.flatMap((child) => child.entries)],
    };
  }

  private async scanSnapshot(): Promise<FileSystemSnapshot> {
    const scanned = await this.scanEntry(WORKSPACE_ROOT, true, new Set(), 'snapshot');
    const entries = scanned.entries
      .map((entry) =>
        entry.kind === 'file' ? Object.freeze({ ...entry, data: entry.data.slice(0) }) : entry,
      )
      .sort((left, right) => compareText(left.path, right.path));
    this.knownEntries.clear();
    this.remember(entries);
    return Object.freeze({
      version: scanned.root.version,
      entries: Object.freeze(entries),
    });
  }

  private async currentTreeVersion(operation: FsOperation): Promise<FileSystemVersion> {
    return (await this.scanEntry(WORKSPACE_ROOT, false, new Set(), operation)).root.version;
  }

  private async planParents(
    itemPath: WorkspacePath,
    createParents: boolean,
    operation: FsOperation,
  ): Promise<WorkspacePath[]> {
    const missing: WorkspacePath[] = [];
    for (const parent of parentChain(itemPath)) {
      if (!parent) continue;
      const kind = await this.nativeKind(parent, operation);
      if (kind === 'file') {
        throw this.error('type-mismatch', operation, parent, 'A parent path is a file.');
      }
      if (kind === null) {
        if (!createParents) {
          throw this.error('not-found', operation, parent, 'Parent directory does not exist.');
        }
        missing.push(parent);
      }
    }
    return missing;
  }

  private async createDirectories(paths: readonly WorkspacePath[]): Promise<void> {
    for (const directoryPath of paths) {
      const abs = await this.resolveMutation(directoryPath, 'create-directory');
      await fs.mkdir(abs);
    }
  }

  private async rollbackDirectories(paths: readonly WorkspacePath[]): Promise<void> {
    for (const directoryPath of [...paths].reverse()) {
      try {
        const abs = await this.resolveMutation(directoryPath, 'move');
        await fs.rmdir(abs);
      } catch {
        // Best effort: never replace the primary move error.
      }
    }
  }

  private assertExpectedVersion(
    entry: FileSystemSnapshotEntry | undefined,
    expected: FileSystemVersion | null | undefined,
    operation: FsOperation,
    itemPath: WorkspacePath,
  ): void {
    if (expected === undefined) return;
    if (expected !== null) parseFileSystemVersion(expected);
    if (expected === null ? !entry : entry?.version === expected) return;
    throw this.error('conflict', operation, itemPath, 'Entry version does not match.');
  }

  private async emitCreatedDirectories(
    paths: readonly WorkspacePath[],
    operation: FsOperation,
  ): Promise<void> {
    for (const directoryPath of paths) {
      const scanned = await this.scanEntry(directoryPath, false, new Set(), operation);
      this.remember(scanned.entries);
      this.emit({
        type: 'created',
        kind: 'directory',
        path: directoryPath,
        destinationPath: null,
        version: scanned.root.version,
        previousVersion: null,
      });
    }
  }

  private emit(event: PendingWatchEvent): void {
    const complete: FileSystemWatchEvent = Object.freeze({
      ...event,
      sequence: ++this.eventSequence,
      origin: 'local',
    });
    for (const watcher of [...this.watchers]) {
      try {
        watcher.listener(complete);
      } catch {
        // Observers cannot roll back a completed filesystem operation.
      }
    }
  }

  private emitExternal(event: PendingWatchEvent): void {
    const complete: FileSystemWatchEvent = Object.freeze({
      ...event,
      sequence: ++this.eventSequence,
      origin: 'external',
    });
    for (const watcher of [...this.watchers]) {
      try {
        watcher.listener(complete);
      } catch {
        // Isolate observers.
      }
    }
  }

  private notifyWatchError(error: unknown): void {
    const typed = this.translateError(error, 'watch', null, null);
    for (const watcher of [...this.watchers]) {
      try {
        watcher.onError?.(typed);
      } catch {
        // Isolate observers.
      }
    }
  }

  private ensureWatchSession(): Promise<void> {
    const current = this.watchSession;
    if (current) {
      if (current.state === 'opening' || current.state === 'open') return current.ready;
      if (current.state === 'closing') {
        return current.closePromise!.then(() => {
          if (this.disposed || this.watchers.size === 0) return;
          return this.ensureWatchSession();
        });
      }
    }

    const session: WatchSession = {
      state: 'opening',
      handle: null,
      ready: Promise.resolve(),
      closePromise: null,
      removeEventListener: null,
      removeErrorListener: null,
    };
    this.watchSession = session;
    session.ready = this.openWatchSession(session);
    return session.ready;
  }

  private async openWatchSession(session: WatchSession): Promise<void> {
    try {
      const before = await this.scanEntry(WORKSPACE_ROOT, false, new Set(), 'watch');
      if (isClosingWatchSession(session)) return;
      const physicalRoot = await fs.realpath(await this.roots.resolvePhysical(this.rootPath, ''));
      if (isClosingWatchSession(session)) return;
      const handle = this.acquireWatcher(physicalRoot);
      session.handle = handle;
      if (!isClosingWatchSession(session)) {
        session.removeEventListener = handle.onEvent((event) =>
          this.enqueueExternalEvent(session, event),
        );
        session.removeErrorListener = handle.onError((error) => {
          if (this.watchSession === session && !isClosingWatchSession(session)) {
            this.notifyWatchError(error);
          }
        });
      }
      await handle.ready;
      if (isClosingWatchSession(session)) return;
      const after = await this.scanEntry(WORKSPACE_ROOT, false, new Set(), 'watch');
      if (isClosingWatchSession(session)) return;
      if (before.root.version !== after.root.version) {
        this.emitExternal({
          type: 'overflow',
          kind: null,
          path: WORKSPACE_ROOT,
          destinationPath: null,
          version: null,
          previousVersion: null,
        });
      }
      session.state = 'open';
    } catch (error: unknown) {
      const typed = this.translateError(error, 'watch', null, null);
      if (!isClosingWatchSession(session)) this.notifyWatchError(typed);
      throw typed;
    }
  }

  private closeWatchSession(): Promise<void> {
    const session = this.watchSession;
    if (!session || session.state === 'closed') return Promise.resolve();
    if (session.closePromise) return session.closePromise;

    session.state = 'closing';
    session.removeEventListener?.();
    session.removeErrorListener?.();
    session.removeEventListener = null;
    session.removeErrorListener = null;
    session.closePromise = (async () => {
      try {
        await session.ready.catch(() => undefined);
        session.removeEventListener?.();
        session.removeErrorListener?.();
        await this.externalEventTail;
        await session.handle?.dispose();
      } finally {
        session.state = 'closed';
        if (this.watchSession === session) this.watchSession = null;
        this.echoBatches.splice(0);
      }
    })();
    return session.closePromise;
  }

  private async handleExternalEvent(
    session: WatchSession,
    event: WorkspaceWatcherEvent,
  ): Promise<void> {
    try {
      if (this.watchSession !== session || isClosingWatchSession(session)) return;
      const itemPath = parseWorkspacePath(event.path);
      if (await this.shouldSuppressEcho(itemPath)) return;
      if (this.watchSession !== session || isClosingWatchSession(session)) return;

      if (event.type === 'removed') {
        const current = await this.tryScanEntry(itemPath, false, 'watch');
        if (current) {
          this.remember(current.entries);
          this.emitExternal({
            type: 'overflow',
            kind: null,
            path: WORKSPACE_ROOT,
            destinationPath: null,
            version: null,
            previousVersion: null,
          });
          return;
        }
        const previous = this.knownEntries.get(itemPath);
        this.forget(itemPath, event.kind === 'directory');
        this.emitExternal({
          type: 'removed',
          kind: previous?.kind ?? event.kind,
          path: itemPath,
          destinationPath: null,
          version: null,
          previousVersion: previous?.version ?? null,
        });
        return;
      }

      const scanned = await this.tryScanEntry(itemPath, false, 'watch');
      if (!scanned) {
        this.emitExternal({
          type: 'overflow',
          kind: null,
          path: WORKSPACE_ROOT,
          destinationPath: null,
          version: null,
          previousVersion: null,
        });
        return;
      }
      const previous = this.knownEntries.get(itemPath);
      this.remember(scanned.entries);
      this.emitExternal({
        type: event.type,
        kind: scanned.root.kind,
        path: itemPath,
        destinationPath: null,
        version: scanned.root.version,
        previousVersion: previous?.version ?? null,
      });
    } catch (error: unknown) {
      this.notifyWatchError(error);
    }
  }

  private enqueueExternalEvent(session: WatchSession, event: WorkspaceWatcherEvent): Promise<void> {
    const run = this.externalEventTail.then(
      () => this.handleExternalEvent(session, event),
      () => this.handleExternalEvent(session, event),
    );
    this.externalEventTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private beginEchoBatch(rules: readonly EchoRule[]): EchoBatch | null {
    const session = this.watchSession;
    if (!session || session.state === 'closing' || session.state === 'closed') return null;
    this.pruneEchoBatches();
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const batch: EchoBatch = {
      rules,
      expectedEntries: new Map(),
      invalidatedPaths: new Set(),
      ready,
      resolveReady,
      state: 'pending',
      expiresAt: Number.POSITIVE_INFINITY,
    };
    this.echoBatches.push(batch);
    return batch;
  }

  private settleEchoBatch(batch: EchoBatch | null): void {
    if (!batch || batch.state !== 'pending') return;
    for (const rule of batch.rules) {
      if (rule.expected !== 'present') continue;
      for (const [itemPath, entry] of this.knownEntries) {
        if (
          itemPath === rule.path ||
          (rule.recursive && workspacePathContains(rule.path, itemPath, false))
        ) {
          batch.expectedEntries.set(itemPath, entry);
        }
      }
    }
    batch.state = 'settled';
    batch.expiresAt = Date.now() + LOCAL_ECHO_WINDOW_MS;
    batch.resolveReady();
  }

  private cancelEchoBatch(batch: EchoBatch | null): void {
    if (!batch || batch.state !== 'pending') return;
    batch.state = 'cancelled';
    batch.resolveReady();
    const index = this.echoBatches.indexOf(batch);
    if (index >= 0) this.echoBatches.splice(index, 1);
  }

  private async shouldSuppressEcho(itemPath: WorkspacePath): Promise<boolean> {
    this.pruneEchoBatches();
    for (let batchIndex = this.echoBatches.length - 1; batchIndex >= 0; batchIndex -= 1) {
      const batch = this.echoBatches[batchIndex];
      const rule = [...batch.rules]
        .reverse()
        .find(
          (candidate) =>
            candidate.path === itemPath ||
            (candidate.recursive && workspacePathContains(candidate.path, itemPath, false)),
        );
      if (!rule || batch.invalidatedPaths.has(itemPath)) continue;
      await batch.ready;
      if (batch.state !== 'settled' || batch.expiresAt < Date.now()) continue;

      const current = await this.tryScanEntry(itemPath, false, 'watch');
      const expected = batch.expectedEntries.get(itemPath);
      const matches =
        rule.expected === 'absent'
          ? current === null
          : current !== null &&
            expected !== undefined &&
            sameEntryState(withoutData(current.root), expected);
      if (matches) return true;
      batch.invalidatedPaths.add(itemPath);
      return false;
    }
    return false;
  }

  private pruneEchoBatches(): void {
    const now = Date.now();
    for (let index = this.echoBatches.length - 1; index >= 0; index -= 1) {
      const batch = this.echoBatches[index];
      if (batch.state === 'cancelled' || batch.expiresAt < now) {
        this.echoBatches.splice(index, 1);
      }
    }
  }

  private remember(entries: readonly FileSystemSnapshotEntry[]): void {
    for (const entry of entries) this.knownEntries.set(entry.path, withoutData(entry));
  }

  private forget(itemPath: WorkspacePath, recursive: boolean): void {
    this.knownEntries.delete(itemPath);
    if (!recursive) return;
    for (const candidate of [...this.knownEntries.keys()]) {
      if (workspacePathContains(itemPath, candidate, false)) this.knownEntries.delete(candidate);
    }
  }
}

function parentChain(itemPath: WorkspacePath): WorkspacePath[] {
  const parents: WorkspacePath[] = [];
  let current = workspacePathDirname(itemPath);
  while (true) {
    parents.unshift(current);
    if (!current) return parents;
    current = workspacePathDirname(current);
  }
}

function versionForFile(itemPath: WorkspacePath, stat: BigIntStats): FileSystemVersion {
  const hash = createHash('sha256');
  hash.update('file-metadata-v1\0');
  hash.update(itemPath);
  hash.update('\0');
  hash.update(stableMetadataIdentity(stat));
  return parseFileSystemVersion(`sha256:${hash.digest('hex')}`);
}

function versionForDirectory(
  itemPath: WorkspacePath,
  stat: BigIntStats,
  children: readonly FileSystemSnapshotEntry[],
): FileSystemVersion {
  const hash = createHash('sha256');
  hash.update('directory-metadata-v1\0');
  hash.update(itemPath);
  hash.update('\0');
  hash.update(stableMetadataIdentity(stat));
  for (const child of children) {
    hash.update('\0');
    hash.update(child.kind);
    hash.update('\0');
    hash.update(child.path);
    hash.update('\0');
    hash.update(child.version);
  }
  return parseFileSystemVersion(`sha256:${hash.digest('hex')}`);
}

function scannedFile(
  itemPath: WorkspacePath,
  stat: BigIntStats,
  data: ArrayBuffer | null,
  operation: FsOperation,
): ScannedFile {
  const size = Number(stat.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new FsError('not-supported', 'File size exceeds the safe provider range.', {
      operation,
      path: itemPath,
    });
  }
  const base: FileSystemFileSnapshot = Object.freeze({
    kind: 'file',
    path: itemPath,
    name: workspacePathBasename(itemPath),
    size,
    version: versionForFile(itemPath, stat),
    lastModified: stat.mtime.toISOString(),
  });
  const root: FileSystemSnapshotFile = Object.freeze({
    ...base,
    data: data?.slice(0) ?? new ArrayBuffer(0),
  });
  return { root, entries: [root] };
}

/** Metadata fields that identify the observed file state without reading bytes. */
function stableMetadataIdentity(stat: BigIntStats): string {
  return [
    `dev:${stat.dev}`,
    `ino:${stat.ino}`,
    `size:${stat.size}`,
    `mtime-ns:${stat.mtimeNs}`,
    `ctime-ns:${stat.ctimeNs}`,
  ].join('\0');
}

function sameFileMetadata(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function openNodeReadableFile(absolutePath: string): Promise<NodeWorkspaceReadableFile> {
  const handle = await fs.open(absolutePath, 'r');
  return {
    stat: () => handle.stat({ bigint: true }),
    readFile: () => handle.readFile(),
    close: () => handle.close(),
  };
}

function withoutData(entry: FileSystemSnapshotEntry): FileSystemEntrySnapshot {
  if (entry.kind === 'directory') return entry;
  const { data: _data, ...snapshot } = entry;
  return Object.freeze(snapshot);
}

function copyBytes(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  const source = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy.buffer as ArrayBuffer;
}

function compareSnapshots(left: FileSystemEntrySnapshot, right: FileSystemEntrySnapshot): number {
  if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
  return compareText(left.name, right.name);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameEntryState(
  current: FileSystemEntrySnapshot,
  expected: FileSystemEntrySnapshot,
): boolean {
  return (
    current.kind === expected.kind &&
    current.version === expected.version &&
    current.lastModified === expected.lastModified &&
    current.size === expected.size
  );
}

function isClosingWatchSession(session: WatchSession): boolean {
  return session.state === 'closing' || session.state === 'closed';
}

function translateWorkspaceRootError(
  error: WorkspaceRootError,
  operation: FsOperation,
  itemPath: WorkspacePath | null,
  destinationPath: WorkspacePath | null,
): FsError {
  const code =
    error.code === 'path-escape'
      ? 'path-escape'
      : error.code === 'root-mutation'
        ? 'invalid-path'
        : 'permission-denied';
  return new FsError(code, error.message, {
    operation,
    path: itemPath ?? undefined,
    destinationPath: destinationPath ?? undefined,
  });
}
