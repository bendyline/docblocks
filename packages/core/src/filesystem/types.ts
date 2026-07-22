/**
 * FileSystemProvider — abstract interface for a virtual filesystem.
 *
 * Legacy text-oriented facade retained while consumers migrate to
 * FileSystemProviderV2. New persistence code must use the provider's `v2`
 * contract so paths, errors, operation modes, and capabilities are explicit.
 */

// ── Entry types ────────────────────────────────────────────────────

import type { FileSystemProviderV2 } from './v2.js';

export interface FileEntry {
  kind: 'file';
  name: string;
  path: string;
  /** ISO-8601 timestamp when the provider can supply file metadata while listing. */
  lastModified?: string;
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

export type FileCommitResult =
  | { status: 'committed'; version: string | null }
  | { status: 'conflict'; content: string | null; version: string | null };

// ── Provider interface ─────────────────────────────────────────────

/**
 * @deprecated Compatibility facade for external providers and older callers.
 * Implement new backends with `FileSystemProviderV2`; built-in facades expose
 * their authoritative implementation through `v2`.
 */
export interface FileSystemProvider {
  /** Unique identifier for this provider instance. */
  readonly id: string;

  /** Human-readable label (e.g., folder name or "Browser Storage"). */
  readonly label: string;

  /** Optional correctness-first implementation exposed during the v1-to-v2 migration. */
  readonly v2?: FileSystemProviderV2;

  /** Read the text content of a file. Returns null if the file doesn't exist. */
  readFile(path: string): Promise<string | null>;

  /** Write text content to a file, creating it (and parent dirs) if needed. */
  writeFile(path: string, content: string): Promise<void>;

  /**
   * Conditionally replace a text file when it still matches the caller's
   * persisted baseline. Production providers implement this at their
   * strongest available serialization boundary.
   */
  commitFile?(
    path: string,
    content: string,
    expectedContent: string | null,
  ): Promise<FileCommitResult>;

  /**
   * Legacy recursive removal of a file or directory subtree. Workspace root
   * deletion is forbidden. Prefer v2 `remove({ recursive })`.
   */
  delete(path: string): Promise<void>;

  /** Rename or move an entry. Rejects missing sources and existing destinations. */
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

export type FileSystemProviderWithV2 = FileSystemProvider & {
  readonly v2: FileSystemProviderV2;
};

/** Discover a provider-owned v2 implementation without coupling consumers to a concrete class. */
export function hasFileSystemProviderV2(
  provider: FileSystemProvider,
): provider is FileSystemProviderWithV2 {
  return provider.v2 !== undefined && provider.v2 !== null;
}

/** Return the provider-owned v2 implementation when migration support is available. */
export function getFileSystemProviderV2(provider: FileSystemProvider): FileSystemProviderV2 | null {
  return provider.v2 ?? null;
}
