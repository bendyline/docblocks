/**
 * NativeFileSystemProvider — wraps the File System Access API
 * (window.showDirectoryPicker / FileSystemDirectoryHandle).
 *
 * Progressive enhancement: only available in browsers that support
 * the API (Chrome, Edge). Feature-detect with `isNativeFileSystemSupported()`.
 */

import type { FileCommitResult, FileSystemProvider, FileSystemEntry, FileMeta } from './types.js';
import { withFileCommitLock } from './commit-lock.js';
import { NativeFileSystemProviderV2 } from './native-provider-v2.js';
import { parseWorkspacePath } from './workspace-path.js';

// ── Feature detection ──────────────────────────────────────────────

export function isNativeFileSystemSupported(): boolean {
  return (
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
  );
}

// ── Handle persistence (IndexedDB, structured clone) ───────────────

const HANDLE_DB_NAME = 'docblocks-handles';
const HANDLE_STORE_NAME = 'directory-handles';

function openHandleDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(HANDLE_STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Persist a FileSystemDirectoryHandle so it survives page reloads. */
export async function storeDirectoryHandle(
  workspaceId: string,
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  const db = await openHandleDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE_NAME, 'readwrite');
    tx.objectStore(HANDLE_STORE_NAME).put(handle, workspaceId);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

/** Retrieve a previously stored handle. Returns null if not found. */
export async function loadDirectoryHandle(
  workspaceId: string,
): Promise<FileSystemDirectoryHandle | null> {
  const db = await openHandleDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE_NAME, 'readonly');
    const req = tx.objectStore(HANDLE_STORE_NAME).get(workspaceId);
    req.onsuccess = () => {
      db.close();
      resolve(req.result ?? null);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

/** Remove a stored handle (e.g. when deleting a workspace). */
export async function removeDirectoryHandle(workspaceId: string): Promise<void> {
  const db = await openHandleDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE_NAME, 'readwrite');
    tx.objectStore(HANDLE_STORE_NAME).delete(workspaceId);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

// ── Helpers ────────────────────────────────────────────────────────

function normalisePath(p: string): string {
  return parseWorkspacePath(p);
}

function errorName(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name?: unknown }).name)
    : undefined;
}

function isMissingEntryError(error: unknown): boolean {
  const name = errorName(error);
  return name === 'NotFoundError' || name === 'TypeMismatchError';
}

function isPermissionError(error: unknown): boolean {
  const name = errorName(error);
  return name === 'NotAllowedError' || name === 'SecurityError';
}

class NativeMoveRecoveryError extends Error {
  readonly causes: readonly unknown[];

  constructor(message: string, causes: readonly unknown[]) {
    super(message);
    this.name = 'NativeMoveRecoveryError';
    this.causes = causes;
  }
}

/**
 * Walk a chain of path segments to reach a FileSystemDirectoryHandle.
 * Returns null if any segment is missing.
 */
async function resolveDir(
  root: FileSystemDirectoryHandle,
  dirPath: string,
): Promise<FileSystemDirectoryHandle | null> {
  if (!dirPath) return root;
  const parts = dirPath.split('/');
  let current = root;
  for (const part of parts) {
    try {
      current = await current.getDirectoryHandle(part);
    } catch (error: unknown) {
      if (isMissingEntryError(error)) return null;
      throw error;
    }
  }
  return current;
}

/**
 * Walk path segments, creating directories as needed.
 */
async function resolveDirCreate(
  root: FileSystemDirectoryHandle,
  dirPath: string,
): Promise<FileSystemDirectoryHandle> {
  if (!dirPath) return root;
  const parts = dirPath.split('/');
  let current = root;
  for (const part of parts) {
    current = await current.getDirectoryHandle(part, { create: true });
  }
  return current;
}

function parentDir(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? '' : p.slice(0, idx);
}

function baseName(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? p : p.slice(idx + 1);
}

