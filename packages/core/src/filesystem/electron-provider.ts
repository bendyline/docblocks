/**
 * ElectronFileSystemProvider — implements FileSystemProvider by delegating
 * to the Electron desktop host's fs IPC bridge. Every operation is scoped
 * to an absolute root path that the main process validates against a
 * whitelist of registered workspace roots.
 *
 * This file has no Electron dependency — it is a pure IPC client that
 * relies on the `docblocksHost` global installed by the preload script.
 */

import type { FileSystemProvider, FileSystemEntry, FileMeta } from './types.js';
import { maybeGetDocblocksHost } from '../host/index.js';
import type { DocblocksHostFsAPI } from '../host/types.js';

export { isElectronHost } from '../host/index.js';

function getHostFs(): DocblocksHostFsAPI {
  const host = maybeGetDocblocksHost();
  if (!host) {
    throw new Error(
      'ElectronFileSystemProvider: docblocksHost is not available — not running under Electron?',
    );
  }
  return host.fs;
}

export class ElectronFileSystemProvider implements FileSystemProvider {
  readonly id: string;
  readonly label: string;

  private readonly rootPath: string;

  constructor(id: string, label: string, rootPath: string) {
    this.id = id;
    this.label = label;
    this.rootPath = rootPath;
  }

  /** Absolute path this provider is rooted at. */
  getRootPath(): string {
    return this.rootPath;
  }

  readFile(path: string): Promise<string | null> {
    return getHostFs().readFile(this.rootPath, path);
  }

  writeFile(path: string, content: string): Promise<void> {
    return getHostFs().writeFile(this.rootPath, path, content);
  }

  delete(path: string): Promise<void> {
    return getHostFs().delete(this.rootPath, path);
  }

  rename(oldPath: string, newPath: string): Promise<void> {
    return getHostFs().rename(this.rootPath, oldPath, newPath);
  }

  readDirectory(path: string): Promise<FileSystemEntry[]> {
    return getHostFs().readDirectory(this.rootPath, path);
  }

  exists(path: string): Promise<boolean> {
    return getHostFs().exists(this.rootPath, path);
  }

  createDirectory(path: string): Promise<void> {
    return getHostFs().createDirectory(this.rootPath, path);
  }

  stat(path: string): Promise<FileMeta | null> {
    return getHostFs().stat(this.rootPath, path);
  }

  readBinary(path: string): Promise<ArrayBuffer | null> {
    return getHostFs().readBinary(this.rootPath, path);
  }

  writeBinary(path: string, data: ArrayBuffer | Uint8Array): Promise<void> {
    return getHostFs().writeBinary(this.rootPath, path, data);
  }

  /** Subscribe to external change notifications under this root. */
  watch(onChange: (changedPath: string) => void): () => void {
    return getHostFs().watch(this.rootPath, onChange);
  }
}
