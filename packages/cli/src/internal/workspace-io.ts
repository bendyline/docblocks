/**
 * Node adapter for the filesystem-agnostic workspace output refresh in
 * `@bendyline/docblocks/workspace-settings`.
 *
 * The adapter implements exactly the four v2 operations that refresh needs,
 * rooted at one physical directory:
 *
 * - Every path is a parsed `WorkspacePath` joined under the real root.
 * - Listings omit symbolic links. A symbolic link named directly by a path is
 *   refused rather than followed, and any path whose parent resolves outside
 *   the root is refused with `path-escape`.
 * - Versions are opaque tokens derived from inode, size, and nanosecond mtime.
 * - Writes go to a hidden temporary file in the destination folder and are
 *   published by rename (replace) or by an exclusive hard link / `wx` create
 *   (create), after the expected version is re-checked immediately beforehand.
 *
 * The CLI runs with the invoking user's authority, so conditional writes are
 * process-level emulation over a real filesystem, not a lock against other
 * writers; a lost race surfaces as `FsError('conflict')`.
 */

import type { BigIntStats } from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  FsError,
  mapNodeErrorCodeToFsErrorCode,
  parseFileSystemVersion,
  parseWorkspacePath,
  tryParseWorkspacePath,
  type FileSystemEntrySnapshot,
  type FileSystemFileRead,
  type FileSystemFileSnapshot,
  type FileSystemVersion,
  type FileSystemWriteOptions,
  type FsOperation,
  type WorkspacePath,
} from '@bendyline/docblocks/filesystem';
import type { WorkspaceOutputsIO } from '@bendyline/docblocks/workspace-settings';
import { isLinkUnsupportedError } from './link-support.js';
import { positiveLimit } from './limits.js';
import { isNodeErrorCode } from './node-error.js';
import { isPathInside } from './paths.js';

export interface NodeWorkspaceIOOptions {
  /** Largest file read into memory or written in one call. */
  readonly maxFileBytes?: number;
  /** Largest number of names accepted from one folder listing. */
  readonly maxDirectoryEntries?: number;
}

export const NODE_WORKSPACE_IO_LIMITS = {
  maxFileBytes: 256 * 1024 * 1024,
  maxDirectoryEntries: 100_000,
} as const;

const LISTING_STAT_CONCURRENCY = 16;
const TEMPORARY_PREFIX = '.docblocks-tmp-';

type EntryKind = 'file' | 'directory';

/** Open a workspace root for refresh. The root must be an existing directory. */
export async function createNodeWorkspaceIO(
  rootDir: string,
  options: NodeWorkspaceIOOptions = {},
): Promise<NodeWorkspaceIO> {
  const requested = path.resolve(rootDir);
  let root: string;
  try {
    root = await fs.realpath(requested);
  } catch (error: unknown) {
    if (isNodeErrorCode(error, ['ENOENT', 'ENOTDIR'])) {
      throw new FsError('not-found', `Workspace folder not found: ${requested}`, {
        operation: 'stat',
      });
    }
    throw toFsError(error, 'stat', '');
  }
  let info;
  try {
    info = await fs.stat(root);
  } catch (error: unknown) {
    throw toFsError(error, 'stat', '');
  }
  if (!info.isDirectory()) {
    throw new FsError('type-mismatch', `Workspace root is not a folder: ${requested}`, {
      operation: 'stat',
    });
  }
  return new NodeWorkspaceIO(root, {
    maxFileBytes: positiveLimit(
      options.maxFileBytes,
      NODE_WORKSPACE_IO_LIMITS.maxFileBytes,
      'workspace file byte',
    ),
    maxDirectoryEntries: positiveLimit(
      options.maxDirectoryEntries,
      NODE_WORKSPACE_IO_LIMITS.maxDirectoryEntries,
      'workspace folder entry',
    ),
  });
}

export class NodeWorkspaceIO implements WorkspaceOutputsIO {
  public constructor(
    /** Physical (real-path) workspace root. */
    public readonly root: string,
    private readonly limits: {
      readonly maxFileBytes: number;
      readonly maxDirectoryEntries: number;
    },
  ) {}

