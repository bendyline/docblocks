/**
 * In-memory filesystem used by transient loose-file and DBK workspaces.
 *
 * MemoryFileSystemProviderV2 is authoritative. This class is the temporary
 * text-oriented v1 facade retained while callers migrate to the byte contract.
 */

import { FsError, type FsOperation } from './fs-error.js';
import {
  MemoryFileSystemProviderV2,
  type MemoryFileSystemV2ReplacementFile,
} from './memory-provider-v2.js';
import type { FileCommitResult, FileSystemEntry, FileSystemProvider, FileMeta } from './types.js';
import { parseWorkspacePath, type WorkspacePath } from './workspace-path.js';

export type MemoryFileSystemSnapshotFile =
  | {
      readonly kind: 'text';
      readonly path: string;
      readonly content: string;
    }
  | {
      readonly kind: 'binary';
      readonly path: string;
      readonly data: ArrayBuffer | Uint8Array;
    };

/** Complete provider-relative state for a transient memory workspace. */
export interface MemoryFileSystemSnapshot {
  readonly files: readonly MemoryFileSystemSnapshotFile[];
  readonly directories?: readonly string[];
}

function canonicalPath(path: string): WorkspacePath {
  return parseWorkspacePath(path);
}

function entryPath(path: string, operation: FsOperation): WorkspacePath {
  const canonical = canonicalPath(path);
  if (!canonical) {
    throw new FsError('invalid-path', 'The workspace root is not a file entry.', {
      operation,
      path,
    });
  }
  return canonical;
}

function decode(data: ArrayBuffer): string {
  return new TextDecoder().decode(data);
}

/**
 * Legacy facade over the correctness-first memory provider.
 *
 * Synchronous seed/snapshot replacement methods remain because DBK import
 * fully stages external bytes before publishing one atomic in-memory swap.
 */
export class MemoryFileSystemProvider implements FileSystemProvider {
  public readonly id: string;
  public readonly label: string;
  public readonly v2: MemoryFileSystemProviderV2;

  public constructor(id: string, label: string) {
    this.id = id;
    this.label = label;
    this.v2 = new MemoryFileSystemProviderV2(id, label);
  }

  /** Monotonic version of the complete in-memory tree. */
  public get treeVersion(): number {
    return this.v2.mutationRevision;
  }

  /** Capture an owned deterministic copy of the complete transient tree. */
  public captureContents(): MemoryFileSystemSnapshot {
    const state = this.v2.captureState();
    return {
      files: state.files.map((file) =>
        file.payloadKind === 'text'
          ? { kind: 'text' as const, path: file.path, content: decode(file.data) }
          : { kind: 'binary' as const, path: file.path, data: file.data.slice(0) },
      ),
      directories: [...state.directories],
    };
  }

  /** Atomically replace the complete tree after validating and owning all input. */
  public replaceContents(snapshot: MemoryFileSystemSnapshot, expectedTreeVersion?: number): void {
    const files: MemoryFileSystemV2ReplacementFile[] = snapshot.files.map((file) => ({
      path: entryPath(file.path, 'write'),
      payloadKind: file.kind,
      data: file.kind === 'text' ? new TextEncoder().encode(file.content) : file.data,
    }));
    const directories = (snapshot.directories ?? []).map((path) =>
      entryPath(path, 'create-directory'),
    );
    this.v2.replaceState({ files, directories }, expectedTreeVersion);
  }

  /** Seed synchronously before publishing a transient provider to consumers. */
  public seedText(path: string, content: string): void {
    this.v2.seedText(entryPath(path, 'write'), content);
  }

  public async readFile(path: string): Promise<string | null> {
    const file = await this.v2.readFile(entryPath(path, 'read'));
    return file ? decode(file.data) : null;
  }

  public async writeFile(path: string, content: string): Promise<void> {
    await this.v2.writeText(entryPath(path, 'write'), content, { createParents: true });
  }

  public commitFile(
    path: string,
    content: string,
    expectedContent: string | null,
  ): Promise<FileCommitResult> {
    return this.v2.commitText(entryPath(path, 'write'), content, expectedContent);
  }

  public async delete(path: string): Promise<void> {
    await this.v2.remove(entryPath(path, 'remove'), { recursive: true, missing: 'ignore' });
  }

  public async rename(oldPath: string, newPath: string): Promise<void> {
    await this.v2.move(entryPath(oldPath, 'move'), entryPath(newPath, 'move'), {
      createParents: true,
    });
  }

  public async readDirectory(path: string): Promise<FileSystemEntry[]> {
    const canonical = canonicalPath(path);
    try {
      const entries = await this.v2.readDirectory(canonical);
      return entries.map((entry) => ({
        kind: entry.kind,
        name: entry.name,
        path: entry.path,
      }));
    } catch (error: unknown) {
      // Preserve the v1 missing-directory behavior only on the compatibility facade.
      if (error instanceof FsError && error.code === 'not-found') return [];
      throw error;
    }
  }

  public async exists(path: string): Promise<boolean> {
    return (await this.v2.stat(canonicalPath(path))) !== null;
  }

  public async createDirectory(path: string): Promise<void> {
    await this.v2.createDirectory(canonicalPath(path), { createParents: true });
  }

  public async stat(path: string): Promise<FileMeta | null> {
    const canonical = canonicalPath(path);
    if (!canonical) return null;
    const entry = await this.v2.stat(canonical);
    if (!entry || entry.kind !== 'file') return null;
    return {
      name: entry.name,
      path: entry.path,
      size: entry.size,
      lastModified: entry.lastModified,
    };
  }

  public async readBinary(path: string): Promise<ArrayBuffer | null> {
    const canonical = entryPath(path, 'read');
    const file = this.v2.readCompatibilityFile(canonical);
    if (!file || file.payloadKind !== 'binary') return null;
    return file.data;
  }

  public async writeBinary(path: string, data: ArrayBuffer | Uint8Array): Promise<void> {
    await this.v2.writeBinary(entryPath(path, 'write'), data, { createParents: true });
  }
}
