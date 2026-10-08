/**
 * Core's workspace-output filesystem contract over `vscode.workspace.fs`.
 *
 * Only `vscode.workspace.fs` is used, so the same adapter runs in the Node
 * extension host and in vscode.dev's web worker. Paths arrive as canonical
 * workspace paths (core parses them) and are joined under the workspace
 * folder; symbolic links are never followed out of a listing or written
 * through. VS Code offers no conditional write, so `expectedVersion` is
 * checked by re-statting immediately before writing — a best-effort guard
 * against a concurrent writer, documented as such.
 */

import * as vscode from 'vscode';
import {
  FsError,
  parseFileSystemVersion,
  parseWorkspacePath,
  type FileSystemDirectorySnapshot,
  type FileSystemEntrySnapshot,
  type FileSystemFileRead,
  type FileSystemFileSnapshot,
  type FileSystemWriteOptions,
  type WorkspacePath,
} from '@bendyline/docblocks/filesystem';
import type { WorkspaceOutputsIO } from '@bendyline/docblocks/workspace-settings';

/** The subset of `vscode.workspace.fs` the adapter uses (injectable for tests). */
export interface WorkspaceFileSystemLike {
  stat(uri: vscode.Uri): Thenable<vscode.FileStat>;
  readDirectory(uri: vscode.Uri): Thenable<[string, vscode.FileType][]>;
  readFile(uri: vscode.Uri): Thenable<Uint8Array>;
  writeFile(uri: vscode.Uri, content: Uint8Array): Thenable<void>;
  createDirectory(uri: vscode.Uri): Thenable<void>;
}

export interface VscodeWorkspaceIOOptions {
  readonly fs?: WorkspaceFileSystemLike;
  /** True when an open editor holds unsaved edits for this file. */
  readonly isDirty?: (uri: vscode.Uri) => boolean;
  /** False for read-only file systems; defaults to VS Code's own answer. */
  readonly isWritable?: (uri: vscode.Uri) => boolean;
}

export const VSCODE_WORKSPACE_IO_LIMITS = {
  maxEntriesPerDirectory: 100_000,
  statConcurrency: 16,
} as const;

function isNotFound(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === 'FileNotFound';
}

function mapError(
  error: unknown,
  operation: 'read' | 'stat' | 'list' | 'write',
  path: string,
): FsError {
  if (error instanceof FsError) return error;
  if (error instanceof vscode.FileSystemError) {
    const code =
      error.code === 'FileNotFound'
        ? 'not-found'
        : error.code === 'FileExists'
          ? 'already-exists'
          : error.code === 'NoPermissions'
            ? 'permission-denied'
            : error.code === 'FileIsADirectory' || error.code === 'FileNotADirectory'
              ? 'type-mismatch'
              : error.code === 'Unavailable'
                ? 'busy'
                : 'io';
    return new FsError(code, error.message, { operation, path });
  }
  return new FsError('io', error instanceof Error ? error.message : String(error), {
    operation,
    path,
  });
}

function versionOf(stat: vscode.FileStat): ReturnType<typeof parseFileSystemVersion> {
  return parseFileSystemVersion(`vscode:${stat.type}:${stat.mtime}:${stat.size}`);
}

function lastModified(stat: vscode.FileStat): string {
  return new Date(Number.isFinite(stat.mtime) && stat.mtime > 0 ? stat.mtime : 0).toISOString();
}