  public async stat(input: WorkspacePath): Promise<FileSystemEntrySnapshot | null> {
    const workspacePath = canonical(input, 'stat');
    try {
      const located = await this.locate(workspacePath, 'stat');
      if (!located) return null;
      const info = await lstatOrNull(located);
      if (!info) return null;
      return snapshotFor(workspacePath, assertSupportedKind(info, workspacePath, 'stat'), info);
    } catch (error: unknown) {
      throw toFsError(error, 'stat', workspacePath);
    }
  }

  public async readFile(input: WorkspacePath): Promise<FileSystemFileRead | null> {
    const workspacePath = canonical(input, 'read');
    try {
      const located = await this.locate(workspacePath, 'read');
      if (!located) return null;
      const before = await lstatOrNull(located);
      if (!before) return null;
      if (assertSupportedKind(before, workspacePath, 'read') !== 'file') {
        throw new FsError('type-mismatch', `"${workspacePath}" is a folder, not a file.`, {
          operation: 'read',
          path: workspacePath,
        });
      }
      this.assertFileSize(before.size, workspacePath, 'read');
      return await this.readLocatedFile(located, before, workspacePath);
    } catch (error: unknown) {
      if (isNodeErrorCode(error, ['ENOENT', 'ENOTDIR'])) return null;
      throw toFsError(error, 'read', workspacePath);
    }
  }

  public async readDirectory(input: WorkspacePath): Promise<readonly FileSystemEntrySnapshot[]> {
    const workspacePath = canonical(input, 'list');
    try {
      let directory = this.root;
      if (workspacePath) {
        const located = await this.locate(workspacePath, 'list');
        const info = located ? await lstatOrNull(located) : null;
        if (!located || !info) {
          throw new FsError('not-found', `Folder "${workspacePath}" does not exist.`, {
            operation: 'list',
            path: workspacePath,
          });
        }
        if (assertSupportedKind(info, workspacePath, 'list') !== 'directory') {
          throw new FsError('type-mismatch', `"${workspacePath}" is a file, not a folder.`, {
            operation: 'list',
            path: workspacePath,
          });
        }
        directory = located;
      }
      const names = await this.listNames(directory, workspacePath);
      const entries: FileSystemEntrySnapshot[] = [];
      for (let index = 0; index < names.length; index += LISTING_STAT_CONCURRENCY) {
        const batch = names.slice(index, index + LISTING_STAT_CONCURRENCY);
        const snapshots = await Promise.all(
          batch.map(async (name) => {
            const info = await lstatOrNull(path.join(directory, name));
            if (!info || info.isSymbolicLink()) return null;
            const kind = info.isFile() ? 'file' : info.isDirectory() ? 'directory' : null;
            if (!kind) return null;
            const childPath = parseWorkspacePath(workspacePath ? `${workspacePath}/${name}` : name);
            return snapshotFor(childPath, kind, info);
          }),
        );
        for (const snapshot of snapshots) if (snapshot) entries.push(snapshot);
      }
      return Object.freeze(entries.sort(compareSnapshots));
    } catch (error: unknown) {
      throw toFsError(error, 'list', workspacePath);
    }
  }

