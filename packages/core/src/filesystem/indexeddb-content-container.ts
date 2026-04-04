/**
 * IndexedDBContentContainer — a ContentContainer backed by IndexedDB.
 *
 * Uses a dedicated IndexedDBFileSystemProvider instance (separate store)
 * to persist media files across page refreshes.
 */

import type { ContentContainer, ContentEntry } from '@bendyline/squisq/storage';
import { findDocumentPath } from '@bendyline/squisq/storage';
import { IndexedDBFileSystemProvider } from './indexeddb-provider.js';

// ── MIME type guessing ─────────────────────────────────────────────

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

// ── Implementation ─────────────────────────────────────────────────

export class IndexedDBContentContainer implements ContentContainer {
  private provider: IndexedDBFileSystemProvider;

  constructor(workspaceId: string) {
    this.provider = new IndexedDBFileSystemProvider(`${workspaceId}-media`, 'Media Storage');
  }

  async readFile(path: string): Promise<ArrayBuffer | null> {
    return this.provider.readBinary(path);
  }

  async writeFile(path: string, data: ArrayBuffer | Uint8Array, _mimeType?: string): Promise<void> {
    await this.provider.writeBinary(path, data);
  }

  async removeFile(path: string): Promise<void> {
    await this.provider.delete(path);
  }

  async listFiles(prefix?: string): Promise<ContentEntry[]> {
    const entries: ContentEntry[] = [];
    const walk = async (dir: string) => {
      const children = await this.provider.readDirectory(dir);
      for (const child of children) {
        if (child.kind === 'directory') {
          await walk(child.path);
        } else {
          const filePath = child.path.replace(/^\//, '');
          if (prefix && !filePath.startsWith(prefix)) continue;
          const meta = await this.provider.stat(child.path);
          entries.push({
            path: filePath,
            mimeType: guessMimeType(filePath),
            size: meta?.size ?? 0,
          });
        }
      }
    };
    await walk('/');
    return entries;
  }

  async exists(path: string): Promise<boolean> {
    return this.provider.exists(path);
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
