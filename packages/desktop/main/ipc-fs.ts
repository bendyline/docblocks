/**
 * IPC handlers for filesystem operations.
 *
 * Every handler takes a `rootPath` string (the workspace's absolute root)
 * and a path relative to that root. The WorkspaceRoots whitelist validates
 * both lexical traversal and the physical target of symlink/junction
 * ancestors before native filesystem operations run.
 */

import { ipcMain, type WebContents } from 'electron';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import type { FileCommitResult, FileSystemEntry, FileMeta } from '@bendyline/docblocks/filesystem';

import { getWorkspaceRoots } from './workspace-roots.js';
import { acquireWorkspaceWatcher, type WorkspaceWatcherHandle } from './workspace-watchers.js';
import {
  atomicWriteBinary,
  atomicWriteText,
  commitTextFile,
  readTextOrNull,
  withFileMutationLocks,
} from './file-commit.js';
import { deleteWorkspaceEntry } from './workspace-file-operations.js';

function toRelative(absolutePath: string, rootAbs: string): string {
  const rel = path.relative(rootAbs, absolutePath).replace(/\\/g, '/');
  return rel;
}

async function listEntries(absDir: string): Promise<FileSystemEntry[]> {
  const rootAbs = path.resolve(absDir);
  let raw: fss.Dirent[];
  try {
    raw = await fs.readdir(rootAbs, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const entries: FileSystemEntry[] = raw
    .filter((d) => !d.name.startsWith('.DS_Store') && (d.isDirectory() || d.isFile()))
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

function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export function registerFsIpc(): void {
  const roots = getWorkspaceRoots();

  ipcMain.handle('fs:readFile', async (_e, rootPath: string, p: string) => {
    const abs = await roots.resolvePhysical(rootPath, p);
    return readTextOrNull(abs);
  });

  ipcMain.handle('fs:writeFile', async (_e, rootPath: string, p: string, content: string) => {
    const rootAbs = roots.resolve(rootPath, '');
    const lexicalTarget = roots.resolve(rootPath, p);
    await withFileMutationLocks([rootAbs, lexicalTarget], async () => {
      const abs = await roots.resolveMutation(rootPath, p);
      await atomicWriteText(abs, content);
    });
  });

  ipcMain.handle(
    'fs:commitFile',
    async (
      _e,
      rootPath: string,
      p: string,
      content: string,
      expectedContent: string | null,
    ): Promise<FileCommitResult> => {
      const rootAbs = roots.resolve(rootPath, '');
      const abs = await roots.resolveMutation(rootPath, p);
      return commitTextFile(abs, content, expectedContent, [rootAbs, abs]);
    },
  );

  ipcMain.handle('fs:delete', async (_e, rootPath: string, p: string) => {
    await deleteWorkspaceEntry(roots, rootPath, p);
  });

  ipcMain.handle('fs:rename', async (_e, rootPath: string, oldP: string, newP: string) => {
    const rootAbs = roots.resolve(rootPath, '');
    const oldLexical = roots.resolve(rootPath, oldP);
    const newLexical = roots.resolve(rootPath, newP);
    await withFileMutationLocks([rootAbs, oldLexical, newLexical], async () => {
      const oldAbs = await roots.resolveMutation(rootPath, oldP);
      const newAbs = await roots.resolveMutation(rootPath, newP);
      try {
        await fs.access(newAbs);
        throw new Error(`Destination exists: ${newP}`);
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') throw error;
      }
      await fs.mkdir(path.dirname(newAbs), { recursive: true });
      await fs.rename(oldAbs, newAbs);
    });
  });

  ipcMain.handle(
    'fs:readDirectory',
    async (_e, rootPath: string, p: string): Promise<FileSystemEntry[]> => {
      const abs = await roots.resolvePhysical(rootPath, p);
      const rootAbs = roots.resolve(rootPath, '');
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
    const abs = await roots.resolvePhysical(rootPath, p);
    try {
      await fs.access(abs);
      return true;
    } catch (error: unknown) {
      if (isMissingPath(error)) return false;
      throw error;
    }
  });

  ipcMain.handle('fs:createDirectory', async (_e, rootPath: string, p: string) => {
    const rootAbs = roots.resolve(rootPath, '');
    const lexicalTarget = roots.resolve(rootPath, p);
    await withFileMutationLocks([rootAbs, lexicalTarget], async () => {
      const abs = await roots.resolveMutation(rootPath, p);
      await fs.mkdir(abs, { recursive: true });
    });
  });

  ipcMain.handle('fs:stat', async (_e, rootPath: string, p: string): Promise<FileMeta | null> => {
    const abs = await roots.resolvePhysical(rootPath, p);
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) return null;
      return {
        name: path.basename(abs),
        path: p.replace(/^\/+/, ''),
        size: st.size,
        lastModified: st.mtime.toISOString(),
      };
    } catch (error: unknown) {
      if (isMissingPath(error)) return null;
      throw error;
    }
  });

  ipcMain.handle(
    'fs:readBinary',
    async (_e, rootPath: string, p: string): Promise<ArrayBuffer | null> => {
      const abs = await roots.resolvePhysical(rootPath, p);
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
      const rootAbs = roots.resolve(rootPath, '');
      const lexicalTarget = roots.resolve(rootPath, p);
      await withFileMutationLocks([rootAbs, lexicalTarget], async () => {
        const abs = await roots.resolveMutation(rootPath, p);
        await atomicWriteBinary(abs, data);
      });
    },
  );

  // ── Watch support ──────────────────────────────────────────────
  // One shared watcher per workspace root (see workspace-watchers.ts); one
  // subscription id per renderer watch() call. When the last subscription
  // for a root unsubscribes, this consumer's acquisition is released.
  interface WatchSubscription {
    subscriptionId: string;
    sender: WebContents;
    onDestroyed: () => void;
  }

  interface WatchState {
    handle: WorkspaceWatcherHandle;
    subscriptions: Map<string, WatchSubscription>;
  }
  const watchersByRoot = new Map<string, WatchState>();
  const subscriptions = new Map<string, { rootKey: string; subscription: WatchSubscription }>();

  const releaseSubscription = (token: string, removeDestroyedListener: boolean): void => {
    const registered = subscriptions.get(token);
    if (!registered) return;
    subscriptions.delete(token);

    const { rootKey, subscription } = registered;
    if (removeDestroyedListener && !subscription.sender.isDestroyed()) {
      subscription.sender.removeListener('destroyed', subscription.onDestroyed);
    }

    const state = watchersByRoot.get(rootKey);
    if (!state) return;
    state.subscriptions.delete(token);
    if (state.subscriptions.size === 0) {
      state.handle.release();
      watchersByRoot.delete(rootKey);
    }
  };

  ipcMain.handle('fs:watch:subscribe', async (event, rootPath: string, subscriptionId: string) => {
    const rootAbs = await roots.resolvePhysical(rootPath, '');
    const key = await fs.realpath(rootAbs);
    const token = `${event.sender.id}:${subscriptionId}`;
    if (subscriptions.has(token)) throw new Error('Duplicate filesystem watch subscription.');

    let state = watchersByRoot.get(key);
    if (!state) {
      const handle = acquireWorkspaceWatcher(key);
      const created: WatchState = { handle, subscriptions: new Map() };
      handle.onChange((rel) => {
        for (const subscription of created.subscriptions.values()) {
          if (!subscription.sender.isDestroyed()) {
            subscription.sender.send('fs:watch:event', {
              subscriptionId: subscription.subscriptionId,
              path: rel,
            });
          }
        }
      });
      watchersByRoot.set(key, created);
      state = created;
    }

    const onDestroyed = () => releaseSubscription(token, false);
    const subscription: WatchSubscription = {
      subscriptionId,
      sender: event.sender,
      onDestroyed,
    };
    state.subscriptions.set(token, subscription);
    subscriptions.set(token, { rootKey: key, subscription });
    event.sender.once('destroyed', onDestroyed);
  });

  ipcMain.handle(
    'fs:watch:unsubscribe',
    async (event, _rootPath: string, subscriptionId: string) => {
      releaseSubscription(`${event.sender.id}:${subscriptionId}`, true);
    },
  );
}
