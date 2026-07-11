/**
 * DocBlocksHostAPI — the contract exposed by the Electron desktop shell
 * to its renderer process via contextBridge.
 *
 * This file is the single source of truth for the host ↔ renderer
 * bridge. The Electron preload script exposes an implementation matching
 * this shape; the React renderer calls it through `window.docBlocksHost`.
 */

import type { FileCommitResult, FileSystemEntry, FileMeta } from '../filesystem/types.js';
import type { DocBlocksHostFsV2API } from './filesystem-v2.js';
import type { DocBlocksHostGitAPI } from './git.js';

/** Filesystem operations scoped to a registered absolute root path. */
export interface DocBlocksHostFsAPI {
  readFile(rootPath: string, path: string): Promise<string | null>;
  writeFile(rootPath: string, path: string, content: string): Promise<void>;
  commitFile(
    rootPath: string,
    path: string,
    content: string,
    expectedContent: string | null,
  ): Promise<FileCommitResult>;
  delete(rootPath: string, path: string): Promise<void>;
  rename(rootPath: string, oldPath: string, newPath: string): Promise<void>;
  readDirectory(rootPath: string, path: string): Promise<FileSystemEntry[]>;
  exists(rootPath: string, path: string): Promise<boolean>;
  createDirectory(rootPath: string, path: string): Promise<void>;
  stat(rootPath: string, path: string): Promise<FileMeta | null>;
  readBinary(rootPath: string, path: string): Promise<ArrayBuffer | null>;
  writeBinary(rootPath: string, path: string, data: ArrayBuffer | Uint8Array): Promise<void>;
  /**
   * Subscribe to change notifications for a watched root. Returns an
   * unsubscribe function. The main process uses chokidar under the hood.
   */
  watch(rootPath: string, onChange: (path: string) => void): () => void;
}

/** Descriptor returned for an Electron-managed workspace (backed by a folder). */
export interface ElectronWorkspaceInfo {
  id: string;
  name: string;
  rootPath: string;
}

/** Workspace-management operations exposed to the renderer. */
export interface DocBlocksHostWorkspacesAPI {
  /**
   * Return the default workspace (creating DocBlocks inside the operating
   * system's Documents folder on first call, or the user's configured default).
   */
  getDefault(): Promise<ElectronWorkspaceInfo>;
  /**
   * Open the native folder picker. Returns null if the user cancels.
   * The selected folder is registered in the main process whitelist.
   */
  pickFolder(): Promise<ElectronWorkspaceInfo | null>;
  /**
   * Re-register a previously known workspace so its rootPath is trusted
   * for subsequent fs calls. Called on app startup for persisted
   * electron-native workspaces before any fs operation.
   */
  register(info: ElectronWorkspaceInfo): Promise<void>;
  /** Remove a workspace from the trusted whitelist. */
  unregister(id: string): Promise<void>;
}

/** Shell operations — reveal in Finder/Explorer, open external URLs. */
export interface DocBlocksHostShellAPI {
  /** Reveal a file (by absolute path) in the OS file manager. */
  revealInFolder(absolutePath: string): Promise<void>;
  /** Open a URL in the default browser. */
  openExternal(url: string): Promise<void>;
}

/** Native export target selection and binary file writing. */
export interface DocBlocksHostExportAPI {
  /** Resolve the remembered target for this document and output filename. */
  resolveTarget(documentId: string, filename: string): Promise<string>;
  /** Open the native Save dialog and remember the selected target. */
  pickTarget(
    documentId: string,
    filename: string,
    currentPath?: string | null,
  ): Promise<string | null>;
  /** Write an exported blob to a remembered or user-confirmed target. */
  save(
    documentId: string,
    filename: string,
    targetPath: string | null,
    data: ArrayBuffer | Uint8Array,
  ): Promise<string | null>;
}

/** System ffmpeg detection and invocation. */
export interface DocBlocksHostFfmpegAPI {
  /** True if `ffmpeg` is available on PATH (or bundled). */
  available(): Promise<boolean>;
  /** Version string from `ffmpeg -version`, or null if unavailable. */
  version(): Promise<string | null>;
  /**
   * Render a markdown file at the given absolute path to MP4 using the
   * existing squisq-video CLI pipeline. Returns the absolute path to the
   * produced MP4 file, or throws on failure.
   */
  renderVideo(
    markdownAbsolutePath: string,
    options: { fps?: number; quality?: 'draft' | 'normal' | 'high' },
  ): Promise<string>;
}

/** Auto-updater control. */
export interface DocBlocksHostUpdaterAPI {
  /** Kick off a check; resolves to true if an update is available. */
  checkForUpdates(): Promise<boolean>;
  /** Current app version string. */
  getVersion(): Promise<string>;
  /**
   * Quit the app and apply a downloaded update. Should only be called
   * after an `UpdaterStatus` of kind `'downloaded'` has been observed.
   */
  quitAndInstall(): Promise<UpdateInstallResult>;
  /**
   * Subscribe to updater status events. Returns an unsubscribe function.
   */
  onStatus(listener: (status: UpdaterStatus) => void): () => void;
}