  public async writeFile(
    input: WorkspacePath,
    data: ArrayBuffer | Uint8Array,
    options: FileSystemWriteOptions = {},
  ): Promise<FileSystemFileSnapshot> {
    const workspacePath = canonical(input, 'write');
    if (!workspacePath) {
      throw new FsError('invalid-path', 'The workspace root cannot be written.', {
        operation: 'write',
        path: workspacePath,
      });
    }
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    const mode = options.mode ?? 'upsert';
    const expectedVersion = options.expectedVersion;
    let temporary: string | null = null;
    try {
      this.assertFileSize(BigInt(bytes.byteLength), workspacePath, 'write');
      const parent = await this.ensureParent(workspacePath, options.createParents === true);
      const target = path.join(parent, basename(workspacePath));

      // Fail fast before any bytes are staged.
      let current = await lstatOrNull(target);
      assertWritable(current, workspacePath, mode, expectedVersion);

      temporary = path.join(parent, `${TEMPORARY_PREFIX}${randomUUID()}`);
      const handle = await fs.open(temporary, 'wx', 0o666);
      try {
        await handle.writeFile(bytes);
        if (current?.isFile()) await handle.chmod(Number(current.mode & 0o7777n));
      } finally {
        await handle.close();
      }

      // Emulated conditional write: re-check the destination immediately
      // before the atomic publish so a concurrent writer surfaces as conflict.
      current = await lstatOrNull(target);
      assertWritable(current, workspacePath, mode, expectedVersion);

      if (!current && (mode === 'create' || expectedVersion === null)) {
        await publishExclusive(temporary, target, bytes, workspacePath, mode);
      } else {
        await fs.rename(temporary, target);
        temporary = null;
      }

      const written = await fs.lstat(target, { bigint: true });
      const snapshot = snapshotFor(workspacePath, 'file', written);
      if (snapshot.kind !== 'file') throw new Error('Unreachable: wrote a non-file entry.');
      return snapshot;
    } catch (error: unknown) {
      throw toFsError(error, 'write', workspacePath);
    } finally {
      if (temporary) await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Physical absolute path for `workspacePath`, with its parent proven to be
   * inside the root, or null when a parent is missing or is a file.
   */
  private async locate(
    workspacePath: WorkspacePath,
    operation: FsOperation,
  ): Promise<string | null> {
    if (!workspacePath) return this.root;
    const segments = workspacePath.split('/');
    const name = segments.pop()!;
    let parent: string;
    try {
      parent = await fs.realpath(path.join(this.root, ...segments));
    } catch (error: unknown) {
      if (isNodeErrorCode(error, ['ENOENT', 'ENOTDIR'])) return null;
      throw error;
    }
    if (!isPathInside(this.root, parent)) throw escapeError(workspacePath, operation);
    return path.join(parent, name);
  }

  /** Resolve (and optionally create) the physical parent folder of a write. */
  private async ensureParent(
    workspacePath: WorkspacePath,
    createParents: boolean,
  ): Promise<string> {
    const segments = workspacePath.split('/').slice(0, -1);
    let current = this.root;
    let walked = '';
    for (const segment of segments) {
      walked = walked ? `${walked}/${segment}` : segment;
      const next = path.join(current, segment);
      let info = await lstatOrNull(next);
      if (!info) {
        if (!createParents) {
          throw new FsError('not-found', `Parent folder "${walked}" does not exist.`, {
            operation: 'write',
            path: workspacePath,
          });
        }
        try {
          await fs.mkdir(next);
        } catch (error: unknown) {
          if (!isNodeErrorCode(error, 'EEXIST')) throw error;
        }
        info = await fs.lstat(next, { bigint: true });
      }
      if (info.isSymbolicLink()) {
        const physical = await fs.realpath(next);
        if (!isPathInside(this.root, physical)) throw escapeError(workspacePath, 'write');
        if (!(await fs.stat(physical)).isDirectory()) throw parentFileError(walked, workspacePath);
        current = physical;
      } else if (info.isDirectory()) {
        current = next;
      } else {
        throw parentFileError(walked, workspacePath);
      }
    }
    const physicalParent = await fs.realpath(current);
    if (!isPathInside(this.root, physicalParent)) throw escapeError(workspacePath, 'write');
    return physicalParent;
  }

  private async listNames(directory: string, workspacePath: WorkspacePath): Promise<string[]> {
    const names: string[] = [];
    let seen = 0;
    const handle = await fs.opendir(directory);
    for await (const dirent of handle) {
      seen += 1;
      if (seen > this.limits.maxDirectoryEntries) {
        throw new FsError(
          'not-supported',
          `Folder "${workspacePath || '.'}" has more than ${this.limits.maxDirectoryEntries} entries.`,
          { operation: 'list', path: workspacePath },
        );
      }
      if (dirent.isSymbolicLink()) continue;
      // Skip names that do not round-trip as one canonical segment (for
      // example a POSIX name containing a backslash or a control character).
      if (tryParseWorkspacePath(dirent.name) !== dirent.name) continue;
      names.push(dirent.name);
    }
    return names;
  }

  private async readLocatedFile(
    located: string,
    before: BigIntStats,
    workspacePath: WorkspacePath,
  ): Promise<FileSystemFileRead> {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    const handle = await fs.open(located, fsConstants.O_RDONLY | noFollow);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.ino !== before.ino) throw changedError(workspacePath);
      const physical = await fs.realpath(located);
      if (!isPathInside(this.root, physical)) throw escapeError(workspacePath, 'read');
      this.assertFileSize(opened.size, workspacePath, 'read');

      const size = Number(opened.size);
      const buffer = new Uint8Array(size);
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const probe = new Uint8Array(1);
      const grew = (await handle.read(probe, 0, 1, offset)).bytesRead > 0;
      const after = await handle.stat({ bigint: true });
      if (grew || offset !== size || !sameFileState(opened, after)) {
        throw changedError(workspacePath);
      }
      const entry = snapshotFor(workspacePath, 'file', opened);
      if (entry.kind !== 'file') throw new Error('Unreachable: read a non-file entry.');
      return Object.freeze({ entry, data: buffer.buffer });
    } finally {
      await handle.close();
    }
  }

