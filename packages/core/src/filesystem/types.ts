/**
 * FileSystemProvider — abstract interface for a virtual filesystem.
 *
 * Implementations back onto IndexedDB (for browser-local storage) or
 * the File System Access API (for native folder access).
 */

// ── Entry types ────────────────────────────────────────────────────

export interface FileEntry {
  kind: 'file';
  name: string;
  path: string;
}

export interface FolderEntry {
  kind: 'directory';
  name: string;
  path: string;
}

export type FileSystemEntry = FileEntry | FolderEntry;

export interface FileMeta {
  name: string;
  path: string;
  size: number;
  lastModified: string;
}

// ── Provider interface ─────────────────────────────────────────────

export interface FileSystemProvider {
  /** Unique identifier for this provider instance. */
  readonly id: string;

  /** Human-readable label (e.g., folder name or "Browser Storage"). */
  readonly label: string;

  /** Read the text content of a file. Returns null if the file doesn't exist. */
  readFile(path: string): Promise<string | null>;

  /** Write text content to a file, creating it (and parent dirs) if needed. */
  writeFile(path: string, content: string): Promise<void>;

  /** Delete a file or empty directory. */
  delete(path: string): Promise<void>;

  /** Rename or move an entry. */
  rename(oldPath: string, newPath: string): Promise<void>;

  /** List immediate children of a directory. */
  readDirectory(path: string): Promise<FileSystemEntry[]>;

  /** Check whether a path exists. */
  exists(path: string): Promise<boolean>;

  /** Create a directory (and parents if needed). */
  createDirectory(path: string): Promise<void>;

  /** Get metadata for a file. Returns null if not found. */
  stat(path: string): Promise<FileMeta | null>;

  /** Read raw binary content. Returns null if not found. */
  readBinary(path: string): Promise<ArrayBuffer | null>;

  /** Write raw binary content. */
  writeBinary(path: string, data: ArrayBuffer | Uint8Array): Promise<void>;
}
