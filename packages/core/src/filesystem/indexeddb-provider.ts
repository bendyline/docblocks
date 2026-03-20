/**
 * IndexedDBFileSystemProvider — virtualises a filesystem on top of IndexedDB
 * using the LocalForageAdapter from @bendyline/squisq/storage.
 *
 * Key schema:
 *   fs:{path}:content  → string (text file contents)
 *   fs:{path}:binary   → ArrayBuffer (binary file contents)
 *   fs:{path}:meta     → FileMeta object
 *   fs:dirs             → Set<string> of known directory paths
 */

import { LocalForageAdapter } from '@bendyline/squisq/storage';
import type { FileSystemProvider, FileSystemEntry, FileMeta } from './types.js';

// ── Helpers ────────────────────────────────────────────────────────

/** Normalise a path: strip leading/trailing slashes, collapse doubles. */
function normalisePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '').replace(/\/$/, '');
}

/** Get the parent directory of a path, or empty string for root-level. */
function parentDir(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? '' : p.slice(0, idx);
}

/** Get the filename component of a path. */
function baseName(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? p : p.slice(idx + 1);
}

// ── Key helpers ────────────────────────────────────────────────────

function contentKey(path: string): string {
  return `fs:${path}:content`;
}

function binaryKey(path: string): string {
  return `fs:${path}:binary`;
}

function metaKey(path: string): string {
  return `fs:${path}:meta`;
}

const DIRS_KEY = 'fs:dirs';

// ── Implementation ─────────────────────────────────────────────────

export class IndexedDBFileSystemProvider implements FileSystemProvider {
  readonly id: string;
  readonly label: string;

  private store: LocalForageAdapter;

  constructor(id: string, label: string) {
    this.id = id;
    this.label = label;
    this.store = new LocalForageAdapter({
      name: `docblocks-fs-${id}`,
      storeName: 'files',
    });
  }

  // ── Directory tracking ──────────────────────────────────────────

  private async getDirs(): Promise<Set<string>> {
    const raw = await this.store.get<string[]>(DIRS_KEY);
    return new Set(raw ?? []);
  }

  private async saveDirs(dirs: Set<string>): Promise<void> {
    await this.store.set(DIRS_KEY, [...dirs]);
  }

