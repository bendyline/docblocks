import { FsError, fsErrorFromUnknown, type FsOperation } from './fs-error.js';
import type { FileSystemEntry, FileSystemProvider } from './types.js';
import {
  parseFileSystemVersion,
  type FileSystemAtomicity,
  type FileSystemCaseSensitivity,
  type FileSystemCreateDirectoryOptions,
  type FileSystemDirectorySnapshot,
  type FileSystemDurability,
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
  type FileSystemSymlinkPolicy,
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
  workspacePathToLegacy,
  type WorkspacePath,
} from './workspace-path.js';
import { bytesEqual, copyBytes } from './internal/bytes.js';
import { compareSnapshotsByName, compareText } from './internal/entry-order.js';

export type LegacyFilePayloadModel =
  | 'split'
  | 'binary-first-text-fallback'
  | 'binary-authoritative';

export interface LegacyFileSystemProviderV2AdapterOptions {
  /**
   * Split stores expose independent raw text and binary channels and reject
   * dual payloads. Binary-first stores synthesize text for binary records, so
   * the adapter only asks for text after readBinary() returns null. Binary-
   * authoritative stores expose every file through readBinary().
   */
  readonly payloadModel: LegacyFilePayloadModel;
  readonly writeAtomicity?: FileSystemAtomicity;
  readonly moveAtomicity?: FileSystemAtomicity;
  readonly caseSensitivity?: FileSystemCaseSensitivity;
  readonly symlinkPolicy?: FileSystemSymlinkPolicy;
  readonly durability?: FileSystemDurability;
  /** Optional ownership hook; omitted when the adapter does not own the v1 provider. */
  readonly dispose?: () => void | Promise<void>;
}

interface CapturedTree {
  readonly entries: ReadonlyMap<WorkspacePath, FileSystemSnapshotEntry>;
  readonly version: FileSystemVersion;
}

const EPOCH = new Date(0).toISOString();

/**
 * Correctness bridge for hardened v1 providers while storage backends migrate.
 *
 * The adapter deliberately serializes every observable operation. This makes a
 * version check and its mutation indivisible among v2 callers, but cannot make
 * calls that bypass the adapter participate in that boundary. Content-derived
 * versions make those external changes visible on the next adapter operation.
 */
export class LegacyFileSystemProviderV2Adapter implements FileSystemProviderV2 {
  public readonly id: string;
  public readonly label: string;
  public readonly capabilities: FileSystemProviderCapabilities;

  private operationTail: Promise<void> = Promise.resolve();
  private readonly subscriptions = new Set<FileSystemWatchSubscription>();
  private closing = false;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  public constructor(
    private readonly provider: FileSystemProvider,
    private readonly options: LegacyFileSystemProviderV2AdapterOptions,
  ) {
    this.id = provider.id;
    this.label = provider.label;
    this.capabilities = Object.freeze({
      writeAtomicity: options.writeAtomicity ?? 'none',
      moveAtomicity: options.moveAtomicity ?? 'none',
      // A tree snapshot spans multiple v1 calls; callers that bypass this
      // adapter can still interleave, even though adapter operations serialize.
      snapshotAtomicity: 'none',
      conditionalWrite: 'process',
      recursiveRemove: true,
      watch: false,
      caseSensitivity: options.caseSensitivity ?? 'platform',
      symlinkPolicy: options.symlinkPolicy ?? 'unsupported',
      durability: options.durability ?? 'best-effort',
    });
  }

  public async stat(path: WorkspacePath): Promise<FileSystemEntrySnapshot | null> {
    const canonical = this.canonical(path);
    return this.enqueue('stat', async () => {
      const entry = (await this.captureTree('stat')).entries.get(canonical);
      return entry ? copyEntrySnapshot(entry) : null;
    });
  }

  public async readFile(path: WorkspacePath): Promise<FileSystemFileRead | null> {
    const canonical = this.canonical(path);
    return this.enqueue('read', async () => {
      const entry = (await this.captureTree('read')).entries.get(canonical);
      if (!entry) return null;
      if (entry.kind !== 'file') {
        throw this.error('type-mismatch', 'read', canonical, 'Expected a file, found a directory.');
      }
      return Object.freeze({ entry: fileMetadata(entry), data: entry.data.slice(0) });
    });
  }

