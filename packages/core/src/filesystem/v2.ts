import type { FsError } from './fs-error.js';
import type { WorkspacePath } from './workspace-path.js';

/**
 * Opaque provider-issued token representing one observed entry/tree state.
 * Tokens support equality only within the issuing provider; callers must not
 * parse them or assume a move or byte-identical rewrite changes the token.
 * A token need not be a content hash, but it must change whenever the issuing
 * provider observes a potentially different kind, payload, or descendant
 * state. Detection of non-cooperating external changes is bounded by the
 * backend's declared capabilities and metadata precision.
 */
declare const fileSystemVersionBrand: unique symbol;
export type FileSystemVersion = string & {
  readonly [fileSystemVersionBrand]: 'FileSystemVersion';
};

/** Validate/rebrand a version received from a provider transport. */
export function parseFileSystemVersion(value: unknown): FileSystemVersion {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\0')) {
    throw new TypeError('Filesystem version tokens must be non-empty bounded strings.');
  }
  return value as FileSystemVersion;
}

export function tryParseFileSystemVersion(value: unknown): FileSystemVersion | null {
  try {
    return parseFileSystemVersion(value);
  } catch {
    return null;
  }
}

/** `process` excludes this provider's local peers; `cross-context` also excludes cooperating tabs/processes. */
export type FileSystemAtomicity = 'none' | 'process' | 'cross-context';
export type FileSystemCaseSensitivity = 'sensitive' | 'insensitive' | 'platform';
export type FileSystemDurability = 'volatile' | 'best-effort' | 'durable';
export type FileSystemConditionalWriteStrength =
  | 'none'
  | 'process'
  | 'cross-context'
  | 'storage-atomic';
export type FileSystemSymlinkPolicy = 'unsupported' | 'reject' | 'follow-contained' | 'preserve';

/** Serializable feature declaration; consumers never need provider instanceof checks. */
export interface FileSystemProviderCapabilities {
  /** Isolation of one successful file replacement from cooperating writers. */
  readonly writeAtomicity: FileSystemAtomicity;
  /** Isolation of one successful source-to-destination move. */
  readonly moveAtomicity: FileSystemAtomicity;
  /** Writers excluded while one complete snapshot is captured. */
  readonly snapshotAtomicity: FileSystemAtomicity;
  /** Strongest boundary at which expectedVersion is checked with mutation. */
  readonly conditionalWrite: FileSystemConditionalWriteStrength;
  readonly recursiveRemove: boolean;
  /** True only when watch has a real ready barrier and sequenced events. */
  readonly watch: boolean;
  readonly caseSensitivity: FileSystemCaseSensitivity;
  readonly symlinkPolicy: FileSystemSymlinkPolicy;
  readonly durability: FileSystemDurability;
}

interface FileSystemEntrySnapshotBase {
  readonly path: WorkspacePath;
  readonly name: string;
  readonly version: FileSystemVersion;
  /** ISO-8601 timestamp supplied by the backend; versions remain authoritative. */
  readonly lastModified: string;
}

export interface FileSystemFileSnapshot extends FileSystemEntrySnapshotBase {
  readonly kind: 'file';
  readonly size: number;
}

export interface FileSystemDirectorySnapshot extends FileSystemEntrySnapshotBase {
  readonly kind: 'directory';
  readonly size: null;
}

export type FileSystemEntrySnapshot = FileSystemFileSnapshot | FileSystemDirectorySnapshot;

/** A read always couples owned bytes to the exact metadata version they represent. */
export interface FileSystemFileRead {
  readonly entry: FileSystemFileSnapshot;
  readonly data: ArrayBuffer;
}

export interface FileSystemSnapshotFile extends FileSystemFileSnapshot {
  readonly data: ArrayBuffer;
}

export type FileSystemSnapshotEntry = FileSystemSnapshotFile | FileSystemDirectorySnapshot;

/**
 * Complete best-available tree traversal. `snapshotAtomicity` declares
 * whether concurrent local/cross-context mutations are excluded while it is
 * captured. Implementations must never expose aliased buffers.
 */
export interface FileSystemSnapshot {
  readonly version: FileSystemVersion;
  readonly entries: readonly FileSystemSnapshotEntry[];
}

export type FileSystemWriteMode = 'upsert' | 'create' | 'replace';

export interface FileSystemWriteOptions {
  /** Defaults to upsert. */
  readonly mode?: FileSystemWriteMode;
  /** Defaults to false so structure creation is never implicit. */
  readonly createParents?: boolean;
  /** null means the entry must not exist; a token requires an exact match. */
  readonly expectedVersion?: FileSystemVersion | null;
}

