/**
 * IPC handlers for filesystem operations.
 *
 * Every handler takes a `rootPath` string (the workspace's absolute root)
 * and a path relative to that root. The WorkspaceRoots whitelist validates
 * both the root and that the resolved absolute path stays inside it.
 */

import { ipcMain, BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import type { FileSystemEntry, FileMeta } from '@bendyline/docblocks/filesystem';

import { getWorkspaceRoots } from './workspace-roots.js';

function toRelative(absolutePath: string, rootAbs: string): string {
  const rel = path.relative(rootAbs, absolutePath).replace(/\\/g, '/');
  return rel;
}

async function listEntries(absDir: string): Promise<FileSystemEntry[]> {
  const rootAbs = path.resolve(absDir);
  let raw: fss.Dirent[];
  try {
    raw = await fs.readdir(rootAbs, { withFileTypes: true });
  } catch {
    return [];
  }
  const entries: FileSystemEntry[] = raw
    .filter((d) => !d.name.startsWith('.DS_Store'))
    .map((d) => {
      const full = path.join(rootAbs, d.name);
      return d.isDirectory()
        ? { kind: 'directory' as const, name: d.name, path: full }
        : { kind: 'file' as const, name: d.name, path: full };
    });
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

export function registerFsIpc(): void {
  const roots = getWorkspaceRoots();

  ipcMain.handle('fs:readFile', async (_e, rootPath: string, p: string) => {
    const abs = roots.resolve(rootPath, p);
    try {
      return await fs.readFile(abs, 'utf8');
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return null;
      throw err;
    }
  });

  ipcMain.handle('fs:writeFile', async (_e, rootPath: string, p: string, content: string) => {
    const abs = roots.resolve(rootPath, p);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  });

  ipcMain.handle('fs:delete', async (_e, rootPath: string, p: string) => {
    const abs = roots.resolve(rootPath, p);
    try {
      await fs.rm(abs, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  ipcMain.handle('fs:rename', async (_e, rootPath: string, oldP: string, newP: string) => {
    const oldAbs = roots.resolve(rootPath, oldP);
    const newAbs = roots.resolve(rootPath, newP);
    await fs.mkdir(path.dirname(newAbs), { recursive: true });
    await fs.rename(oldAbs, newAbs);
  });

  ipcMain.handle(
    'fs:readDirectory',
    async (_e, rootPath: string, p: string): Promise<FileSystemEntry[]> => {
      const abs = roots.resolve(rootPath, p);
      const rootAbs = path.resolve(rootPath);
      const entries = await listEntries(abs);
      // Convert absolute paths to paths relative to the workspace root (with
      // a leading slash to match the browser providers' convention).
      return entries.map((e) => ({
        ...e,
        path: '/' + toRelative(e.path, rootAbs),
      }));
    },
  );

  ipcMain.handle('fs:exists', async (_e, rootPath: string, p: string) => {
    const abs = roots.resolve(rootPath, p);
    try {
      await fs.access(abs);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('fs:createDirectory', async (_e, rootPath: string, p: string) => {
    const abs = roots.resolve(rootPath, p);
    await fs.mkdir(abs, { recursive: true });
  });

  ipcMain.handle('fs:stat', async (_e, rootPath: string, p: string): Promise<FileMeta | null> => {
    const abs = roots.resolve(rootPath, p);
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) return null;
      return {
        name: path.basename(abs),
        path: p.replace(/^\/+/, ''),
        size: st.size,
        lastModified: st.mtime.toISOString(),
      };
    } catch {
      return null;
    }
  });

  ipcMain.handle(
    'fs:readBinary',
    async (_e, rootPath: string, p: string): Promise<ArrayBuffer | null> => {
      const abs = roots.resolve(rootPath, p);
      try {
        const buf = await fs.readFile(abs);
        // Slice to produce a fresh ArrayBuffer (avoid sharing the Node Buffer's pool).
        // Cast: readFile returns Buffer whose .buffer is ArrayBufferLike in TS 5.9.
        const arr = new Uint8Array(buf.byteLength);
        arr.set(buf);
        return arr.buffer;
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') return null;
        throw err;
      }
    },
  );

  ipcMain.handle(
    'fs:writeBinary',
    async (_e, rootPath: string, p: string, data: ArrayBuffer | Uint8Array) => {
      const abs = roots.resolve(rootPath, p);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const buf =
        data instanceof Uint8Array ? Buffer.from(data) : Buffer.from(new Uint8Array(data));
      await fs.writeFile(abs, buf);
    },
  );

  // ── Watch support ──────────────────────────────────────────────
  // One watcher per workspace root; one subscription id per renderer watch() call.
  // When the last subscription for a root unsubscribes, the watcher closes.
  interface WatchState {
    watcher: chokidar.FSWatcher;
    subscriptions: Set<string>;
  }
  const watchersByRoot = new Map<string, WatchState>();

  ipcMain.handle('fs:watch:subscribe', async (event, rootPath: string, subscriptionId: string) => {
    roots.resolve(rootPath, ''); // validates registration
    const key = path.resolve(rootPath);

    let state = watchersByRoot.get(key);
    if (!state) {
      const watcher = chokidar.watch(key, {
        ignoreInitial: true,
        ignored: /(^|[/\\])\../,
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
      });
      state = { watcher, subscriptions: new Set() };
      watchersByRoot.set(key, state);
      const broadcast = (absPath: string) => {
        const rel = '/' + toRelative(absPath, key);
        for (const subId of state!.subscriptions) {
          // Send to all renderer windows; the preload filters by subId.
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send('fs:watch:event', { subscriptionId: subId, path: rel });
          }
        }
      };
      watcher.on('add', broadcast);
      watcher.on('change', broadcast);
      watcher.on('unlink', broadcast);
      watcher.on('addDir', broadcast);
      watcher.on('unlinkDir', broadcast);
    }
    state.subscriptions.add(subscriptionId);

    // On renderer tear-down, close the watcher if no subs remain.
    event.sender.once('destroyed', () => {
      const s = watchersByRoot.get(key);
      if (!s) return;
      s.subscriptions.delete(subscriptionId);
      if (s.subscriptions.size === 0) {
        s.watcher.close().catch(() => undefined);
        watchersByRoot.delete(key);
      }
    });
  });

  ipcMain.handle('fs:watch:unsubscribe', async (_e, rootPath: string, subscriptionId: string) => {
    const key = path.resolve(rootPath);
    const state = watchersByRoot.get(key);
    if (!state) return;
    state.subscriptions.delete(subscriptionId);
    if (state.subscriptions.size === 0) {
      await state.watcher.close().catch(() => undefined);
      watchersByRoot.delete(key);
    }
  });
}
