/**
 * Origin of a transient workspace — records where its contents came from and
 * how to save them back. Set only on `type: 'transient'` workspaces.
 * - 'loose-file' — a single markdown file opened from the OS (Electron);
 *   edits write back through an owner-scoped `resourceId` grant.
 * - 'dbk' — a `.dbk`/zip bundle unpacked into memory (Electron); edits are
 *   re-zipped and written back through an owner-scoped resource grant.
 * - 'web-file' — a single markdown file launched into the installed web app
 *   (File Handling API); edits write back through `handle`.
 * - 'web-dbk' — a `.dbk`/zip bundle launched into the installed web app;
 *   edits are re-zipped and written back through `handle`.
 *
 * The web variants hold a live `FileSystemFileHandle`. That is safe because
 * transient descriptors are never persisted — they live only in the
 * in-memory registry (see workspace-manager) for the current page session.
 */
export type TransientOrigin =
  | { kind: 'loose-file'; resourceId: string }
  | {
      kind: 'dbk';
      resourceId: string;
      /** SHA-256 of the last bundle version acknowledged by the host. */
      version: string | null;
    }
  | { kind: 'web-file'; handle: FileSystemFileHandle; name: string }
  | {
      kind: 'web-dbk';
      handle: FileSystemFileHandle;
      name: string;
      /** SHA-256 of the last bundle version observed on disk. */
      version: string | null;
    };

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
   * - 'transient' — session-only, in-memory (a loose file/`.dbk` opened from
   *   the OS, or a document copied from a shared URL). Never persisted; its
   *   provider lives in an in-memory registry (see workspace-manager). An
   *   `origin` is present only when changes can be saved back externally.
   */
  type: 'indexeddb' | 'native' | 'electron-native' | 'transient';
  /** ISO timestamp of last access. */
  lastOpened: string;
  /** Absolute filesystem path for 'electron-native' workspaces. */
  rootPath?: string;
  /** For 'transient' workspaces: where the contents came from / save back to. */
  origin?: TransientOrigin;
  /**
   * Per-workspace override for the global versioning preference. When
   * `'inherit'` (or absent), the global preference applies. `'on'` /
   * `'off'` force the corresponding behavior regardless of the global
   * setting. See `resolveVersioningEnabled` in the preferences module.
   */
  versioningOverride?: 'inherit' | 'on' | 'off';
}