  private assertFileSize(size: bigint, workspacePath: WorkspacePath, operation: FsOperation): void {
    if (size > BigInt(this.limits.maxFileBytes)) {
      throw new FsError(
        'not-supported',
        `"${workspacePath}" is larger than the ${this.limits.maxFileBytes}-byte workspace file limit.`,
        { operation, path: workspacePath },
      );
    }
  }
}

function canonical(input: WorkspacePath, operation: FsOperation): WorkspacePath {
  // Re-parse even branded input: this adapter is the physical boundary.
  try {
    return parseWorkspacePath(input);
  } catch (error: unknown) {
    throw toFsError(error, operation, input);
  }
}

function basename(workspacePath: WorkspacePath): string {
  const slash = workspacePath.lastIndexOf('/');
  return slash < 0 ? workspacePath : workspacePath.slice(slash + 1);
}

async function lstatOrNull(absolutePath: string): Promise<BigIntStats | null> {
  try {
    return await fs.lstat(absolutePath, { bigint: true });
  } catch (error: unknown) {
    if (isNodeErrorCode(error, ['ENOENT', 'ENOTDIR'])) return null;
    throw error;
  }
}

function assertSupportedKind(
  info: BigIntStats,
  workspacePath: WorkspacePath,
  operation: FsOperation,
): EntryKind {
  if (info.isSymbolicLink()) {
    throw new FsError(
      'not-supported',
      `"${workspacePath}" is a symbolic link; workspace outputs never follow links.`,
      { operation, path: workspacePath },
    );
  }
  if (info.isFile()) return 'file';
  if (info.isDirectory()) return 'directory';
  throw new FsError('not-supported', `"${workspacePath}" is not a regular file or folder.`, {
    operation,
    path: workspacePath,
  });
}

function versionFor(kind: EntryKind, info: BigIntStats): FileSystemVersion {
  return parseFileSystemVersion(
    `node-v1:${kind}:ino=${info.ino}:size=${kind === 'file' ? info.size : 0n}:mtime-ns=${info.mtimeNs}`,
  );
}

function snapshotFor(
  workspacePath: WorkspacePath,
  kind: EntryKind,
  info: BigIntStats,
): FileSystemEntrySnapshot {
  const base = {
    path: workspacePath,
    name: basename(workspacePath),
    version: versionFor(kind, info),
    lastModified: info.mtime.toISOString(),
  };
  if (kind === 'directory') return Object.freeze({ ...base, kind, size: null });
  const size = Number(info.size);
  if (!Number.isSafeInteger(size)) {
    throw new FsError('not-supported', `"${workspacePath}" is too large to describe.`, {
      path: workspacePath,
    });
  }
  return Object.freeze({ ...base, kind, size });
}

