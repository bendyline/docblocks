/**
 * ElectronFileSystemProvider — implements FileSystemProvider by delegating
 * to the Electron desktop host's fs IPC bridge. Every operation is scoped
 * to an opaque workspace id that the main process resolves against its
 * registered workspace authority.
 *
 * This file has no Electron dependency — it is a pure IPC client that
 * relies on the `docBlocksHost` global installed by the preload script.
 */

import type { FileCommitResult, FileSystemProvider, FileSystemEntry, FileMeta } from './types.js';
import { maybeGetDocBlocksHost } from '../host/index.js';
import type { DocBlocksHostFsAPI } from '../host/types.js';
import { ElectronFileSystemProviderV2 } from './electron-provider-v2.js';

export { isElectronHost } from '../host/index.js';

function getHostFs(): DocBlocksHostFsAPI {
  const host = maybeGetDocBlocksHost();
  if (!host) {
    throw new Error(
      'ElectronFileSystemProvider: docBlocksHost is not available — not running under Electron?',
    );
  }
  return host.fs;
}

export class ElectronFileSystemProvider implements FileSystemProvider {
  readonly id: string;
  readonly label: string;
  readonly v2: ElectronFileSystemProviderV2;

  private readonly rootPath: string;

  constructor(id: string, label: string, rootPath: string) {
    this.id = id;
    this.label = label;
    this.rootPath = rootPath;
    this.v2 = new ElectronFileSystemProviderV2(id, label, rootPath);
  }

  /** Absolute path this provider is rooted at. */
  getRootPath(): string {
    return this.rootPath;
  }

  readFile(path: string): Promise<string | null> {
    return getHostFs().readFile(this.id, path);
  }

  writeFile(path: string, content: string): Promise<void> {
    return getHostFs().writeFile(this.id, path, content);
  }

  commitFile(
    path: string,
    content: string,
    expectedContent: string | null,
  ): Promise<FileCommitResult> {
    return getHostFs().commitFile(this.id, path, content, expectedContent);
  }

  delete(path: string): Promise<void> {
    return getHostFs().delete(this.id, path);
  }

  rename(oldPath: string, newPath: string): Promise<void> {
    return getHostFs().rename(this.id, oldPath, newPath);
  }

  readDirectory(path: string): Promise<FileSystemEntry[]> {
    return getHostFs().readDirectory(this.id, path);
  }

  exists(path: string): Promise<boolean> {
    return getHostFs().exists(this.id, path);
  }

  createDirectory(path: string): Promise<void> {
    return getHostFs().createDirectory(this.id, path);
  }

  stat(path: string): Promise<FileMeta | null> {
    return getHostFs().stat(this.id, path);
  }

  readBinary(path: string): Promise<ArrayBuffer | null> {
    return getHostFs().readBinary(this.id, path);
  }

  writeBinary(path: string, data: ArrayBuffer | Uint8Array): Promise<void> {
    return getHostFs().writeBinary(this.id, path, data);
  }

  /** Subscribe to external change notifications under this root. */
  watch(onChange: (changedPath: string) => void): () => void {
    return getHostFs().watch(this.id, onChange);
  }
}
