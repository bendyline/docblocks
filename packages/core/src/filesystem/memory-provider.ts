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
import { decodeUtf8Text } from './utf8.js';

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

/**
 * Canonicalize and reject the root eagerly.
 *
 * Only the synchronous staging entry points need this: they must validate every
 * input before `replaceState` swaps the tree, so they cannot rely on the v2
 * authority to reject the root mid-swap. The async provider methods pass paths
 * straight through, letting v2 state root policy once for every facade.
 */
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

/**
 * Byte-authoritative entries may hold payloads that are not valid UTF-8. A
 * lossy decode would hand the caller replacement characters that a later save
 * writes back over the user's original bytes, so surface the fault instead.
 */
function decode(data: ArrayBuffer, path?: WorkspacePath): string {
  return decodeUtf8Text(data, { label: 'The file', operation: 'read', path });
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
          ? { kind: 'text' as const, path: file.path, content: decode(file.data, file.path) }
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
    const canonical = canonicalPath(path);
    const file = await this.v2.readFile(canonical);
    return file ? decode(file.data, canonical) : null;
  }

  public async writeFile(path: string, content: string): Promise<void> {
    await this.v2.writeText(canonicalPath(path), content, { createParents: true });
  }

  public commitFile(
    path: string,
    content: string,
    expectedContent: string | null,
  ): Promise<FileCommitResult> {
    return this.v2.commitText(canonicalPath(path), content, expectedContent);
  }

  public async delete(path: string): Promise<void> {
    await this.v2.remove(canonicalPath(path), { recursive: true, missing: 'ignore' });
  }

  public async rename(oldPath: string, newPath: string): Promise<void> {
    await this.v2.move(canonicalPath(oldPath), canonicalPath(newPath), {
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
    const entry = await this.v2.stat(canonicalPath(path));
    if (!entry || entry.kind !== 'file') return null;
    return {
      name: entry.name,
      path: entry.path,
      size: entry.size,
      lastModified: entry.lastModified,
    };
  }

  /**
   * Every stored file is bytes, so every stored file is readable as binary.
   * `payloadKind` records how a file was written for DBK export fidelity; it is
   * not a filter. Gating on it made `readBinary` report an existing text file as
   * missing, which no other provider does and which callers read as "no file".
   */
  public async readBinary(path: string): Promise<ArrayBuffer | null> {
    return this.v2.readCompatibilityFile(canonicalPath(path))?.data ?? null;
  }

  public async writeBinary(path: string, data: ArrayBuffer | Uint8Array): Promise<void> {
    await this.v2.writeBinary(canonicalPath(path), data, { createParents: true });
  }
}
