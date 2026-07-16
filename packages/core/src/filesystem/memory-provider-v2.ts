import { FsError, type FsOperation } from './fs-error.js';
import type { FileCommitResult } from './types.js';
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
  type FileSystemWatchEvent,
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
import { copyBytes } from './internal/bytes.js';
import { compareSnapshotsByName, compareText } from './internal/entry-order.js';
import { parentChainWithRoot } from './internal/parent-chain.js';
import { decodeUtf8Text } from './utf8.js';

interface MemoryEntryBase {
  readonly version: FileSystemVersion;
  readonly lastModified: string;
}

interface MemoryFileEntry extends MemoryEntryBase {
  readonly kind: 'file';
  readonly data: ArrayBuffer;
  /** Compatibility metadata only; v2 always treats the payload as bytes. */
  readonly payloadKind: MemoryFilePayloadKind;
}

interface MemoryDirectoryEntry extends MemoryEntryBase {
  readonly kind: 'directory';
}

type MemoryEntry = MemoryFileEntry | MemoryDirectoryEntry;

export type MemoryFilePayloadKind = 'text' | 'binary';

export interface MemoryFileSystemV2StateFile {
  readonly path: WorkspacePath;
  readonly data: ArrayBuffer;
  readonly payloadKind: MemoryFilePayloadKind;
}

export interface MemoryFileSystemV2CompatibilityFile {
  readonly data: ArrayBuffer;
  readonly payloadKind: MemoryFilePayloadKind;
}

export interface MemoryFileSystemV2State {
  readonly revision: number;
  readonly files: readonly MemoryFileSystemV2StateFile[];
  readonly directories: readonly WorkspacePath[];
}

export interface MemoryFileSystemV2ReplacementFile {
  readonly path: WorkspacePath;
  readonly data: ArrayBuffer | Uint8Array;
  readonly payloadKind: MemoryFilePayloadKind;
}

export interface MemoryFileSystemV2Replacement {
  readonly files: readonly MemoryFileSystemV2ReplacementFile[];
  readonly directories?: readonly WorkspacePath[];
}

interface MemoryWatcher {
  readonly listener: FileSystemWatchListener;
  readonly onError: FileSystemWatchOptions['onError'];
}

type MemoryWatchEventInput = FileSystemWatchEvent extends infer Event
  ? Event extends FileSystemWatchEvent
    ? Omit<Event, 'sequence' | 'origin'>
    : never
  : never;