function nameOf(path: WorkspacePath): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function snapshot(path: WorkspacePath, stat: vscode.FileStat): FileSystemEntrySnapshot | null {
  if ((stat.type & vscode.FileType.SymbolicLink) !== 0) return null;
  const base = {
    path,
    name: nameOf(path),
    version: versionOf(stat),
    lastModified: lastModified(stat),
  };
  if ((stat.type & vscode.FileType.Directory) !== 0) {
    const directory: FileSystemDirectorySnapshot = { ...base, kind: 'directory', size: null };
    return directory;
  }
  if ((stat.type & vscode.FileType.File) !== 0) {
    const file: FileSystemFileSnapshot = { ...base, kind: 'file', size: stat.size };
    return file;
  }
  return null;
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await map(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function createVscodeWorkspaceIO(
  root: vscode.Uri,
  options: VscodeWorkspaceIOOptions = {},
): WorkspaceOutputsIO {
  const fs = options.fs ?? vscode.workspace.fs;
  const uriOf = (path: WorkspacePath): vscode.Uri =>
    path ? vscode.Uri.joinPath(root, ...path.split('/')) : root;

  const statPath = async (path: WorkspacePath): Promise<FileSystemEntrySnapshot | null> => {
    try {
      const entry = snapshot(path, await fs.stat(uriOf(path)));
      if (!entry && path) {
        throw new FsError('not-supported', `${path} is a symbolic link or special file.`, {
          operation: 'stat',
          path,
        });
      }
      return entry;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw mapError(error, 'stat', path);
    }
  };

  /** Refuse to write through a symlinked folder that could lead outside the workspace. */
  const assertRealParents = async (path: WorkspacePath): Promise<void> => {
    const segments = path.split('/').slice(0, -1);
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const parent = parseWorkspacePath(segments.slice(0, depth).join('/'));
      let stat: vscode.FileStat;
      try {
        stat = await fs.stat(uriOf(parent));
      } catch (error) {
        if (isNotFound(error)) return;
        throw mapError(error, 'write', parent);
      }
      if ((stat.type & vscode.FileType.SymbolicLink) !== 0) {
        throw new FsError(
          'path-escape',
          `${parent} is a symbolic link; DocBlocks will not write through it.`,
          {
            operation: 'write',
            path,
          },
        );
      }
    }
  };

  return {
    stat: statPath,

    async readFile(path): Promise<FileSystemFileRead | null> {
      const entry = await statPath(path);
      if (!entry) return null;
      if (entry.kind !== 'file') {
        throw new FsError('type-mismatch', `${path} is a folder.`, { operation: 'read', path });
      }
      try {
        const bytes = await fs.readFile(uriOf(path));
        const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        return { entry, data: data as ArrayBuffer };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw mapError(error, 'read', path);
      }
    },

    async readDirectory(path): Promise<readonly FileSystemEntrySnapshot[]> {
      let listing: [string, vscode.FileType][];
      try {
        listing = await fs.readDirectory(uriOf(path));
      } catch (error) {
        throw mapError(error, 'list', path);
      }
      if (listing.length > VSCODE_WORKSPACE_IO_LIMITS.maxEntriesPerDirectory) {
        throw new FsError('io', `${path || 'The workspace folder'} has too many entries to list.`, {
          operation: 'list',
          path,
        });
      }
      const names = listing
        .filter(([, type]) => (type & vscode.FileType.SymbolicLink) === 0)
        .map(([name]) => name)
        .filter((name) => name && !name.includes('/') && !name.includes('\\'))
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      const entries = await mapConcurrent(
        names,
        VSCODE_WORKSPACE_IO_LIMITS.statConcurrency,
        async (name) => {
          const childPath = parseWorkspacePath(path ? `${path}/${name}` : name);
          try {
            return snapshot(childPath, await fs.stat(uriOf(childPath)));
          } catch (error) {
            if (isNotFound(error)) return null;
            throw mapError(error, 'stat', childPath);
          }
        },
      );
      return entries.filter((entry): entry is FileSystemEntrySnapshot => entry !== null);
    },

    async writeFile(
      path,
      data,
      writeOptions: FileSystemWriteOptions = {},
    ): Promise<FileSystemFileSnapshot> {
      if (!path) {
        throw new FsError('invalid-path', 'The workspace root cannot be written.', {
          operation: 'write',
          path,
        });
      }
      const uri = uriOf(path);
      const writable =
        options.isWritable?.(uri) ?? vscode.workspace.fs.isWritableFileSystem(uri.scheme) !== false;
      if (!writable) {
        throw new FsError('permission-denied', 'This workspace is read-only.', {
          operation: 'write',
          path,
        });
      }
      if (options.isDirty?.(uri)) {
        throw new FsError('busy', `${path} is open with unsaved changes.`, {
          operation: 'write',
          path,
        });
      }
      await assertRealParents(path);
      const current = await statPath(path);
      const mode = writeOptions.mode ?? 'upsert';
      if (current && current.kind !== 'file') {
        throw new FsError('type-mismatch', `${path} is a folder.`, { operation: 'write', path });
      }
      if (current && (mode === 'create' || writeOptions.expectedVersion === null)) {
        throw new FsError('already-exists', `${path} already exists.`, {
          operation: 'write',
          path,
        });
      }
      if (!current && mode === 'replace') {
        throw new FsError('not-found', `${path} does not exist.`, { operation: 'write', path });
      }
      if (
        writeOptions.expectedVersion !== undefined &&
        writeOptions.expectedVersion !== null &&
        current?.version !== writeOptions.expectedVersion
      ) {
        throw new FsError('conflict', `${path} changed while DocBlocks was updating it.`, {
          operation: 'write',
          path,
        });
      }
      const parent = path.includes('/')
        ? parseWorkspacePath(path.slice(0, path.lastIndexOf('/')))
        : null;
      try {
        if (parent && writeOptions.createParents) await fs.createDirectory(uriOf(parent));
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        await fs.writeFile(uri, bytes);
      } catch (error) {
        throw mapError(error, 'write', path);
      }
      const written = await statPath(path);
      if (!written || written.kind !== 'file') {
        throw new FsError('io', `${path} was not written.`, { operation: 'write', path });
      }
      return written;
    },
  };
}
