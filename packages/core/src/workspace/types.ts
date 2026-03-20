/**
 * Workspace — a named binding to a FileSystemProvider, representing
 * the user's current working context (a folder of markdown files).
 */

export interface WorkspaceDescriptor {
  /** Unique stable identifier (persisted in IndexedDB). */
  id: string;
  /** User-visible label. */
  name: string;
  /** 'indexeddb' for browser-local storage, 'native' for File System Access API. */
  type: 'indexeddb' | 'native';
  /** ISO timestamp of last access. */
  lastOpened: string;
}
