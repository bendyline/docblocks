/**
 * DocBlocksHostAPI — the contract exposed by the Electron desktop shell
 * to its renderer process via contextBridge.
 *
 * This file is the single source of truth for the host ↔ renderer
 * bridge. The Electron preload script exposes an implementation matching
 * this shape; the React renderer calls it through `window.docBlocksHost`.
 */

import type { FileSystemEntry, FileMeta } from '../filesystem/types.js';

/** Filesystem operations scoped to a registered absolute root path. */
export interface DocBlocksHostFsAPI {
  readFile(rootPath: string, path: string): Promise<string | null>;
  writeFile(rootPath: string, path: string, content: string): Promise<void>;
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
   * Return the default workspace (creating ~/Documents/DocBlocks on first
   * call, or the user's configured default).
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
  quitAndInstall(): Promise<void>;
  /**
   * Subscribe to updater status events. Returns an unsubscribe function.
   */
  onStatus(listener: (status: UpdaterStatus) => void): () => void;
}

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
  | 'help:about'
  | 'help:checkForUpdates'
  | 'help:viewOnGitHub';

/** Deep-link event: the user opened a docblocks:// URL or dropped a file. */
export interface OpenRequest {
  /** For docblocks:// URLs — the full URL string. */
  url?: string;
  /** For file drops / open-with — absolute path to the file. */
  filePath?: string;
}

/** Environment metadata provided by the host. */
export interface HostEnvironment {
  platform: 'darwin' | 'win32' | 'linux';
  appVersion: string;
  isDev: boolean;
}

/** The full DocBlocks desktop host API. */
export interface DocBlocksHostAPI {
  env: HostEnvironment;
  fs: DocBlocksHostFsAPI;
  workspaces: DocBlocksHostWorkspacesAPI;
  shell: DocBlocksHostShellAPI;
  ffmpeg: DocBlocksHostFfmpegAPI;
  updater: DocBlocksHostUpdaterAPI;
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