  /** Ensure a directory (and all ancestors) are tracked. */
  private async ensureDir(dirPath: string): Promise<void> {
    if (!dirPath) return;
    const dirs = await this.getDirs();
    const parts = dirPath.split('/');
    let current = '';
    let changed = false;
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!dirs.has(current)) {
        dirs.add(current);
        changed = true;
      }
    }
    if (changed) {
      await this.saveDirs(dirs);
    }
  }

  // ── FileSystemProvider implementation ───────────────────────────

  async readFile(path: string): Promise<string | null> {
    const p = normalisePath(path);
    return this.store.get<string>(contentKey(p));
  }

  async writeFile(path: string, content: string): Promise<void> {
    const p = normalisePath(path);
    const parent = parentDir(p);
    if (parent) {
      await this.ensureDir(parent);
    }

    const meta: FileMeta = {
      name: baseName(p),
      path: p,
      size: new Blob([content]).size,
      lastModified: new Date().toISOString(),
    };

    await this.store.set(contentKey(p), content);
    await this.store.set(metaKey(p), meta);
  }

  async delete(path: string): Promise<void> {
    const p = normalisePath(path);

    // Remove file keys
    await this.store.remove(contentKey(p));
    await this.store.remove(binaryKey(p));
    await this.store.remove(metaKey(p));

    // If it was a directory, remove it and all children
    const dirs = await this.getDirs();
    if (dirs.has(p)) {
      const prefix = p + '/';
      const toRemove: string[] = [p];
      for (const d of dirs) {
        if (d.startsWith(prefix)) {
          toRemove.push(d);
        }
      }
      for (const d of toRemove) {
        dirs.delete(d);
      }
      await this.saveDirs(dirs);

      // Remove all file keys under this directory
      const allKeys = await this.store.keys();
      const filePrefix = `fs:${p}/`;
      const keysToRemove = allKeys.filter((k) => k.startsWith(filePrefix));
      await Promise.all(keysToRemove.map((k) => this.store.remove(k)));
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const op = normalisePath(oldPath);
    const np = normalisePath(newPath);

    // Read existing data
    const content = await this.store.get<string>(contentKey(op));
    const binary = await this.store.get<ArrayBuffer>(binaryKey(op));
    const meta = await this.store.get<FileMeta>(metaKey(op));

    // Write to new location
    if (content !== null) {
      await this.store.set(contentKey(np), content);
    }
    if (binary !== null) {
      await this.store.set(binaryKey(np), binary);
    }
    if (meta) {
      meta.name = baseName(np);
      meta.path = np;
      await this.store.set(metaKey(np), meta);
    }

    // Ensure parent dir of new path exists
    const newParent = parentDir(np);
    if (newParent) {
      await this.ensureDir(newParent);
    }

    // Delete old
    await this.store.remove(contentKey(op));
    await this.store.remove(binaryKey(op));
    await this.store.remove(metaKey(op));

    // Handle directory rename
    const dirs = await this.getDirs();
    if (dirs.has(op)) {
      dirs.delete(op);
      dirs.add(np);
      const oldPrefix = op + '/';
      const newPrefix = np + '/';
      for (const d of [...dirs]) {
        if (d.startsWith(oldPrefix)) {
          dirs.delete(d);
          dirs.add(newPrefix + d.slice(oldPrefix.length));
        }
      }
      await this.saveDirs(dirs);
    }
  }

  async readDirectory(path: string): Promise<FileSystemEntry[]> {
    const p = normalisePath(path);
    const dirs = await this.getDirs();
    const entries: FileSystemEntry[] = [];
    const seen = new Set<string>();

    // Find child directories
    const prefix = p ? p + '/' : '';
    for (const d of dirs) {
      if (!p && !d.includes('/')) {
        // Root-level directory
        if (!seen.has(d)) {
          seen.add(d);
          entries.push({ kind: 'directory', name: d, path: d });
        }
      } else if (p && d.startsWith(prefix)) {
        const rest = d.slice(prefix.length);
        if (!rest.includes('/')) {
          // Direct child directory
          if (!seen.has(rest)) {
            seen.add(rest);
            entries.push({ kind: 'directory', name: rest, path: d });
          }
        }
      }
    }

    // Find child files by scanning meta keys
    const allKeys = await this.store.keys();
    const metaPrefix = p ? `fs:${p}/` : 'fs:';
    const metaSuffix = ':meta';

    for (const key of allKeys) {
      if (!key.startsWith(metaPrefix) || !key.endsWith(metaSuffix)) continue;

      const filePath = key.slice(3, -metaSuffix.length); // strip "fs:" and ":meta"
      const rel = p ? filePath.slice(prefix.length) : filePath;

      // Only direct children (no further slashes)
      if (rel.includes('/')) continue;

      if (!seen.has(rel)) {
        seen.add(rel);
        entries.push({ kind: 'file', name: rel, path: filePath });
      }
    }

    // Sort: directories first, then alphabetical
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return entries;
  }

  async exists(path: string): Promise<boolean> {
    const p = normalisePath(path);
    const dirs = await this.getDirs();
    if (dirs.has(p)) return true;
    const meta = await this.store.get(metaKey(p));
    return meta !== null;
  }

  async createDirectory(path: string): Promise<void> {
    const p = normalisePath(path);
    await this.ensureDir(p);
  }

  async stat(path: string): Promise<FileMeta | null> {
    const p = normalisePath(path);
    return this.store.get<FileMeta>(metaKey(p));
  }

  async readBinary(path: string): Promise<ArrayBuffer | null> {
    const p = normalisePath(path);
    return this.store.get<ArrayBuffer>(binaryKey(p));
  }

  async writeBinary(path: string, data: ArrayBuffer | Uint8Array): Promise<void> {
    const p = normalisePath(path);
    const parent = parentDir(p);
    if (parent) {
      await this.ensureDir(parent);
    }

    const meta: FileMeta = {
      name: baseName(p),
      path: p,
      size: data.byteLength,
      lastModified: new Date().toISOString(),
    };

    await this.store.set(binaryKey(p), data);
    await this.store.set(metaKey(p), meta);
  }
}