export type FileSystemCreateDirectoryMode = 'ensure' | 'create';

export interface FileSystemCreateDirectoryOptions {
  /** Defaults to ensure (idempotently return an existing directory). */
  readonly mode?: FileSystemCreateDirectoryMode;
  /** Defaults to false. */
  readonly createParents?: boolean;
}

export interface FileSystemRemoveOptions {
  /** Defaults to false; non-empty directories otherwise fail with not-empty. */
  readonly recursive?: boolean;
  /** Defaults to error. */
  readonly missing?: 'ignore' | 'error';
  readonly expectedVersion?: FileSystemVersion;
}

export interface FileSystemRemoveResult {
  readonly removed: boolean;
  /** Version of the complete tree after the removal attempt. */
  readonly version: FileSystemVersion;
}

export interface FileSystemMoveOptions {
  /** Defaults to false. Destinations are never overwritten. */
  readonly createParents?: boolean;
  readonly expectedVersion?: FileSystemVersion;
}

export type FileSystemWatchEventType = 'created' | 'modified' | 'removed' | 'moved' | 'overflow';
export type FileSystemWatchEventOrigin = 'local' | 'external' | 'unknown';

interface FileSystemWatchEventBase {
  readonly sequence: number;
  readonly origin: FileSystemWatchEventOrigin;
  readonly path: WorkspacePath;
}

export interface FileSystemEntryWatchEvent extends FileSystemWatchEventBase {
  readonly type: Exclude<FileSystemWatchEventType, 'overflow'>;
  readonly kind: 'file' | 'directory';
  readonly destinationPath: WorkspacePath | null;
  readonly version: FileSystemVersion | null;
  readonly previousVersion: FileSystemVersion | null;
}

export interface FileSystemOverflowWatchEvent extends FileSystemWatchEventBase {
  readonly type: 'overflow';
  readonly kind: null;
  readonly destinationPath: null;
  readonly version: null;
  readonly previousVersion: null;
}

export type FileSystemWatchEvent = FileSystemEntryWatchEvent | FileSystemOverflowWatchEvent;

export type FileSystemWatchListener = (event: FileSystemWatchEvent) => void;
export type FileSystemWatchErrorListener = (error: FsError) => void;

export interface FileSystemWatchOptions {
  readonly onError?: FileSystemWatchErrorListener;
}

export interface FileSystemWatchSubscription {
  readonly closed: boolean;
  /** Resolves after the backend watch is installed and no initial event can be missed. */
  readonly ready: Promise<void>;
  /** Idempotent and awaitable so resource release can join provider shutdown. */
  dispose(): Promise<void>;
}

/**
 * Correctness-first filesystem contract. Every logical path has exactly one
 * kind and one byte payload; conditional writes and lifecycle disposal are
 * mandatory rather than optional provider extensions.
 */
export interface FileSystemProviderV2 {
  readonly id: string;
  readonly label: string;
  readonly capabilities: FileSystemProviderCapabilities;

  /** Absence is represented only by null; permission/I/O/wrong-kind errors throw FsError. */
  stat(path: WorkspacePath): Promise<FileSystemEntrySnapshot | null>;
  /** Absence is represented only by null; a directory at path is type-mismatch. */
  readFile(path: WorkspacePath): Promise<FileSystemFileRead | null>;
  /** Missing paths and file paths throw; results are canonical and deterministic. */
  readDirectory(path: WorkspacePath): Promise<readonly FileSystemEntrySnapshot[]>;

  writeFile(
    path: WorkspacePath,
    data: ArrayBuffer | Uint8Array,
    options?: FileSystemWriteOptions,
  ): Promise<FileSystemFileSnapshot>;
  createDirectory(
    path: WorkspacePath,
    options?: FileSystemCreateDirectoryOptions,
  ): Promise<FileSystemDirectorySnapshot>;
  remove(path: WorkspacePath, options?: FileSystemRemoveOptions): Promise<FileSystemRemoveResult>;
  move(
    oldPath: WorkspacePath,
    newPath: WorkspacePath,
    options?: FileSystemMoveOptions,
  ): Promise<FileSystemEntrySnapshot>;

  snapshot(): Promise<FileSystemSnapshot>;
  /**
   * Always returns a disposable subscription. When `capabilities.watch` is
   * false, `ready` rejects with `FsError('not-supported')` and `onError`
   * observes the same failure; callers can therefore use one cleanup path.
   */
  watch(
    listener: FileSystemWatchListener,
    options?: FileSystemWatchOptions,
  ): FileSystemWatchSubscription;
  dispose(): Promise<void>;
}
