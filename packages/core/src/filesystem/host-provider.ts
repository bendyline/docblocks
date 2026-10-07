import { maybeGetDocBlocksHost } from '../host/index.js';
import { ELECTRON_FILE_SYSTEM_V2_CAPABILITIES } from '../host/filesystem-v2.js';
import { FsError } from './fs-error.js';
import { HostFileSystemProviderV2, type HostFileSystemClientOptions } from './host-provider-v2.js';
import type { FileCommitResult, FileMeta, FileSystemEntry, FileSystemProvider } from './types.js';
import { parseWorkspacePath } from './workspace-path.js';
import { decodeUtf8Text } from './utf8.js';

/** Temporary text facade; all storage and conditional mutation is owned by v2. */
export class HostFileSystemProvider implements FileSystemProvider {
  public readonly v2: HostFileSystemProviderV2;

  public constructor(
    public readonly id: string,
    public readonly label: string,
    private readonly rootPath: string,
    options?: HostFileSystemClientOptions,
  ) {
    const host = maybeGetDocBlocksHost()?.fsV2;
    this.v2 = new HostFileSystemProviderV2(
      id,
      label,
      rootPath,
      options ?? {
        capabilities: host?.capabilitiesFor?.(id) ?? ELECTRON_FILE_SYSTEM_V2_CAPABILITIES,
        limits: host?.transferLimits,
      },
    );
  }

  public getRootPath(): string {
    return this.rootPath;
  }

  public async readFile(path: string): Promise<string | null> {
    const file = await this.v2.readFile(parseWorkspacePath(path));
    return file ? decodeUtf8Text(file.data, { label: 'The file', operation: 'read', path }) : null;
  }

  public async writeFile(path: string, content: string): Promise<void> {
    await this.v2.writeFile(parseWorkspacePath(path), new TextEncoder().encode(content), {
      createParents: true,
    });
  }

  public async commitFile(
    path: string,
    content: string,
    expectedContent: string | null,
  ): Promise<FileCommitResult> {
    const canonical = parseWorkspacePath(path);
    const current = await this.v2.readFile(canonical);
    const actual = current
      ? decodeUtf8Text(current.data, { label: 'The file', operation: 'read', path })
      : null;
    if (actual !== expectedContent)
      return { status: 'conflict', content: actual, version: current?.entry.version ?? null };
    try {
      const written = await this.v2.writeFile(canonical, new TextEncoder().encode(content), {
        createParents: true,
        expectedVersion: current?.entry.version ?? null,
      });
      return { status: 'committed', version: written.version };
    } catch (error: unknown) {
      if (!(error instanceof FsError && error.code === 'conflict')) throw error;
      const external = await this.v2.readFile(canonical);
      return {
        status: 'conflict',
        content: external
          ? decodeUtf8Text(external.data, { label: 'The file', operation: 'read', path })
          : null,
        version: external?.entry.version ?? null,
      };
    }
  }

  public async delete(path: string): Promise<void> {
    await this.v2.remove(parseWorkspacePath(path), { recursive: true, missing: 'ignore' });
  }
  public async rename(from: string, to: string): Promise<void> {
    await this.v2.move(parseWorkspacePath(from), parseWorkspacePath(to), { createParents: true });
  }
  public async readDirectory(path: string): Promise<FileSystemEntry[]> {
    return (await this.v2.readDirectory(parseWorkspacePath(path))).map(
      ({ kind, name, path: entryPath }) => ({ kind, name, path: entryPath }),
    );
  }
  public async exists(path: string): Promise<boolean> {
    return (await this.v2.stat(parseWorkspacePath(path))) !== null;
  }
  public async createDirectory(path: string): Promise<void> {
    await this.v2.createDirectory(parseWorkspacePath(path), { createParents: true });
  }
  public async stat(path: string): Promise<FileMeta | null> {
    const entry = await this.v2.stat(parseWorkspacePath(path));
    return entry?.kind === 'file'
      ? { name: entry.name, path: entry.path, size: entry.size, lastModified: entry.lastModified }
      : null;
  }
  public async readBinary(path: string): Promise<ArrayBuffer | null> {
    return (await this.v2.readFile(parseWorkspacePath(path)))?.data ?? null;
  }
  public async writeBinary(path: string, data: ArrayBuffer | Uint8Array): Promise<void> {
    await this.v2.writeFile(parseWorkspacePath(path), data, { createParents: true });
  }
}
