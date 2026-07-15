/**
 * Legacy FileSystemProvider facade over the revisioned IndexedDB authority.
 *
 * The old `fs:*` namespace is migration input only. Keeping this facade as an
 * adapter prevents current callers from recreating a second persistent source
 * of truth while the workspace moves to FileSystemProviderV2.
 */

import type { FileCommitResult, FileMeta, FileSystemEntry, FileSystemProvider } from './types.js';
import { FsError, type FsOperation } from './fs-error.js';
import { parseWorkspacePath, type WorkspacePath } from './workspace-path.js';
import {
  RawIndexedDBFileSystemStore,
  indexedDBWorkspaceDatabaseName,
  type IndexedDBFileSystemStore,
} from './indexeddb-store.js';
import { IndexedDBFileSystemProviderV2 } from './indexeddb-provider-v2.js';

export interface IndexedDBFileSystemProviderOptions {
  /** Injectable transaction store for deterministic fault/concurrency tests. */
  store?: IndexedDBFileSystemStore;
  /** Injectable metadata clock. */
  now?: () => Date;
}

export class IndexedDBFileSystemProvider implements FileSystemProvider {
  public readonly id: string;
  public readonly label: string;
  public readonly v2: IndexedDBFileSystemProviderV2;

  private disposed = false;

  public constructor(id: string, label: string, options: IndexedDBFileSystemProviderOptions = {}) {
    this.id = id;
    this.label = label;
    const store =
      options.store ?? new RawIndexedDBFileSystemStore(indexedDBWorkspaceDatabaseName(id), 'files');
    this.v2 = new IndexedDBFileSystemProviderV2(id, label, {
      store,
      now: options.now,
      closeStoreOnDispose: true,
    });
  }

  /** Release the underlying database connection after accepted work settles. */
  public dispose(): Promise<void> {
    this.disposed = true;
    return this.v2.dispose();
  }

  public async readFile(path: string): Promise<string | null> {
    this.assertOpen('read');
    const read = await this.v2.readFile(this.path(path, false, 'read'));
    return read ? new TextDecoder().decode(read.data) : null;
  }

  public async writeFile(path: string, content: string): Promise<void> {
    this.assertOpen('write');
    await this.v2.writeFile(this.path(path, false, 'write'), new TextEncoder().encode(content), {
      createParents: true,
    });
  }

  public async commitFile(
    path: string,
    content: string,
    expectedContent: string | null,
  ): Promise<FileCommitResult> {
    this.assertOpen('write');
    const canonical = this.path(path, false, 'write');
    const current = await this.v2.readFile(canonical);
    const currentContent = current ? new TextDecoder().decode(current.data) : null;
    if (currentContent !== expectedContent && currentContent !== content) {
      return {
        status: 'conflict',
        content: currentContent,
        version: current?.entry.version ?? null,
      };
    }

    try {
      const committed = await this.v2.writeFile(canonical, new TextEncoder().encode(content), {
        createParents: true,
        expectedVersion: current?.entry.version ?? null,
      });
      return { status: 'committed', version: committed.version };
    } catch (error: unknown) {
      if (!(error instanceof FsError) || error.code !== 'conflict') throw error;
      const latest = await this.v2.readFile(canonical);
      return {
        status: 'conflict',
        content: latest ? new TextDecoder().decode(latest.data) : null,
        version: latest?.entry.version ?? null,
      };
    }
  }

  public async delete(path: string): Promise<void> {
    this.assertOpen('remove');
    await this.v2.remove(this.path(path, false, 'remove'), {
      recursive: true,
      missing: 'ignore',
    });
  }

  public async rename(oldPath: string, newPath: string): Promise<void> {
    this.assertOpen('move');
    await this.v2.move(this.path(oldPath, false, 'move'), this.path(newPath, false, 'move'), {
      createParents: true,
    });
  }

  public async readDirectory(path: string): Promise<FileSystemEntry[]> {
    this.assertOpen('list');
    try {
      const entries = await this.v2.readDirectory(this.path(path, true, 'list'));
      return entries.map((entry) => ({
        kind: entry.kind,
        name: entry.name,
        path: entry.path,
      }));
    } catch (error: unknown) {
      if (error instanceof FsError && error.code === 'not-found') return [];
      throw error;
    }
  }

  public async exists(path: string): Promise<boolean> {
    this.assertOpen('stat');
    return (await this.v2.stat(this.path(path, true, 'stat'))) !== null;
  }

  public async createDirectory(path: string): Promise<void> {
    this.assertOpen('create-directory');
    await this.v2.createDirectory(this.path(path, false, 'create-directory'), {
      createParents: true,
      mode: 'ensure',
    });
  }

  public async stat(path: string): Promise<FileMeta | null> {
    this.assertOpen('stat');
    const entry = await this.v2.stat(this.path(path, false, 'stat'));
    if (!entry || entry.kind !== 'file') return null;
    return {
      name: entry.name,
      path: entry.path,
      size: entry.size,
      lastModified: entry.lastModified,
    };
  }

  public async readBinary(path: string): Promise<ArrayBuffer | null> {
    this.assertOpen('read');
    return (await this.v2.readFile(this.path(path, false, 'read')))?.data ?? null;
  }

  public async writeBinary(path: string, data: ArrayBuffer | Uint8Array): Promise<void> {
    this.assertOpen('write');
    await this.v2.writeFile(this.path(path, false, 'write'), data, { createParents: true });
  }

  private path(path: string, allowRoot: boolean, operation: FsOperation): WorkspacePath {
    const canonical = parseWorkspacePath(path);
    if (canonical || allowRoot) return canonical;
    throw new FsError('invalid-path', 'The filesystem root cannot be used as a mutation target.', {
      operation,
      path,
    });
  }

  private assertOpen(operation: FsOperation): void {
    if (!this.disposed) return;
    throw new FsError('closed', 'The IndexedDB filesystem provider is disposed.', { operation });
  }
}
