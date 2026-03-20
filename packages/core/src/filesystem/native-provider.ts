/**
 * NativeFileSystemProvider — wraps the File System Access API
 * (window.showDirectoryPicker / FileSystemDirectoryHandle).
 *
 * Progressive enhancement: only available in browsers that support
 * the API (Chrome, Edge). Feature-detect with `isNativeFileSystemSupported()`.
 */

import type { FileSystemProvider, FileSystemEntry, FileMeta } from './types.js';

// ── Feature detection ──────────────────────────────────────────────

export function isNativeFileSystemSupported(): boolean {
  return typeof globalThis !== 'undefined' && 'showDirectoryPicker' in globalThis;
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
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '').replace(/\/$/, '');
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
    } catch {
      return null;
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

// ── Implementation ─────────────────────────────────────────────────

export class NativeFileSystemProvider implements FileSystemProvider {
  readonly id: string;
  readonly label: string;

  private root: FileSystemDirectoryHandle;

  constructor(id: string, root: FileSystemDirectoryHandle) {
    this.id = id;
    this.label = root.name;
    this.root = root;
  }

  async readFile(path: string): Promise<string | null> {
    const p = normalisePath(path);
    const dir = await resolveDir(this.root, parentDir(p));
    if (!dir) return null;
    try {
      const fileHandle = await dir.getFileHandle(baseName(p));
      const file = await fileHandle.getFile();
      return file.text();
    } catch {
      return null;
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    const p = normalisePath(path);
    const dir = await resolveDirCreate(this.root, parentDir(p));
    const fileHandle = await dir.getFileHandle(baseName(p), { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
  }

  async delete(path: string): Promise<void> {
    const p = normalisePath(path);
    const parent = parentDir(p);
    const name = baseName(p);
    const dir = await resolveDir(this.root, parent);
    if (!dir) return;
    await dir.removeEntry(name, { recursive: true });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const op = normalisePath(oldPath);
    const np = normalisePath(newPath);

    // The File System Access API doesn't have a native rename.
    // Read → write → delete.
    const content = await this.readFile(op);
    if (content !== null) {
      await this.writeFile(np, content);
      await this.delete(op);
      return;
    }

    // Try binary
    const binary = await this.readBinary(op);
    if (binary !== null) {
      await this.writeBinary(np, binary);
      await this.delete(op);
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
    } catch {
      try {
        await dir.getDirectoryHandle(name);
        return true;
      } catch {
        return false;
      }
    }
  }

  async createDirectory(path: string): Promise<void> {
    const p = normalisePath(path);
    await resolveDirCreate(this.root, p);
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
    } catch {
      return null;
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
    } catch {
      return null;
    }
  }

  async writeBinary(path: string, data: ArrayBuffer | Uint8Array): Promise<void> {
    const p = normalisePath(path);
    const dir = await resolveDirCreate(this.root, parentDir(p));
    const fileHandle = await dir.getFileHandle(baseName(p), { create: true });
    const writable = await fileHandle.createWritable();
    if (data instanceof ArrayBuffer) {
      await writable.write(data);
    } else {
      await writable.write(data.buffer as ArrayBuffer);
    }
    await writable.close();
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
    globalThis as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }
  ).showDirectoryPicker();
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
  if ((await h.queryPermission(opts)) === 'granted') {
    return new NativeFileSystemProvider(workspaceId, handle);
  }
  if ((await h.requestPermission(opts)) === 'granted') {
    return new NativeFileSystemProvider(workspaceId, handle);
  }

  return null;
}