function sameFileState(left: BigIntStats, right: BigIntStats): boolean {
  return left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

function assertWritable(
  current: BigIntStats | null,
  workspacePath: WorkspacePath,
  mode: NonNullable<FileSystemWriteOptions['mode']>,
  expectedVersion: FileSystemVersion | null | undefined,
): void {
  if (current) {
    const kind = assertSupportedKind(current, workspacePath, 'write');
    if (kind === 'directory') {
      throw new FsError('type-mismatch', `"${workspacePath}" is a folder; it cannot be replaced.`, {
        operation: 'write',
        path: workspacePath,
      });
    }
    if (mode === 'create') {
      throw new FsError('already-exists', `"${workspacePath}" already exists.`, {
        operation: 'write',
        path: workspacePath,
      });
    }
  } else if (mode === 'replace') {
    throw new FsError('not-found', `"${workspacePath}" does not exist.`, {
      operation: 'write',
      path: workspacePath,
    });
  }
  if (expectedVersion === undefined) return;
  const matches =
    expectedVersion === null
      ? !current
      : !!current && versionFor('file', current) === expectedVersion;
  if (!matches) {
    throw new FsError('conflict', `"${workspacePath}" changed since it was read.`, {
      operation: 'write',
      path: workspacePath,
      retryable: true,
    });
  }
}

/** Create-if-absent publication: an atomic hard link, or an exclusive `wx` create. */
async function publishExclusive(
  temporary: string,
  target: string,
  bytes: Uint8Array,
  workspacePath: WorkspacePath,
  mode: NonNullable<FileSystemWriteOptions['mode']>,
): Promise<void> {
  try {
    await fs.link(temporary, target);
    return;
  } catch (error: unknown) {
    if (isNodeErrorCode(error, 'EEXIST')) throw existsRaceError(workspacePath, mode);
    if (!isLinkUnsupportedError(error)) throw error;
  }
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(target, 'wx', 0o666);
  } catch (error: unknown) {
    if (isNodeErrorCode(error, 'EEXIST')) throw existsRaceError(workspacePath, mode);
    throw error;
  }
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

function existsRaceError(
  workspacePath: WorkspacePath,
  mode: NonNullable<FileSystemWriteOptions['mode']>,
): FsError {
  return mode === 'create'
    ? new FsError('already-exists', `"${workspacePath}" already exists.`, {
        operation: 'write',
        path: workspacePath,
      })
    : new FsError('conflict', `"${workspacePath}" was created by another writer.`, {
        operation: 'write',
        path: workspacePath,
        retryable: true,
      });
}

function escapeError(workspacePath: WorkspacePath, operation: FsOperation): FsError {
  return new FsError(
    'path-escape',
    `"${workspacePath}" resolves outside the workspace folder through a symbolic link.`,
    { operation, path: workspacePath },
  );
}

function parentFileError(parent: string, workspacePath: WorkspacePath): FsError {
  return new FsError('type-mismatch', `"${parent}" is a file, not a folder.`, {
    operation: 'write',
    path: workspacePath,
  });
}

function changedError(workspacePath: WorkspacePath): FsError {
  return new FsError('conflict', `"${workspacePath}" changed while it was being read.`, {
    operation: 'read',
    path: workspacePath,
    retryable: true,
  });
}

function compareSnapshots(left: FileSystemEntrySnapshot, right: FileSystemEntrySnapshot): number {
  if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function toFsError(error: unknown, operation: FsOperation, workspacePath: string): FsError {
  if (error instanceof FsError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = nodeErrorCode(error);
  if (code === 'ELOOP') {
    // O_NOFOLLOW refused a destination that became a symbolic link.
    return new FsError(
      'not-supported',
      `"${workspacePath}" is a symbolic link; workspace outputs never follow links.`,
      { operation, path: workspacePath },
    );
  }
  if (code) {
    return new FsError(
      mapNodeErrorCodeToFsErrorCode(code),
      `Could not ${OPERATION_VERBS[operation]} "${workspacePath || '.'}": ${message}`,
      { operation, path: workspacePath },
    );
  }
  return new FsError('io', message, { operation, path: workspacePath });
}

function nodeErrorCode(error: unknown): string | null {
  if (!(error instanceof Error) || !('code' in error)) return null;
  const { code } = error as NodeJS.ErrnoException;
  return typeof code === 'string' ? code : null;
}

const OPERATION_VERBS: Record<FsOperation, string> = {
  'parse-path': 'parse',
  read: 'read',
  stat: 'inspect',
  list: 'list',
  write: 'write',
  'create-directory': 'create',
  remove: 'remove',
  move: 'move',
  snapshot: 'snapshot',
  watch: 'watch',
  dispose: 'close',
};
