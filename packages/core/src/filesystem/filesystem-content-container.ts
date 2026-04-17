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
import type { FileSystemProvider } from './types.js';

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
  const clean = p.replace(/^\/+/, '');
  return prefix.replace(/\/+$/, '') + '/' + clean;
}

export class FileSystemContentContainer implements ContentContainer {
  private readonly prefix: string;

  constructor(
    private readonly provider: FileSystemProvider,
    prefix = '.docblocks/media',
  ) {
    this.prefix = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  }

  async readFile(path: string): Promise<ArrayBuffer | null> {
    return this.provider.readBinary(joinPrefix(this.prefix, path));
  }

  async writeFile(path: string, data: ArrayBuffer | Uint8Array, _mimeType?: string): Promise<void> {
    await this.provider.writeBinary(joinPrefix(this.prefix, path), data);
  }

  async removeFile(path: string): Promise<void> {
    await this.provider.delete(joinPrefix(this.prefix, path));
  }

  async listFiles(prefix?: string): Promise<ContentEntry[]> {
    const entries: ContentEntry[] = [];
    const walk = async (dir: string) => {
      let children;
      try {
        children = await this.provider.readDirectory(dir);
      } catch {
        return;
      }
      for (const child of children) {
        if (child.kind === 'directory') {
          await walk(child.path);
        } else {
          const rel = child.path.replace(new RegExp('^/?' + this.prefix + '/?'), '');
          if (prefix && !rel.startsWith(prefix)) continue;
          const meta = await this.provider.stat(child.path);
          entries.push({
            path: rel,
            mimeType: guessMimeType(rel),
            size: meta?.size ?? 0,
          });
        }
      }
    };
    await walk('/' + this.prefix);
    return entries;
  }

  async exists(path: string): Promise<boolean> {
    return this.provider.exists(joinPrefix(this.prefix, path));
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
