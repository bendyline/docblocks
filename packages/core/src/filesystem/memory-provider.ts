/**
 * MemoryFileSystemProvider — an in-memory FileSystemProvider.
 *
 * Mirrors IndexedDBFileSystemProvider's path conventions exactly (normalised,
 * leading/trailing slashes stripped) so it is a drop-in wherever a provider is
 * used, but keeps everything in RAM and is never persisted.
 *
 * Used to back *transient* workspaces — a single loose markdown file opened
 * from the OS, or a `.dbk` bundle unpacked for the session. The caller is
 * responsible for seeding it (see `seedText` / `writeBinary`) and for saving
 * its contents back to the origin (disk file or re-zipped bundle).
 */

import type { FileSystemProvider, FileSystemEntry, FileMeta } from './types.js';

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

interface MemoryEntry {
  content?: string;
  binary?: ArrayBuffer;
  meta: FileMeta;
}

export class MemoryFileSystemProvider implements FileSystemProvider {
  readonly id: string;
  readonly label: string;

  private files = new Map<string, MemoryEntry>();
  private dirs = new Set<string>();

  constructor(id: string, label: string) {
    this.id = id;
    this.label = label;
  }

  /** Seed a text file synchronously during setup (before the provider is used). */
  seedText(path: string, content: string): void {
    const p = normalisePath(path);
    this.ensureDir(parentDir(p));
    this.files.set(p, {
      content,
      meta: {
        name: baseName(p),
        path: p,
        size: new Blob([content]).size,
        lastModified: new Date().toISOString(),
      },
    });
  }

  private ensureDir(dirPath: string): void {
    if (!dirPath) return;
    const parts = dirPath.split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      this.dirs.add(current);
    }
  }

  async readFile(path: string): Promise<string | null> {
    return this.files.get(normalisePath(path))?.content ?? null;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const p = normalisePath(path);
    this.ensureDir(parentDir(p));
    this.files.set(p, {
      content,
      meta: {
        name: baseName(p),
        path: p,
        size: new Blob([content]).size,
        lastModified: new Date().toISOString(),
      },
    });
  }

  async delete(path: string): Promise<void> {
    const p = normalisePath(path);
    this.files.delete(p);

    if (this.dirs.has(p)) {
      const prefix = p + '/';
      for (const d of [...this.dirs]) {
        if (d === p || d.startsWith(prefix)) this.dirs.delete(d);
      }
      for (const f of [...this.files.keys()]) {
        if (f.startsWith(prefix)) this.files.delete(f);
      }
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const op = normalisePath(oldPath);
    const np = normalisePath(newPath);
    if (op === np) return;
    if (!op || !np) throw new Error('Cannot rename the filesystem root');
    if (np.startsWith(op + '/')) throw new Error('Cannot move a directory into itself');

    const remap = (from: string, to: string): void => {
      const entry = this.files.get(from);
      if (!entry) return;
      this.ensureDir(parentDir(to));
      this.files.set(to, {
        ...entry,
        meta: { ...entry.meta, name: baseName(to), path: to },
      });
      this.files.delete(from);
    };

    if (this.dirs.has(op)) {
      const oldPrefix = op + '/';
      const newPrefix = np + '/';
      for (const f of [...this.files.keys()]) {
        if (f.startsWith(oldPrefix)) remap(f, newPrefix + f.slice(oldPrefix.length));
      }
      this.dirs.delete(op);
      for (const d of [...this.dirs]) {
        if (d.startsWith(oldPrefix)) {
          this.dirs.delete(d);
          this.dirs.add(newPrefix + d.slice(oldPrefix.length));
        }
      }
      this.ensureDir(np);
      return;
    }

    remap(op, np);
  }

  async readDirectory(path: string): Promise<FileSystemEntry[]> {
    const p = normalisePath(path);
    const prefix = p ? p + '/' : '';
    const entries: FileSystemEntry[] = [];
    const seen = new Set<string>();

    for (const d of this.dirs) {
      let rel: string | null = null;
      if (!p && !d.includes('/')) rel = d;
      else if (p && d.startsWith(prefix)) {
        const rest = d.slice(prefix.length);
        if (!rest.includes('/')) rel = rest;
      }
      if (rel && !seen.has(rel)) {
        seen.add(rel);
        entries.push({ kind: 'directory', name: rel, path: d });
      }
    }

    for (const filePath of this.files.keys()) {
      if (p && !filePath.startsWith(prefix)) continue;
      const rel = p ? filePath.slice(prefix.length) : filePath;
      if (rel.includes('/')) continue;
      if (!seen.has(rel)) {
        seen.add(rel);
        entries.push({ kind: 'file', name: rel, path: filePath });
      }
    }

    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return entries;
  }

  async exists(path: string): Promise<boolean> {
    const p = normalisePath(path);
    return this.dirs.has(p) || this.files.has(p);
  }

  async createDirectory(path: string): Promise<void> {
    this.ensureDir(normalisePath(path));
  }

  async stat(path: string): Promise<FileMeta | null> {
    return this.files.get(normalisePath(path))?.meta ?? null;
  }

  async readBinary(path: string): Promise<ArrayBuffer | null> {
    return this.files.get(normalisePath(path))?.binary ?? null;
  }

  async writeBinary(path: string, data: ArrayBuffer | Uint8Array): Promise<void> {
    const p = normalisePath(path);
    this.ensureDir(parentDir(p));
    // Copy into a fresh, standalone ArrayBuffer so we never alias the caller's
    // buffer (or a pooled Node Buffer).
    const src = data instanceof Uint8Array ? data : new Uint8Array(data);
    const copy = new Uint8Array(src.byteLength);
    copy.set(src);
    this.files.set(p, {
      binary: copy.buffer as ArrayBuffer,
      meta: {
        name: baseName(p),
        path: p,
        size: data.byteLength,
        lastModified: new Date().toISOString(),
      },
    });
  }
}
