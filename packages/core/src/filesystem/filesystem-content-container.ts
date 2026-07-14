/**
 * FileSystemContentContainer — a ContentContainer backed by any
 * FileSystemProvider, scoped to a sub-path (e.g., ".docblocks/media/").
 *
 * Used by the Electron desktop app so media lives inside the workspace
 * folder (visible as regular files) rather than in a separate IndexedDB
 * origin that only the app can see.
 */

import type { ContentContainer, ContentEntry } from '@bendyline/squisq/storage';
import { findDocumentPath } from '@bendyline/squisq/storage';
import { FsError } from './fs-error.js';
import { getFileSystemProviderV2, type FileSystemProvider } from './types.js';
import { parseWorkspacePath, workspacePathContains, workspacePathJoin } from './workspace-path.js';

const EXTENSION_MIME_MAP: Record<string, string> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

function guessMimeType(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  const ext = path.slice(dot).toLowerCase();
  return EXTENSION_MIME_MAP[ext] ?? 'application/octet-stream';
}

function joinPrefix(prefix: string, p: string): string {
  return workspacePathJoin(parseWorkspacePath(prefix), p);
}

export class FileSystemContentContainer implements ContentContainer {
  private readonly prefix: string;

  constructor(
    private readonly provider: FileSystemProvider,
    prefix = '.docblocks/media',
  ) {
    this.prefix = parseWorkspacePath(prefix);
  }

  async readFile(path: string): Promise<ArrayBuffer | null> {
    const full = joinPrefix(this.prefix, path);
    const providerV2 = getFileSystemProviderV2(this.provider);
    if (providerV2) return (await providerV2.readFile(parseWorkspacePath(full)))?.data ?? null;
    const binary = await this.provider.readBinary(full);
    if (binary) return binary;
    // IndexedDB-backed workspaces store text via `writeFile(string)` and
    // binary via `writeBinary(ArrayBuffer)` under separate keys, so a
    // markdown file written through the text API is invisible to
    // `readBinary`. Fall back to text-then-UTF-8 so consumers like the
    // recursive HTML export can resolve sibling `.md` links uniformly
    // across browser and native workspaces.
    const text = await this.provider.readFile(full);
    if (text === null) return null;
    return new TextEncoder().encode(text).buffer as ArrayBuffer;
  }

  async writeFile(path: string, data: ArrayBuffer | Uint8Array, _mimeType?: string): Promise<void> {
    const full = joinPrefix(this.prefix, path);
    const providerV2 = getFileSystemProviderV2(this.provider);
    if (providerV2) {
      await providerV2.writeFile(parseWorkspacePath(full), data, {
        mode: 'upsert',
        createParents: true,
      });
      return;
    }
    await this.provider.writeBinary(full, data);
  }

  async removeFile(path: string): Promise<void> {
    const full = joinPrefix(this.prefix, path);
    const providerV2 = getFileSystemProviderV2(this.provider);
    if (providerV2) {
      await providerV2.remove(parseWorkspacePath(full), { missing: 'ignore' });
      return;
    }
    await this.provider.delete(full);
  }

  async listFiles(prefix?: string): Promise<ContentEntry[]> {
    const entries: ContentEntry[] = [];
    const providerV2 = getFileSystemProviderV2(this.provider);
    const root = parseWorkspacePath(this.prefix);
    type ListedEntry = {
      readonly kind: 'file' | 'directory';
      readonly path: string;
      readonly size?: number | null;
    };
    const walk = async (dir: string) => {
      let children: readonly ListedEntry[];
      try {
        children = providerV2
          ? await providerV2.readDirectory(parseWorkspacePath(dir))
          : await this.provider.readDirectory(dir);
      } catch (error: unknown) {
        // An absent container root means an empty container. Every other
        // storage fault (including a subtree disappearing mid-snapshot)
        // remains observable to backup/export callers.
        if (dir === root && error instanceof FsError && error.code === 'not-found') return;
        throw error;
      }
      for (const child of children) {
        if (child.kind === 'directory') {
          await walk(child.path);
        } else {
          const childPath = parseWorkspacePath(child.path);
          const prefixPath = parseWorkspacePath(this.prefix);
          if (!workspacePathContains(prefixPath, childPath)) continue;
          const rel = childPath === prefixPath ? '' : childPath.slice(prefixPath.length + 1);
          if (prefix && !rel.startsWith(prefix)) continue;
          const size = child.size ?? (await this.provider.stat(child.path))?.size ?? 0;
          entries.push({
            path: rel,
            mimeType: guessMimeType(rel),
            size,
          });
        }
      }
    };
    await walk(root);
    return entries;
  }

  async exists(path: string): Promise<boolean> {
    const full = joinPrefix(this.prefix, path);
    const providerV2 = getFileSystemProviderV2(this.provider);
    return providerV2
      ? (await providerV2.stat(parseWorkspacePath(full))) !== null
      : this.provider.exists(full);
  }

  async getDocumentPath(): Promise<string | null> {
    return findDocumentPath(await this.listFiles());
  }

  async readDocument(): Promise<string | null> {
    const docPath = await this.getDocumentPath();
    if (!docPath) return null;
    const data = await this.readFile(docPath);
    if (!data) return null;
    return new TextDecoder().decode(data);
  }

  async writeDocument(markdown: string, filename?: string): Promise<void> {
    const name = filename ?? 'index.md';
    const data = new TextEncoder().encode(markdown);
    await this.writeFile(name, data, 'text/markdown');
  }
}