const MEMORY_CAPABILITIES: FileSystemProviderCapabilities = Object.freeze({
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

/**
 * Correctness reference for FileSystemProviderV2.
 *
 * Every mutation validates first, stages a fresh map, swaps it once, and only
 * then emits notifications. File buffers are owned by the provider and every
 * read/snapshot returns a defensive copy.
 */
export class MemoryFileSystemProviderV2 implements FileSystemProviderV2 {
  public readonly id: string;
  public readonly label: string;
  public readonly capabilities = MEMORY_CAPABILITIES;

  private entries: Map<WorkspacePath, MemoryEntry>;
  private readonly watchers = new Set<MemoryWatcher>();
  private readonly subscriptions = new Set<FileSystemWatchSubscription>();
  private readonly pendingEvents: FileSystemWatchEvent[] = [];
  private emittingEvents = false;
  private mutationCounter = 0;
  private eventSequence = 0;
  private treeVersion: FileSystemVersion;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  public constructor(id: string, label: string) {
    this.id = id;
    this.label = label;
    this.treeVersion = parseFileSystemVersion(`${id}:0`);
    const now = new Date().toISOString();
    this.entries = new Map([
      [WORKSPACE_ROOT, { kind: 'directory', version: this.treeVersion, lastModified: now }],
    ]);
  }

  /** Monotonic in-process revision used by synchronous transient-workspace staging. */
  public get mutationRevision(): number {
    return this.mutationCounter;
  }

  /** @internal Atomically couple owned bytes to their v1 compatibility kind. */
  public readCompatibilityFile(path: WorkspacePath): MemoryFileSystemV2CompatibilityFile | null {
    this.assertOpen('read');
    const canonical = this.canonical(path);
    const entry = this.entries.get(canonical);
    if (!entry) return null;
    if (entry.kind !== 'file') {
      throw this.error(
        'type-mismatch',
        'read',
        canonical,
        'Expected a file but found a directory.',
      );
    }
    return Object.freeze({ data: entry.data.slice(0), payloadKind: entry.payloadKind });
  }

  /** @internal Capture an owned synchronous copy for DBK whole-tree staging. */
  public captureState(): MemoryFileSystemV2State {
    this.assertOpen('snapshot');
    const files: MemoryFileSystemV2StateFile[] = [];
    const directories: WorkspacePath[] = [];
    for (const [path, entry] of [...this.entries].sort(([left], [right]) =>
      compareText(left, right),
    )) {
      if (!path) continue;
      if (entry.kind === 'directory') directories.push(path);
      else {
        files.push(
          Object.freeze({ path, data: entry.data.slice(0), payloadKind: entry.payloadKind }),
        );
      }
    }
    return Object.freeze({
      revision: this.mutationCounter,
      files: Object.freeze(files),
      directories: Object.freeze(directories),
    });
  }

  /** @internal Atomically replace a transient workspace after complete validation. */
  public replaceState(replacement: MemoryFileSystemV2Replacement, expectedRevision?: number): void {
    this.assertOpen('write');
    const stagedFiles = new Map<
      WorkspacePath,
      { readonly data: ArrayBuffer; readonly payloadKind: MemoryFilePayloadKind }
    >();
    const stagedDirectories = new Set<WorkspacePath>();
    const explicitDirectories = new Set<WorkspacePath>();

    for (const rawDirectory of replacement.directories ?? []) {
      const directory = this.canonicalNonRoot(rawDirectory, 'create-directory');
      if (explicitDirectories.has(directory)) {
        throw this.error(
          'already-exists',
          'create-directory',
          directory,
          'Duplicate replacement directory.',
        );
      }
      explicitDirectories.add(directory);
      stagedDirectories.add(directory);
      addParentPaths(stagedDirectories, directory);
    }
    for (const rawFile of replacement.files) {
      const path = this.canonicalNonRoot(rawFile.path, 'write');
      if (stagedFiles.has(path)) {
        throw this.error('already-exists', 'write', path, 'Duplicate replacement file.');
      }
      if (!isMemoryFilePayloadKind(rawFile.payloadKind)) {
        throw this.error('type-mismatch', 'write', path, 'Invalid replacement payload kind.');
      }
      stagedFiles.set(path, {
        data: copyBytes(rawFile.data),
        payloadKind: rawFile.payloadKind,
      });
      addParentPaths(stagedDirectories, path);
    }
    for (const path of stagedFiles.keys()) {
      if (stagedDirectories.has(path)) {
        throw this.error(
          'type-mismatch',
          'write',
          path,
          'Replacement path has conflicting file and directory kinds.',
        );
      }
      for (const parent of parentChainWithRoot(path)) {
        if (parent && stagedFiles.has(parent)) {
          throw this.error('type-mismatch', 'write', parent, 'A replacement parent is a file.');
        }
      }
    }
    if (expectedRevision !== undefined && expectedRevision !== this.mutationCounter) {
      throw this.error(
        'conflict',
        'write',
        WORKSPACE_ROOT,
        'Memory filesystem changed while replacement contents were staged.',
      );
    }

    const version = this.nextVersion();
    const now = new Date().toISOString();
    const next = new Map<WorkspacePath, MemoryEntry>([
      [WORKSPACE_ROOT, { kind: 'directory', version, lastModified: now }],
    ]);
    this.addDirectories(next, [...stagedDirectories], version, now);
    for (const [path, file] of stagedFiles) {
      next.set(path, {
        kind: 'file',
        data: file.data,
        payloadKind: file.payloadKind,
        version,
        lastModified: now,
      });
    }
    this.entries = next;
    this.emit({
      type: 'overflow',
      kind: null,
      path: WORKSPACE_ROOT,
      destinationPath: null,
      version: null,
      previousVersion: null,
    });
  }

  /** @internal Synchronous setup hook used before a transient provider is published. */
  public seedText(path: WorkspacePath, content: string): void {
    this.writeFileNow(path, new TextEncoder().encode(content), { createParents: true }, 'text');
  }

  /** @internal Legacy text write that preserves text/binary compatibility metadata. */
  public async writeText(
    path: WorkspacePath,
    content: string,
    options: FileSystemWriteOptions = {},
  ): Promise<FileSystemFileSnapshot> {
    return this.writeFileNow(path, new TextEncoder().encode(content), options, 'text');
  }

  /** @internal Legacy binary write that explicitly changes compatibility payload kind. */
  public async writeBinary(
    path: WorkspacePath,
    data: ArrayBuffer | Uint8Array,
    options: FileSystemWriteOptions = {},
  ): Promise<FileSystemFileSnapshot> {
    return this.writeFileNow(path, data, options, 'binary');
  }

  /** @internal Atomic legacy compare-and-write over the authoritative v2 entry. */
  public async commitText(
    path: WorkspacePath,
    content: string,
    expectedContent: string | null,
  ): Promise<FileCommitResult> {
    this.assertOpen('write');
    const canonical = this.canonicalNonRoot(path, 'write');
    const existing = this.entries.get(canonical);
    if (existing?.kind === 'directory') {
      throw this.error('type-mismatch', 'write', canonical, 'Cannot replace a directory.');
    }
    // Every file is bytes, so the baseline is decided by the bytes, not by the
    // compatibility kind. Gating on `payloadKind === 'binary'` reported
    // `conflict` with a null `content`, which callers read as "deleted
    // externally" — a phantom deletion for a file that is plainly still there.
    // Undecodable bytes are a real fault and are raised as one, matching the
    // IndexedDB facade and the v2 commit target.
    const currentContent =
      existing?.kind === 'file'
        ? decodeUtf8Text(existing.data, {
            label: 'The stored file',
            operation: 'write',
            path: canonical,
          })
        : null;
    if (currentContent !== expectedContent && currentContent !== content) {
      return {
        status: 'conflict',
        content: currentContent,
        version: existing?.version ?? null,
      };
    }
    const written = this.writeFileNow(
      canonical,
      new TextEncoder().encode(content),
      { createParents: true, expectedVersion: existing?.version ?? null },
      'text',
    );
    return { status: 'committed', version: written.version };
  }

  public async stat(path: WorkspacePath): Promise<FileSystemEntrySnapshot | null> {
    this.assertOpen('stat');
    const canonical = this.canonical(path);
    const entry = this.entries.get(canonical);
    return entry ? this.toEntrySnapshot(canonical, entry) : null;
  }

  public async readFile(path: WorkspacePath): Promise<FileSystemFileRead | null> {
    this.assertOpen('read');
    const canonical = this.canonical(path);
    const entry = this.entries.get(canonical);
    if (!entry) return null;
    if (entry.kind !== 'file') {
      throw this.error(
        'type-mismatch',
        'read',
        canonical,
        'Expected a file but found a directory.',
      );
    }
    return Object.freeze({
      entry: this.toFileSnapshot(canonical, entry),
      data: entry.data.slice(0),
    });
  }

  public async readDirectory(path: WorkspacePath): Promise<readonly FileSystemEntrySnapshot[]> {
    this.assertOpen('list');
    const canonical = this.canonical(path);
    const directory = this.entries.get(canonical);
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

    const children: FileSystemEntrySnapshot[] = [];
    for (const [entryPath, entry] of this.entries) {
      if (entryPath && workspacePathDirname(entryPath) === canonical) {
        children.push(this.toEntrySnapshot(entryPath, entry));
      }
    }
    children.sort(compareSnapshotsByName);
    return Object.freeze(children);
  }

  public async writeFile(
    path: WorkspacePath,
    data: ArrayBuffer | Uint8Array,
    options: FileSystemWriteOptions = {},
  ): Promise<FileSystemFileSnapshot> {
    return this.writeFileNow(path, data, options);
  }

  private writeFileNow(
    path: WorkspacePath,
    data: ArrayBuffer | Uint8Array,
    options: FileSystemWriteOptions,
    payloadKind?: MemoryFilePayloadKind,
  ): FileSystemFileSnapshot {
    this.assertOpen('write');
    const canonical = this.canonicalNonRoot(path, 'write');
    const existing = this.entries.get(canonical);
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

    const missingParents = this.planParents(canonical, options.createParents ?? false, 'write');
    const ownedData = copyBytes(data);
    const version = this.nextVersion();
    const now = new Date().toISOString();
    const next = new Map(this.entries);
    this.addDirectories(next, missingParents, version, now);
    next.set(canonical, {
      kind: 'file',
      data: ownedData,
      payloadKind: payloadKind ?? (existing?.kind === 'file' ? existing.payloadKind : 'binary'),
      version,
      lastModified: now,
    });
    this.touchParents(next, canonical, version, now);
    this.entries = next;

    for (const directoryPath of missingParents) {
      this.emit({
        type: 'created',
        kind: 'directory',
        path: directoryPath,
        destinationPath: null,
        version,
        previousVersion: null,
      });
    }
    this.emit({
      type: existing ? 'modified' : 'created',
      kind: 'file',
      path: canonical,
      destinationPath: null,
      version,
      previousVersion: existing?.version ?? null,
    });
    return this.toFileSnapshot(canonical, next.get(canonical) as MemoryFileEntry);
  }

  public async createDirectory(
    path: WorkspacePath,
    options: FileSystemCreateDirectoryOptions = {},
  ): Promise<FileSystemDirectorySnapshot> {
    this.assertOpen('create-directory');
    const canonical = this.canonical(path);
    const existing = this.entries.get(canonical);
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
      return this.toDirectorySnapshot(canonical, existing);
    }

    const missingParents = this.planParents(
      canonical,
      options.createParents ?? false,
      'create-directory',
    );
    const version = this.nextVersion();
    const now = new Date().toISOString();
    const next = new Map(this.entries);
    const created = [...missingParents, canonical];
    this.addDirectories(next, created, version, now);
    this.touchParents(next, canonical, version, now);
    this.entries = next;

    for (const directoryPath of created) {
      this.emit({
        type: 'created',
        kind: 'directory',
        path: directoryPath,
        destinationPath: null,
        version,
        previousVersion: null,
      });
    }
    return this.toDirectorySnapshot(canonical, next.get(canonical) as MemoryDirectoryEntry);
  }

  public async remove(
    path: WorkspacePath,
    options: FileSystemRemoveOptions = {},
  ): Promise<FileSystemRemoveResult> {
    this.assertOpen('remove');
    const canonical = this.canonicalNonRoot(path, 'remove');
    const existing = this.entries.get(canonical);
    if (!existing) {
      if ((options.missing ?? 'error') === 'ignore') {
        return Object.freeze({ removed: false, version: this.treeVersion });
      }
      throw this.error('not-found', 'remove', canonical, 'Entry does not exist.');
    }
    this.assertExpectedVersion(existing, options.expectedVersion, 'remove', canonical);

    const descendants = [...this.entries.keys()].filter((candidate) =>
      workspacePathContains(canonical, candidate, false),
    );
    if (existing.kind === 'directory' && descendants.length > 0 && !options.recursive) {
      throw this.error('not-empty', 'remove', canonical, 'Directory is not empty.');
    }

    const version = this.nextVersion();
    const now = new Date().toISOString();
    const next = new Map(this.entries);
    next.delete(canonical);
    if (existing.kind === 'directory') {
      for (const descendant of descendants) next.delete(descendant);
    }
    this.touchParents(next, canonical, version, now);
    this.entries = next;

    this.emit({
      type: 'removed',
      kind: existing.kind,
      path: canonical,
      destinationPath: null,
      version: null,
      previousVersion: existing.version,
    });
    return Object.freeze({ removed: true, version });
  }

  public async move(
    oldPath: WorkspacePath,
    newPath: WorkspacePath,
    options: FileSystemMoveOptions = {},
  ): Promise<FileSystemEntrySnapshot> {
    this.assertOpen('move');
    const sourcePath = this.canonicalNonRoot(oldPath, 'move');
    const destinationPath = this.canonicalNonRoot(newPath, 'move');
    const source = this.entries.get(sourcePath);
    if (!source) throw this.error('not-found', 'move', sourcePath, 'Source does not exist.');
    this.assertExpectedVersion(source, options.expectedVersion, 'move', sourcePath);
    if (sourcePath === destinationPath) return this.toEntrySnapshot(sourcePath, source);
    if (this.entries.has(destinationPath)) {
      throw new FsError('already-exists', 'Destination already exists.', {
        operation: 'move',
        path: sourcePath,
        destinationPath,
      });
    }
    if (source.kind === 'directory' && workspacePathContains(sourcePath, destinationPath, false)) {
      throw new FsError('invalid-path', 'Cannot move a directory into itself.', {
        operation: 'move',
        path: sourcePath,
        destinationPath,
      });
    }

    const missingParents = this.planParents(
      destinationPath,
      options.createParents ?? false,
      'move',
    );
    const sourcePaths = [...this.entries.keys()].filter((candidate) =>
      workspacePathContains(sourcePath, candidate),
    );
    const sourceSet = new Set(sourcePaths);
    const remapped = sourcePaths.map((currentPath) => {
      const suffix = currentPath.slice(sourcePath.length);
      const target = parseWorkspacePath(`${destinationPath}${suffix}`);
      if (this.entries.has(target) && !sourceSet.has(target)) {
        throw new FsError('already-exists', 'A destination descendant already exists.', {
          operation: 'move',
          path: currentPath,
          destinationPath: target,
        });
      }
      return [currentPath, target] as const;
    });

    const version = this.nextVersion();
    const now = new Date().toISOString();
    const next = new Map(this.entries);
    for (const currentPath of sourcePaths) next.delete(currentPath);
    this.addDirectories(next, missingParents, version, now);
    for (const [currentPath, targetPath] of remapped) {
      const current = this.entries.get(currentPath)!;
      next.set(targetPath, this.withVersion(current, version, now));
    }
    this.touchParents(next, sourcePath, version, now);
    this.touchParents(next, destinationPath, version, now);
    this.entries = next;

    for (const directoryPath of missingParents) {
      this.emit({
        type: 'created',
        kind: 'directory',
        path: directoryPath,
        destinationPath: null,
        version,
        previousVersion: null,
      });
    }
    this.emit({
      type: 'moved',
      kind: source.kind,
      path: sourcePath,
      destinationPath,
      version,
      previousVersion: source.version,
    });
    return this.toEntrySnapshot(destinationPath, next.get(destinationPath)!);
  }

  public async snapshot(): Promise<FileSystemSnapshot> {
    this.assertOpen('snapshot');
    const entries: FileSystemSnapshotEntry[] = [...this.entries.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([path, entry]) => {
        if (entry.kind === 'file') {
          return Object.freeze({ ...this.toFileSnapshot(path, entry), data: entry.data.slice(0) });
        }
        return this.toDirectorySnapshot(path, entry);
      });
    return Object.freeze({ version: this.treeVersion, entries: Object.freeze(entries) });
  }

  public watch(
    listener: FileSystemWatchListener,
    options: FileSystemWatchOptions = {},
  ): FileSystemWatchSubscription {
    this.assertOpen('watch');
    const watcher: MemoryWatcher = { listener, onError: options.onError };
    this.watchers.add(watcher);
    let closed = false;
    let disposePromise: Promise<void> | null = null;
    const subscription: FileSystemWatchSubscription = {
      get closed() {
        return closed;
      },
      ready: Promise.resolve(),
      dispose: () => {
        if (disposePromise) return disposePromise;
        closed = true;
        this.watchers.delete(watcher);
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
    this.disposePromise = Promise.all(
      [...this.subscriptions].map((subscription) => subscription.dispose()),
    ).then(() => undefined);
    return this.disposePromise;
  }

  private canonical(path: WorkspacePath): WorkspacePath {
    return parseWorkspacePath(path);
  }

  private canonicalNonRoot(path: WorkspacePath, operation: FsOperation): WorkspacePath {
    const canonical = this.canonical(path);
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

  private assertOpen(operation: FsOperation): void {
    if (!this.disposed) return;
    throw new FsError('disposed', 'Filesystem provider is disposed.', { operation });
  }

  private assertExpectedVersion(
    entry: MemoryEntry | undefined,
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

  private planParents(
    path: WorkspacePath,
    createParents: boolean,
    operation: FsOperation,
  ): WorkspacePath[] {
    const missing: WorkspacePath[] = [];
    for (const parent of parentChainWithRoot(path)) {
      if (!parent) continue;
      const entry = this.entries.get(parent);
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
    target: Map<WorkspacePath, MemoryEntry>,
    paths: readonly WorkspacePath[],
    version: FileSystemVersion,
    lastModified: string,
  ): void {
    for (const path of paths) {
      target.set(path, { kind: 'directory', version, lastModified });
    }
  }

  private touchParents(
    target: Map<WorkspacePath, MemoryEntry>,
    path: WorkspacePath,
    version: FileSystemVersion,
    lastModified: string,
  ): void {
    for (const parent of parentChainWithRoot(path)) {
      const entry = target.get(parent);
      if (entry?.kind === 'directory') {
        target.set(parent, { kind: 'directory', version, lastModified });
      }
    }
  }

  private withVersion(
    entry: MemoryEntry,
    version: FileSystemVersion,
    lastModified: string,
  ): MemoryEntry {
    return entry.kind === 'file'
      ? {
          kind: 'file',
          data: entry.data,
          payloadKind: entry.payloadKind,
          version,
          lastModified,
        }
      : { kind: 'directory', version, lastModified };
  }

  private nextVersion(): FileSystemVersion {
    this.mutationCounter += 1;
    this.treeVersion = parseFileSystemVersion(`${this.id}:${this.mutationCounter}`);
    return this.treeVersion;
  }

  private toEntrySnapshot(path: WorkspacePath, entry: MemoryEntry): FileSystemEntrySnapshot {
    return entry.kind === 'file'
      ? this.toFileSnapshot(path, entry)
      : this.toDirectorySnapshot(path, entry);
  }

  private toFileSnapshot(path: WorkspacePath, entry: MemoryFileEntry): FileSystemFileSnapshot {
    return Object.freeze({
      kind: 'file',
      path,
      name: workspacePathBasename(path),
      size: entry.data.byteLength,
      version: entry.version,
      lastModified: entry.lastModified,
    });
  }

  private toDirectorySnapshot(
    path: WorkspacePath,
    entry: MemoryDirectoryEntry,
  ): FileSystemDirectorySnapshot {
    return Object.freeze({
      kind: 'directory',
      path,
      name: workspacePathBasename(path),
      size: null,
      version: entry.version,
      lastModified: entry.lastModified,
    });
  }

  private emit(event: MemoryWatchEventInput): void {
    const complete: FileSystemWatchEvent = Object.freeze({
      ...event,
      sequence: ++this.eventSequence,
      origin: 'local',
    });
    this.pendingEvents.push(complete);
    if (this.emittingEvents) return;

    this.emittingEvents = true;
    try {
      while (this.pendingEvents.length > 0) {
        const pending = this.pendingEvents.shift();
        if (!pending) continue;
        for (const watcher of [...this.watchers]) {
          try {
            watcher.listener(pending);
          } catch {
            // A watcher is observational; it cannot roll back a completed mutation.
          }
        }
      }
    } finally {
      this.emittingEvents = false;
    }
  }

  private error(
    code: ConstructorParameters<typeof FsError>[0],
    operation: FsOperation,
    path: WorkspacePath,
    message: string,
  ): FsError {
    return new FsError(code, message, { operation, path });
  }
}

function addParentPaths(target: Set<WorkspacePath>, path: WorkspacePath): void {
  for (const parent of parentChainWithRoot(path)) {
    if (parent) target.add(parent);
  }
}

function isMemoryFilePayloadKind(value: unknown): value is MemoryFilePayloadKind {
  return value === 'text' || value === 'binary';
}
