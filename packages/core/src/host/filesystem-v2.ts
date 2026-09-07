import type {
  FileSystemCreateDirectoryOptions,
  FileSystemDirectorySnapshot,
  FileSystemEntrySnapshot,
  FileSystemFileRead,
  FileSystemFileSnapshot,
  FileSystemMoveOptions,
  FileSystemProviderCapabilities,
  FileSystemRemoveOptions,
  FileSystemRemoveResult,
  FileSystemSnapshot,
  FileSystemWatchEvent,
  FileSystemWriteOptions,
  SerializedFsError,
  WorkspacePath,
} from '../filesystem/index.js';

/** File size and per-message size are deliberately separate budgets. */
export const FILE_SYSTEM_TRANSFER_LIMITS = Object.freeze({
  fileBytes: 1024 * 1024 * 1024,
  chunkBytes: 4 * 1024 * 1024,
  totalBytes: 2 * 1024 * 1024 * 1024,
  transfers: 4,
  idleMs: 120_000,
  lifetimeMs: 15 * 60_000,
});

export interface HostFileSystemReadTransfer {
  readonly transferId: string;
  readonly entry: FileSystemFileSnapshot;
}

/** Stable capabilities shared by the Electron v2 client and native backend. */
export const ELECTRON_FILE_SYSTEM_V2_CAPABILITIES: FileSystemProviderCapabilities = Object.freeze({
  writeAtomicity: 'process',
  moveAtomicity: 'process',
  snapshotAtomicity: 'process',
  conditionalWrite: 'process',
  recursiveRemove: true,
  watch: true,
  caseSensitivity: 'platform',
  symlinkPolicy: 'follow-contained',
  durability: 'best-effort',
});

/** Explicit result envelope; Electron does not preserve custom Error fields. */
export type HostFileSystemV2Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SerializedFsError };

export interface HostFileSystemV2OpenRequest {
  readonly instanceId: string;
  /** Main-owned persisted workspace authority, never an absolute path. */
  readonly providerId: string;
  readonly label: string;
}

export type HostFileSystemV2WatchMessage =
  | {
      readonly instanceId: string;
      readonly subscriptionId: string;
      readonly kind: 'event';
      readonly event: FileSystemWatchEvent;
    }
  | {
      readonly instanceId: string;
      readonly subscriptionId: string;
      readonly kind: 'error';
      readonly error: SerializedFsError;
    };

/** Wire-level filesystem v2 API exposed by preload. */
export interface DocBlocksHostFsV2API {
  /** Optional for compatibility with older preload versions. */
  beginRead?(
    instanceId: string,
    path: WorkspacePath,
  ): Promise<HostFileSystemV2Result<HostFileSystemReadTransfer | null>>;
  readChunk?(
    instanceId: string,
    transferId: string,
    offset: number,
  ): Promise<HostFileSystemV2Result<ArrayBuffer>>;
  beginWrite?(
    instanceId: string,
    path: WorkspacePath,
    byteLength: number,
    options?: FileSystemWriteOptions,
  ): Promise<HostFileSystemV2Result<string>>;
  writeChunk?(
    instanceId: string,
    transferId: string,
    offset: number,
    data: ArrayBuffer | Uint8Array,
  ): Promise<HostFileSystemV2Result<null>>;
  finishWrite?(
    instanceId: string,
    transferId: string,
  ): Promise<HostFileSystemV2Result<FileSystemFileSnapshot>>;
  closeTransfer?(instanceId: string, transferId: string): Promise<HostFileSystemV2Result<null>>;
  open(
    request: HostFileSystemV2OpenRequest,
  ): Promise<HostFileSystemV2Result<FileSystemProviderCapabilities>>;
  stat(
    instanceId: string,
    path: WorkspacePath,
  ): Promise<HostFileSystemV2Result<FileSystemEntrySnapshot | null>>;
  readFile(
    instanceId: string,
    path: WorkspacePath,
  ): Promise<HostFileSystemV2Result<FileSystemFileRead | null>>;
  readDirectory(
    instanceId: string,
    path: WorkspacePath,
  ): Promise<HostFileSystemV2Result<readonly FileSystemEntrySnapshot[]>>;
  writeFile(
    instanceId: string,
    path: WorkspacePath,
    data: ArrayBuffer | Uint8Array,
    options?: FileSystemWriteOptions,
  ): Promise<HostFileSystemV2Result<FileSystemFileSnapshot>>;
  createDirectory(
    instanceId: string,
    path: WorkspacePath,
    options?: FileSystemCreateDirectoryOptions,
  ): Promise<HostFileSystemV2Result<FileSystemDirectorySnapshot>>;
  remove(
    instanceId: string,
    path: WorkspacePath,
    options?: FileSystemRemoveOptions,
  ): Promise<HostFileSystemV2Result<FileSystemRemoveResult>>;
  move(
    instanceId: string,
    oldPath: WorkspacePath,
    newPath: WorkspacePath,
    options?: FileSystemMoveOptions,
  ): Promise<HostFileSystemV2Result<FileSystemEntrySnapshot>>;
  snapshot(instanceId: string): Promise<HostFileSystemV2Result<FileSystemSnapshot>>;
  watchSubscribe(instanceId: string, subscriptionId: string): Promise<HostFileSystemV2Result<null>>;
  watchUnsubscribe(
    instanceId: string,
    subscriptionId: string,
  ): Promise<HostFileSystemV2Result<null>>;
  dispose(instanceId: string): Promise<HostFileSystemV2Result<null>>;
  onWatchMessage(listener: (message: HostFileSystemV2WatchMessage) => void): () => void;
}
