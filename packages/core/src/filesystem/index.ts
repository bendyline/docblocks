export type {
  FileSystemProvider,
  FileSystemProviderWithV2,
  FileSystemEntry,
  FileEntry,
  FolderEntry,
  FileMeta,
  FileCommitResult,
} from './types.js';
export { getFileSystemProviderV2, hasFileSystemProviderV2 } from './types.js';

export {
  WORKSPACE_ROOT,
  parseWorkspacePath,
  tryParseWorkspacePath,
  workspacePathToLegacy,
  workspacePathJoin,
  workspacePathDirname,
  workspacePathBasename,
  workspacePathContains,
  type WorkspacePath,
} from './workspace-path.js';
export {
  FsError,
  mapDomExceptionToFsErrorCode,
  mapNodeErrorCodeToFsErrorCode,
  isSerializedFsError,
  isQuotaExceededError,
  serializeFsError,
  deserializeFsError,
  fsErrorFromUnknown,
  type FsErrorCode,
  type FsOperation,
  type SerializedFsError,
  type FsErrorContext,
} from './fs-error.js';
export { decodeUtf8Text, type DecodeUtf8TextOptions } from './utf8.js';
export type {
  FileSystemProviderV2,
  FileSystemProviderCapabilities,
  FileSystemVersion,
  FileSystemConditionalWriteStrength,
  FileSystemSymlinkPolicy,
  FileSystemAtomicity,
  FileSystemCaseSensitivity,
  FileSystemDurability,
  FileSystemEntrySnapshot,
  FileSystemFileSnapshot,
  FileSystemDirectorySnapshot,
  FileSystemFileRead,
  FileSystemSnapshot,
  FileSystemSnapshotEntry,
  FileSystemSnapshotFile,
  FileSystemWriteMode,
  FileSystemWriteOptions,
  FileSystemCreateDirectoryMode,
  FileSystemCreateDirectoryOptions,
  FileSystemRemoveOptions,
  FileSystemRemoveResult,
  FileSystemMoveOptions,
  FileSystemWatchEventType,
  FileSystemWatchEventOrigin,
  FileSystemWatchEvent,
  FileSystemEntryWatchEvent,
  FileSystemOverflowWatchEvent,
  FileSystemWatchListener,
  FileSystemWatchErrorListener,
  FileSystemWatchOptions,
  FileSystemWatchSubscription,
} from './v2.js';
export { parseFileSystemVersion, tryParseFileSystemVersion } from './v2.js';
export {
  MemoryFileSystemProviderV2,
  type MemoryFilePayloadKind,
  type MemoryFileSystemV2CompatibilityFile,
  type MemoryFileSystemV2Replacement,
  type MemoryFileSystemV2ReplacementFile,
  type MemoryFileSystemV2State,
  type MemoryFileSystemV2StateFile,
} from './memory-provider-v2.js';
export {
  IndexedDBFileSystemProviderV2,
  type IndexedDBFileSystemProviderV2Options,
  type IndexedDBLegacyConflictReason,
  type IndexedDBLegacyConflictResolution,
  type IndexedDBLegacyMigrationConflict,
  type IndexedDBLegacyRecoveryCandidate,
  type IndexedDBLegacyRecoveryKind,
} from './indexeddb-provider-v2.js';
export {
  LegacyFileSystemProviderV2Adapter,
  type LegacyFilePayloadModel,
  type LegacyFileSystemProviderV2AdapterOptions,
} from './legacy-v2-adapter.js';

export { IndexedDBFileSystemProvider } from './indexeddb-provider.js';
export {
  MemoryFileSystemProvider,
  type MemoryFileSystemSnapshot,
  type MemoryFileSystemSnapshotFile,
} from './memory-provider.js';
export {
  createDbkWorkspaceSnapshot,
  replaceMemoryWorkspaceFromDbk,
  type DbkWorkspaceAssetLayout,
  type DbkWorkspaceSnapshot,
  type DbkWorkspaceSnapshotOptions,
} from './dbk-workspace.js';
export { IndexedDBContentContainer } from './indexeddb-content-container.js';
export { FileSystemContentContainer } from './filesystem-content-container.js';
export { createFileMediaProvider } from './file-media-provider.js';
export { documentCompanionPath, moveFileSystemEntry } from './move-entry.js';
export {
  FileSystemMoveRecoveryError,
  FileSystemPartialMoveError,
  isFileSystemMoveRecoveryError,
  isFileSystemMoveStateError,
  isFileSystemPartialMoveError,
  describeEntryMove,
  describePartialMove,
  type FileSystemEntryMoveState,
  type FileSystemMoveLocation,
  type FileSystemPartialMoveState,
  type FileSystemPathPresence,
} from './move-error.js';

export {
  NativeFileSystemProvider,
  isNativeFileSystemSupported,
  openNativeFolder,
  restoreNativeFolder,
  storeDirectoryHandle,
  loadDirectoryHandle,
  removeDirectoryHandle,
} from './native-provider.js';
export {
  NativeFileSystemProviderV2,
  NativeFileSystemMoveRecoveryError,
  type NativeFileSystemMovePathState,
  type NativeFileSystemMoveRecoveryState,
} from './native-provider-v2.js';

export { ElectronFileSystemProvider, isElectronHost } from './electron-provider.js';
export { ElectronFileSystemProviderV2 } from './electron-provider-v2.js';
