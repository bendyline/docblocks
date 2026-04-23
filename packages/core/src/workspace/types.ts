/**
 * Workspace — a named binding to a FileSystemProvider, representing
 * the user's current working context (a folder of markdown files).
 */

export interface WorkspaceDescriptor {
  /** Unique stable identifier (persisted in IndexedDB). */
  id: string;
  /** User-visible label. */
  name: string;
  /**
   * Provider kind:
   * - 'indexeddb' — browser-local storage (web only)
   * - 'native' — File System Access API (web Chrome/Edge only)
   * - 'electron-native' — Electron main-process native filesystem
   */
  type: 'indexeddb' | 'native' | 'electron-native';
  /** ISO timestamp of last access. */
  lastOpened: string;
  /** Absolute filesystem path for 'electron-native' workspaces. */
  rootPath?: string;
}