  public async readDirectory(path: WorkspacePath): Promise<readonly FileSystemEntrySnapshot[]> {
    const canonical = this.canonical(path);
    return this.enqueue('list', async () => {
      const tree = await this.captureTree('list');
      const entry = tree.entries.get(canonical);
      if (!entry) throw this.error('not-found', 'list', canonical, 'Directory does not exist.');
      if (entry.kind !== 'directory') {
        throw this.error('type-mismatch', 'list', canonical, 'Expected a directory, found a file.');
      }
      const children = [...tree.entries.entries()]
        .filter(([entryPath]) => entryPath && workspacePathDirname(entryPath) === canonical)
        .map(([, child]) => copyEntrySnapshot(child))
        .sort(compareSnapshotsByName);
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
    return this.enqueue('write', async () => {
      const tree = await this.captureTree('write');
      const existing = tree.entries.get(canonical);
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
      this.assertParents(tree, canonical, options.createParents ?? false, 'write');

      await this.invoke(
        () => this.provider.writeBinary(workspacePathToLegacy(canonical), ownedData),
        'write',
        canonical,
      );
      const written = (await this.captureTree('write')).entries.get(canonical);
      if (written?.kind !== 'file' || !bytesEqual(written.data, ownedData)) {
        throw this.error(
          'io',
          'write',
          canonical,
          'The legacy provider did not persist the requested bytes.',
        );
      }
      return fileMetadata(written);
    });
  }

  public async createDirectory(
    path: WorkspacePath,
    options: FileSystemCreateDirectoryOptions = {},
  ): Promise<FileSystemDirectorySnapshot> {
    const canonical = this.canonical(path);
    return this.enqueue('create-directory', async () => {
      const tree = await this.captureTree('create-directory');
      const existing = tree.entries.get(canonical);
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
        return copyDirectorySnapshot(existing);
      }

      this.assertParents(tree, canonical, options.createParents ?? false, 'create-directory');
      await this.invoke(
        () => this.provider.createDirectory(workspacePathToLegacy(canonical)),
        'create-directory',
        canonical,
      );
      const created = (await this.captureTree('create-directory')).entries.get(canonical);
      if (created?.kind !== 'directory') {
        throw this.error(
          'io',
          'create-directory',
          canonical,
          'The legacy provider did not create the directory.',
        );
      }
      return copyDirectorySnapshot(created);
    });
  }

  public async remove(
    path: WorkspacePath,
    options: FileSystemRemoveOptions = {},
  ): Promise<FileSystemRemoveResult> {
    const canonical = this.canonicalNonRoot(path, 'remove');
    return this.enqueue('remove', async () => {
      const tree = await this.captureTree('remove');
      const existing = tree.entries.get(canonical);
      if (!existing) {
        if ((options.missing ?? 'error') === 'ignore') {
          return Object.freeze({ removed: false, version: tree.version });
        }
        throw this.error('not-found', 'remove', canonical, 'Entry does not exist.');
      }
      this.assertExpectedVersion(existing, options.expectedVersion, 'remove', canonical);
      if (
        existing.kind === 'directory' &&
        !options.recursive &&
        [...tree.entries.keys()].some((candidate) =>
          workspacePathContains(canonical, candidate, false),
        )
      ) {
        throw this.error('not-empty', 'remove', canonical, 'Directory is not empty.');
      }

      await this.invoke(
        () => this.provider.delete(workspacePathToLegacy(canonical)),
        'remove',
        canonical,
      );
      const after = await this.captureTree('remove');
      if (
        [...after.entries.keys()].some((candidate) => workspacePathContains(canonical, candidate))
      ) {
        throw this.error(
          'io',
          'remove',
          canonical,
          'The legacy provider did not remove the complete entry.',
        );
      }
      return Object.freeze({ removed: true, version: after.version });
    });
  }

  public async move(
    oldPath: WorkspacePath,
    newPath: WorkspacePath,
    options: FileSystemMoveOptions = {},
  ): Promise<FileSystemEntrySnapshot> {
    const sourcePath = this.canonicalNonRoot(oldPath, 'move');
    const destinationPath = this.canonicalNonRoot(newPath, 'move');
    return this.enqueue('move', async () => {
      const tree = await this.captureTree('move');
      const source = tree.entries.get(sourcePath);
      if (!source) throw this.error('not-found', 'move', sourcePath, 'Source does not exist.');
      this.assertExpectedVersion(source, options.expectedVersion, 'move', sourcePath);
      if (sourcePath === destinationPath) return copyEntrySnapshot(source);
      if (tree.entries.has(destinationPath)) {
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
      this.assertParents(tree, destinationPath, options.createParents ?? false, 'move');

      const sourceEntries = [...tree.entries.entries()].filter(([candidate]) =>
        workspacePathContains(sourcePath, candidate),
      );
      await this.invoke(
        () =>
          this.provider.rename(
            workspacePathToLegacy(sourcePath),
            workspacePathToLegacy(destinationPath),
          ),
        'move',
        sourcePath,
        destinationPath,
      );

      const after = await this.captureTree('move');
      if (
        [...after.entries.keys()].some((candidate) => workspacePathContains(sourcePath, candidate))
      ) {
        throw this.error(
          'io',
          'move',
          sourcePath,
          'The legacy provider left source entries behind.',
        );
      }
      for (const [oldEntryPath, oldEntry] of sourceEntries) {
        const suffix = oldEntryPath.slice(sourcePath.length);
        const movedPath = parseWorkspacePath(`${destinationPath}${suffix}`);
        const moved = after.entries.get(movedPath);
        if (!moved || moved.kind !== oldEntry.kind || moved.version !== oldEntry.version) {
          throw new FsError(
            'io',
            'The legacy provider did not move the complete entry unchanged.',
            {
              operation: 'move',
              path: oldEntryPath,
              destinationPath: movedPath,
            },
          );
        }
      }
      return copyEntrySnapshot(after.entries.get(destinationPath)!);
    });
  }

  public async snapshot(): Promise<FileSystemSnapshot> {
    return this.enqueue('snapshot', async () => {
      const tree = await this.captureTree('snapshot');
      const entries = [...tree.entries.values()]
        .sort((left, right) => compareText(left.path, right.path))
        .map((entry) => copySnapshotEntry(entry));
      return Object.freeze({ version: tree.version, entries: Object.freeze(entries) });
    });
  }

  public watch(
    _listener: FileSystemWatchListener,
    options: FileSystemWatchOptions = {},
  ): FileSystemWatchSubscription {
    this.assertAccepting('watch');
    const error = new FsError(
      'not-supported',
      'The legacy adapter cannot observe external changes.',
      {
        operation: 'watch',
      },
    );
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
    this.closing = true;
    const run = this.operationTail.then(async () => {
      try {
        await Promise.all([...this.subscriptions].map((subscription) => subscription.dispose()));
        await this.options.dispose?.();
      } catch (error: unknown) {
        throw fsErrorFromUnknown(error, { operation: 'dispose' });
      } finally {
        this.disposed = true;
      }
    });
    this.operationTail = run.then(
      () => undefined,
      () => undefined,
    );
    this.disposePromise = run;
    return run;
  }

  private enqueue<T>(operation: FsOperation, task: () => Promise<T>): Promise<T> {
    this.assertAccepting(operation);
    const run = this.operationTail.then(task);
    this.operationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private assertAccepting(operation: FsOperation): void {
    if (!this.closing && !this.disposed) return;
    throw new FsError('disposed', 'Filesystem provider is disposed.', { operation });
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
        'The workspace root is not an entry target.',
      );
    }
    return canonical;
  }

  private assertExpectedVersion(
    entry: FileSystemSnapshotEntry | undefined,
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

  private assertParents(
    tree: CapturedTree,
    path: WorkspacePath,
    createParents: boolean,
    operation: FsOperation,
  ): void {
    let parent = workspacePathDirname(path);
    const parents: WorkspacePath[] = [];
    while (parent) {
      parents.unshift(parent);
      parent = workspacePathDirname(parent);
    }
    for (const candidate of parents) {
      const entry = tree.entries.get(candidate);
      if (entry?.kind === 'file') {
        throw this.error('type-mismatch', operation, candidate, 'A parent path is a file.');
      }
      if (!entry && !createParents) {
        throw this.error('not-found', operation, candidate, 'Parent directory does not exist.');
      }
    }
  }

  private async captureTree(operation: FsOperation): Promise<CapturedTree> {
    const entries = new Map<WorkspacePath, FileSystemSnapshotEntry>();
    const visiting = new Set<WorkspacePath>();

    const visitDirectory = async (path: WorkspacePath): Promise<FileSystemDirectorySnapshot> => {
      if (visiting.has(path)) {
        throw this.error('io', operation, path, 'The legacy provider returned a directory cycle.');
      }
      visiting.add(path);
      const listed = await this.invoke(
        () => this.provider.readDirectory(workspacePathToLegacy(path)),
        operation,
        path,
      );
      if (!Array.isArray(listed)) {
        throw this.error(
          'io',
          operation,
          path,
          'The legacy provider returned an invalid directory listing.',
        );
      }
      const children: FileSystemSnapshotEntry[] = [];
      const seen = new Set<WorkspacePath>();
      for (const candidate of listed as readonly unknown[]) {
        if (!isLegacyEntry(candidate)) {
          throw this.error(
            'io',
            operation,
            path,
            'The legacy provider returned an invalid directory entry.',
          );
        }
        const legacyEntry = candidate;
        const childPath = parseWorkspacePath(legacyEntry.path);
        if (
          !childPath ||
          workspacePathDirname(childPath) !== path ||
          workspacePathBasename(childPath) !== legacyEntry.name
        ) {
          throw this.error(
            'io',
            operation,
            path,
            'The legacy provider returned a non-child entry.',
          );
        }
        if (seen.has(childPath) || entries.has(childPath)) {
          throw this.error(
            'io',
            operation,
            childPath,
            'The legacy provider returned duplicate entry paths.',
          );
        }
        seen.add(childPath);

        if (legacyEntry.kind === 'directory') {
          children.push(await visitDirectory(childPath));
        } else {
          const file = await this.captureFile(childPath, operation);
          entries.set(childPath, file);
          children.push(file);
        }
      }
      children.sort(compareSnapshotsByName);
      const version = await contentVersion(
        'directory',
        new TextEncoder().encode(
          children
            .map((child) => `${child.kind}\0${child.name.length}:${child.name}\0${child.version}`)
            .join('\n'),
        ),
        operation,
        path,
      );
      const directory = Object.freeze({
        kind: 'directory' as const,
        path,
        name: workspacePathBasename(path),
        size: null,
        version,
        lastModified: newestLastModified(children),
      });
      entries.set(path, directory);
      visiting.delete(path);
      return directory;
    };

    const root = await visitDirectory(WORKSPACE_ROOT);
    return { entries, version: root.version };
  }

  private async captureFile(
    path: WorkspacePath,
    operation: FsOperation,
  ): Promise<FileSystemSnapshotFile> {
    const legacyPath = workspacePathToLegacy(path);
    let data: ArrayBuffer | null;
    if (this.options.payloadModel === 'binary-authoritative') {
      const binary = await this.invoke(() => this.provider.readBinary(legacyPath), operation, path);
      data = binary ? binary.slice(0) : null;
    } else if (this.options.payloadModel === 'binary-first-text-fallback') {
      const binary = await this.invoke(() => this.provider.readBinary(legacyPath), operation, path);
      if (binary) {
        data = binary.slice(0);
      } else {
        const text = await this.invoke(() => this.provider.readFile(legacyPath), operation, path);
        data = text === null ? null : new TextEncoder().encode(text).buffer;
      }
    } else {
      const binary = await this.invoke(() => this.provider.readBinary(legacyPath), operation, path);
      const text = await this.invoke(() => this.provider.readFile(legacyPath), operation, path);
      if (binary !== null && text !== null) {
        throw this.error(
          'conflict',
          operation,
          path,
          'The split legacy store contains both text and binary payloads.',
        );
      }
      data = binary
        ? binary.slice(0)
        : text === null
          ? null
          : new TextEncoder().encode(text).buffer;
    }
    if (!data) {
      throw this.error(
        'io',
        operation,
        path,
        'The legacy provider listed a file without a payload.',
      );
    }

    const meta = await this.invoke(() => this.provider.stat(legacyPath), operation, path);
    if (
      !meta ||
      parseWorkspacePath(meta.path) !== path ||
      meta.name !== workspacePathBasename(path) ||
      meta.size !== data.byteLength ||
      !Number.isFinite(Date.parse(meta.lastModified))
    ) {
      throw this.error(
        'io',
        operation,
        path,
        'The legacy provider returned inconsistent file metadata.',
      );
    }
    return Object.freeze({
      kind: 'file' as const,
      path,
      name: workspacePathBasename(path),
      size: data.byteLength,
      version: await contentVersion('file', new Uint8Array(data), operation, path),
      lastModified: meta.lastModified,
      data,
    });
  }

  private async invoke<T>(
    task: () => Promise<T>,
    operation: FsOperation,
    path?: WorkspacePath,
    destinationPath?: WorkspacePath,
  ): Promise<T> {
    try {
      return await task();
    } catch (error: unknown) {
      throw fsErrorFromUnknown(error, { operation, path, destinationPath });
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

async function contentVersion(
  kind: 'file' | 'directory',
  data: Uint8Array,
  operation: FsOperation,
  path: WorkspacePath,
): Promise<FileSystemVersion> {
  const prefix = new TextEncoder().encode(`${kind}\0`);
  const input = new Uint8Array(prefix.byteLength + data.byteLength);
  input.set(prefix);
  input.set(data, prefix.byteLength);
  let digest: ArrayBuffer;
  try {
    digest = await globalThis.crypto.subtle.digest('SHA-256', input.buffer as ArrayBuffer);
  } catch (error: unknown) {
    throw fsErrorFromUnknown(error, { operation, path, defaultCode: 'not-supported' });
  }
  const hex = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return parseFileSystemVersion(`sha256:${hex}`);
}

function isLegacyEntry(value: unknown): value is FileSystemEntry {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Record<keyof FileSystemEntry, unknown>>;
  return (
    (candidate.kind === 'file' || candidate.kind === 'directory') &&
    typeof candidate.name === 'string' &&
    typeof candidate.path === 'string'
  );
}

function fileMetadata(file: FileSystemSnapshotFile): FileSystemFileSnapshot {
  return Object.freeze({
    kind: 'file',
    path: file.path,
    name: file.name,
    size: file.size,
    version: file.version,
    lastModified: file.lastModified,
  });
}

function copyDirectorySnapshot(
  directory: FileSystemDirectorySnapshot,
): FileSystemDirectorySnapshot {
  return Object.freeze({ ...directory });
}

function copyEntrySnapshot(entry: FileSystemSnapshotEntry): FileSystemEntrySnapshot {
  return entry.kind === 'file' ? fileMetadata(entry) : copyDirectorySnapshot(entry);
}

function copySnapshotEntry(entry: FileSystemSnapshotEntry): FileSystemSnapshotEntry {
  return entry.kind === 'file'
    ? Object.freeze({ ...fileMetadata(entry), data: entry.data.slice(0) })
    : copyDirectorySnapshot(entry);
}

function newestLastModified(children: readonly FileSystemSnapshotEntry[]): string {
  let newest = 0;
  for (const child of children) {
    const timestamp = Date.parse(child.lastModified);
    if (Number.isFinite(timestamp)) newest = Math.max(newest, timestamp);
  }
  return newest ? new Date(newest).toISOString() : EPOCH;
}
