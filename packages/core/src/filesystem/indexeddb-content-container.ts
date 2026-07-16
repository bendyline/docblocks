/**
 * IndexedDBContentContainer — a ContentContainer backed by IndexedDB.
 *
 * Uses a dedicated IndexedDBFileSystemProvider instance (separate store)
 * to persist media files across page refreshes.
 */

import type { ContentContainer, ContentEntry } from '@bendyline/squisq/storage';
import { findDocumentPath } from '@bendyline/squisq/storage';
import { IndexedDBFileSystemProviderV2 } from './indexeddb-provider-v2.js';
import { parseWorkspacePath, WORKSPACE_ROOT } from './workspace-path.js';
import { guessMimeType } from './internal/mime.js';

// ── Implementation ─────────────────────────────────────────────────

export class IndexedDBContentContainer implements ContentContainer {
  private readonly provider: IndexedDBFileSystemProviderV2;

  constructor(workspaceId: string) {
    this.provider = new IndexedDBFileSystemProviderV2(`${workspaceId}-media`, 'Media Storage');
  }

  async readFile(path: string): Promise<ArrayBuffer | null> {
    return (await this.provider.readFile(parseWorkspacePath(path)))?.data ?? null;
  }

  async writeFile(path: string, data: ArrayBuffer | Uint8Array, _mimeType?: string): Promise<void> {
    await this.provider.writeFile(parseWorkspacePath(path), data, {
      mode: 'upsert',
      createParents: true,
    });
  }

  async removeFile(path: string): Promise<void> {
    await this.provider.remove(parseWorkspacePath(path), { missing: 'ignore' });
  }

  async listFiles(prefix?: string): Promise<ContentEntry[]> {
    const entries: ContentEntry[] = [];
    const walk = async (dir: string) => {
      const children = await this.provider.readDirectory(parseWorkspacePath(dir));
      for (const child of children) {
        if (child.kind === 'directory') {
          await walk(child.path);
        } else {
          const filePath = child.path;
          if (prefix && !filePath.startsWith(prefix)) continue;
          entries.push({
            path: filePath,
            mimeType: guessMimeType(filePath),
            size: child.size,
          });
        }
      }
    };
    await walk(WORKSPACE_ROOT);
    return entries;
  }

  async exists(path: string): Promise<boolean> {
    return (await this.provider.stat(parseWorkspacePath(path))) !== null;
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

  /** Release the IndexedDB connection when a long-lived container is retired. */
  async dispose(): Promise<void> {
    await this.provider.dispose();
  }
}