function toWritableBinary(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

async function writeAndClose(
  writable: FileSystemWritableFileStream,
  data: string | ArrayBuffer,
): Promise<void> {
  try {
    await writable.write(data);
    await writable.close();
  } catch (error: unknown) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
}

// ── Implementation ─────────────────────────────────────────────────

export class NativeFileSystemProvider implements FileSystemProvider {
  readonly id: string;
  readonly label: string;
  readonly v2: NativeFileSystemProviderV2;

  private root: FileSystemDirectoryHandle;

  constructor(id: string, root: FileSystemDirectoryHandle) {
    this.id = id;
    this.label = root.name;
    this.root = root;
    this.v2 = new NativeFileSystemProviderV2(id, root);
  }

  private withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    return withFileCommitLock(`native:${this.id}:workspace`, operation);
  }

  private async copyDirectory(oldDirPath: string, newDirPath: string): Promise<void> {
    const source = await resolveDir(this.root, oldDirPath);
    if (!source)
      throw new DOMException(`Source directory does not exist: ${oldDirPath}`, 'NotFoundError');
    await resolveDirCreate(this.root, newDirPath);

    for await (const [name, handle] of source as unknown as AsyncIterable<
      [string, FileSystemHandle]
    >) {
      const oldChild = oldDirPath ? `${oldDirPath}/${name}` : name;
      const newChild = newDirPath ? `${newDirPath}/${name}` : name;
      if (handle.kind === 'directory') {
        await this.copyDirectory(oldChild, newChild);
      } else {
        const fileHandle = await source.getFileHandle(name);
        const file = await fileHandle.getFile();
        await this.writeBinaryUnlocked(newChild, await file.arrayBuffer());
      }
    }
  }

  async readFile(path: string): Promise<string | null> {
    const p = normalisePath(path);
    const dir = await resolveDir(this.root, parentDir(p));
    if (!dir) return null;
    try {
      const fileHandle = await dir.getFileHandle(baseName(p));
      const file = await fileHandle.getFile();
      return file.text();
    } catch (error: unknown) {
      if (isMissingEntryError(error)) return null;
      throw error;
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    return this.withMutationLock(() => this.writeFileUnlocked(path, content));
  }

  private async writeFileUnlocked(path: string, content: string): Promise<void> {
    const p = normalisePath(path);
    const dir = await resolveDirCreate(this.root, parentDir(p));
    const fileHandle = await dir.getFileHandle(baseName(p), { create: true });
    const writable = await fileHandle.createWritable();
    await writeAndClose(writable, content);
  }

  async commitFile(
    path: string,
    content: string,
    expectedContent: string | null,
  ): Promise<FileCommitResult> {
    const p = normalisePath(path);
    return this.withMutationLock(async () => {
      const current = await this.readFile(p);
      if (current !== expectedContent && current !== content) {
        const meta = await this.stat(p);
        return {
          status: 'conflict',
          content: current,
          version: meta?.lastModified ?? null,
        };
      }
      await this.writeFileUnlocked(p, content);
      const meta = await this.stat(p);
      return { status: 'committed', version: meta?.lastModified ?? null };
    });
  }

  async delete(path: string): Promise<void> {
    return this.withMutationLock(() => this.deleteUnlocked(path));
  }

  private async deleteUnlocked(path: string): Promise<void> {
    const p = normalisePath(path);
    if (!p) throw new Error('Cannot delete the filesystem root');
    const parent = parentDir(p);
    const name = baseName(p);
    const dir = await resolveDir(this.root, parent);
    if (!dir) return;
    try {
      await dir.removeEntry(name, { recursive: true });
    } catch (error: unknown) {
      if (isMissingEntryError(error)) return;
      throw error;
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    return this.withMutationLock(() => this.renameUnlocked(oldPath, newPath));
  }

  private async renameUnlocked(oldPath: string, newPath: string): Promise<void> {
    const op = normalisePath(oldPath);
    const np = normalisePath(newPath);
    if (op === np) return;
    if (!op || !np) {
      throw new Error('Cannot rename the filesystem root');
    }
    if (np.startsWith(op + '/')) {
      throw new Error('Cannot move a directory into itself');
    }
    if (!(await this.exists(op))) {
      throw new Error(`Source does not exist: ${oldPath}`);
    }
    if (await this.exists(np)) {
      throw new Error(`Destination exists: ${newPath}`);
    }

    // The File System Access API doesn't have a native rename.
    // Copy → delete.
    const oldParent = await resolveDir(this.root, parentDir(op));
    if (!oldParent) {
      throw new DOMException(`Source does not exist: ${oldPath}`, 'NotFoundError');
    }

    let fileHandle: FileSystemFileHandle | null = null;
    try {
      fileHandle = await oldParent.getFileHandle(baseName(op));
    } catch (error: unknown) {
      if (!isMissingEntryError(error)) throw error;
    }

    if (fileHandle) {
      const file = await fileHandle.getFile();
      await this.writeBinaryUnlocked(np, await file.arrayBuffer());
      try {
        await this.deleteUnlocked(op);
      } catch (error: unknown) {
        try {
          await this.deleteUnlocked(np);
        } catch (rollbackError: unknown) {
          throw new NativeMoveRecoveryError(
            `Move partially completed and rollback failed: ${oldPath} -> ${newPath}`,
            [error, rollbackError],
          );
        }
        throw error;
      }
      return;
    }

    try {
      await this.copyDirectory(op, np);
    } catch (error: unknown) {
      try {
        await this.deleteUnlocked(np);
      } catch (rollbackError: unknown) {
        throw new NativeMoveRecoveryError(
          `Move failed and destination cleanup failed: ${oldPath} -> ${newPath}`,
          [error, rollbackError],
        );
      }
      throw error;
    }

    try {
      await this.deleteUnlocked(op);
    } catch (error: unknown) {
      // Deleting a directory is not atomic: this can fail after some children
      // are already gone, leaving the source gutted and the copy at the
      // destination the only complete one in existence. Rebuild the source from
      // that copy before removing it, and if the source cannot be made whole,
      // keep the copy — deleting it would destroy the user's only data.
      try {
        await this.copyDirectory(np, op);
      } catch (restoreError: unknown) {
        throw new NativeMoveRecoveryError(
          `Move partially deleted the source and it could not be restored; the copy at ${newPath} was kept: ${oldPath} -> ${newPath}`,
          [error, restoreError],
        );
      }
      try {
        await this.deleteUnlocked(np);
      } catch (rollbackError: unknown) {
        throw new NativeMoveRecoveryError(
          `Move partially completed and rollback failed: ${oldPath} -> ${newPath}`,
          [error, rollbackError],
        );
      }
      throw error;
    }
  }

  async readDirectory(path: string): Promise<FileSystemEntry[]> {
    const p = normalisePath(path);
    const dir = await resolveDir(this.root, p);
    if (!dir) return [];

    const entries: FileSystemEntry[] = [];
    for await (const [name, handle] of dir as unknown as AsyncIterable<
      [string, FileSystemHandle]
    >) {
      const entryPath = p ? `${p}/${name}` : name;
      if (handle.kind === 'directory') {
        entries.push({ kind: 'directory', name, path: entryPath });
      } else {
        entries.push({ kind: 'file', name, path: entryPath });
      }
    }

    // Sort: directories first, then alphabetical
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return entries;
  }

  async exists(path: string): Promise<boolean> {
    const p = normalisePath(path);
    const parent = parentDir(p);
    const name = baseName(p);
    const dir = await resolveDir(this.root, parent);
    if (!dir) return false;

    try {
      await dir.getFileHandle(name);
      return true;
    } catch (fileError: unknown) {
      if (!isMissingEntryError(fileError)) throw fileError;
      try {
        await dir.getDirectoryHandle(name);
        return true;
      } catch (directoryError: unknown) {
        if (!isMissingEntryError(directoryError)) throw directoryError;
        return false;
      }
    }
  }

  async createDirectory(path: string): Promise<void> {
    return this.withMutationLock(async () => {
      const p = normalisePath(path);
      await resolveDirCreate(this.root, p);
    });
  }

  async stat(path: string): Promise<FileMeta | null> {
    const p = normalisePath(path);
    const dir = await resolveDir(this.root, parentDir(p));
    if (!dir) return null;

    try {
      const fileHandle = await dir.getFileHandle(baseName(p));
      const file = await fileHandle.getFile();
      return {
        name: file.name,
        path: p,
        size: file.size,
        lastModified: new Date(file.lastModified).toISOString(),
      };
    } catch (error: unknown) {
      if (isMissingEntryError(error)) return null;
      throw error;
    }
  }

  async readBinary(path: string): Promise<ArrayBuffer | null> {
    const p = normalisePath(path);
    const dir = await resolveDir(this.root, parentDir(p));
    if (!dir) return null;
    try {
      const fileHandle = await dir.getFileHandle(baseName(p));
      const file = await fileHandle.getFile();
      return file.arrayBuffer();
    } catch (error: unknown) {
      if (isMissingEntryError(error)) return null;
      throw error;
    }
  }

  async writeBinary(path: string, data: ArrayBuffer | Uint8Array): Promise<void> {
    return this.withMutationLock(() => this.writeBinaryUnlocked(path, data));
  }

  private async writeBinaryUnlocked(path: string, data: ArrayBuffer | Uint8Array): Promise<void> {
    const p = normalisePath(path);
    const dir = await resolveDirCreate(this.root, parentDir(p));
    const fileHandle = await dir.getFileHandle(baseName(p), { create: true });
    const writable = await fileHandle.createWritable();
    await writeAndClose(writable, toWritableBinary(data));
  }
}

/**
 * Prompt the user to pick a local folder and return a NativeFileSystemProvider.
 * The directory handle is persisted in IndexedDB so it can be restored later.
 * Throws if the user cancels or the API is unsupported.
 */
export async function openNativeFolder(): Promise<NativeFileSystemProvider> {
  if (!isNativeFileSystemSupported()) {
    throw new Error('File System Access API is not supported in this browser');
  }

  const handle = await (
    globalThis as unknown as {
      showDirectoryPicker: (options: { mode: 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker({ mode: 'readwrite' });
  const id = `native-${handle.name}-${Date.now()}`;
  await storeDirectoryHandle(id, handle);
  return new NativeFileSystemProvider(id, handle);
}

/**
 * Restore a previously opened native folder from a persisted handle.
 * Re-requests read/write permission (browser will show a prompt).
 * Returns null if the handle is not found or permission is denied.
 */
export async function restoreNativeFolder(
  workspaceId: string,
): Promise<NativeFileSystemProvider | null> {
  const handle = await loadDirectoryHandle(workspaceId);
  if (!handle) return null;

  // Verify/request permission
  const opts = { mode: 'readwrite' as const };
  const h = handle as FileSystemDirectoryHandle & {
    queryPermission(desc: { mode: string }): Promise<string>;
    requestPermission(desc: { mode: string }): Promise<string>;
  };
  try {
    if ((await h.queryPermission(opts)) === 'granted') {
      return new NativeFileSystemProvider(workspaceId, handle);
    }
    if ((await h.requestPermission(opts)) === 'granted') {
      return new NativeFileSystemProvider(workspaceId, handle);
    }
  } catch (error: unknown) {
    if (!isPermissionError(error)) throw error;
  }

  return null;
}