export type UpdateInstallResult = 'installing' | 'cancelled' | 'not-ready';

export type UpdaterStatus =
  | { kind: 'checking' }
  | { kind: 'available'; version: string; releaseNotes?: string; releaseUrl?: string }
  | { kind: 'not-available' }
  | { kind: 'downloading'; percent: number }
  | { kind: 'downloaded'; version: string; releaseNotes?: string; releaseUrl?: string }
  | { kind: 'error'; message: string };

/** Menu-command events pushed from the main process to the renderer. */
export type MenuCommand =
  | 'file:new'
  | 'file:openFolder'
  | 'file:revealWorkspace'
  | 'file:settings'
  | 'git:commit'
  | 'git:push'
  | 'git:pull'
  | 'git:fetch'
  | 'git:newBranch'
  | 'git:switchBranch'
  | 'git:history'
  | 'git:clone'
  | 'git:openOnRemote'
  | 'git:createPullRequest'
  | 'help:about'
  | 'help:checkForUpdates'
  | 'help:viewOnGitHub';

/**
 * OS open-file / deep-link event resolved by the host.
 * - 'workspace-file': a file inside an already-registered workspace.
 * - 'external-file': a loose markdown file outside any workspace — opened in a
 *   transient workspace and saved straight back to `path`.
 * - 'external-bundle': a `.dbk`/zip bundle — unpacked into a transient
 *   workspace and re-zipped back to `path` on save.
 */
export type OpenRequest =
  | {
      kind: 'workspace-file';
      workspaceId: string;
      /** Slash-prefixed path relative to the workspace root. */
      path: string;
    }
  | { kind: 'external-file'; path: string; name: string }
  | { kind: 'external-bundle'; path: string; name: string };

/**
 * Read/write access to individual OS files the user has explicitly opened
 * (via "Open With" / deep link), outside the workspace-root whitelist. The
 * main process gates these to a session allowlist of opened paths.
 */
export interface DocBlocksHostExternalAPI {
  readText(path: string): Promise<string | null>;
  readBinary(path: string): Promise<ArrayBuffer | null>;
  writeText(path: string, content: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer | Uint8Array): Promise<void>;
  commitText(
    path: string,
    content: string,
    expectedContent: string | null,
  ): Promise<FileCommitResult>;
  commitBinary(
    path: string,
    data: ArrayBuffer | Uint8Array,
    expectedVersion: string | null,
  ): Promise<ExternalBinaryCommitResult>;
}

export type ExternalBinaryCommitResult =
  | { status: 'committed'; version: string }
  | { status: 'conflict'; version: string | null; data: ArrayBuffer | null };

/** Environment metadata provided by the host. */
export interface HostEnvironment {
  platform: 'darwin' | 'win32' | 'linux';
  appVersion: string;
  isDev: boolean;
}

export type HostCloseReason =
  | 'window-close'
  | 'app-quit'
  | 'update-install'
  | 'reload'
  | 'force-reload';

export interface HostPrepareCloseRequest {
  requestId: string;
  reason: HostCloseReason;
  /** Absolute epoch-millisecond deadline chosen by the main process. */
  deadline: number;
}

export type HostPrepareCloseResult =
  | { status: 'ready'; persistedRevision: number }
  | {
      status: 'blocked';
      code: 'save-failed' | 'external-conflict' | 'not-ready';
      message: string;
    };

/**
 * Main-owned close handshake. Preload privately correlates replies; the
 * renderer never chooses request or window identifiers.
 */
export interface DocBlocksHostLifecycleAPI {
  onPrepareClose(
    listener: (request: HostPrepareCloseRequest) => Promise<HostPrepareCloseResult>,
  ): () => void;
  onCancelClose(listener: (requestId: string) => void): () => void;
}

/** The full DocBlocks desktop host API. */
export interface DocBlocksHostAPI {
  env: HostEnvironment;
  fs: DocBlocksHostFsAPI;
  fsV2: DocBlocksHostFsV2API;
  external: DocBlocksHostExternalAPI;
  workspaces: DocBlocksHostWorkspacesAPI;
  shell: DocBlocksHostShellAPI;
  exports: DocBlocksHostExportAPI;
  ffmpeg: DocBlocksHostFfmpegAPI;
  git: DocBlocksHostGitAPI;
  updater: DocBlocksHostUpdaterAPI;
  lifecycle: DocBlocksHostLifecycleAPI;
  /**
   * Subscribe to menu commands dispatched by the native menu.
   * Returns an unsubscribe function.
   */
  onMenuCommand(listener: (cmd: MenuCommand) => void): () => void;
  /**
   * Subscribe to open-file / open-url requests from the OS.
   * Returns an unsubscribe function.
   */
  onOpenRequest(listener: (request: OpenRequest) => void): () => void;
}
