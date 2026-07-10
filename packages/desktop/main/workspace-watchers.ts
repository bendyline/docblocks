/**
 * Shared workspace-root file watchers — one chokidar instance per root no
 * matter how many consumers observe it. `fs:watch` subscriptions (renderer
 * change events) and the git status manager both acquire the same watcher,
 * so a large folder is never scanned twice.
 *
 * Callers must pair every acquire with release(); the watcher closes when
 * the last acquisition releases. Dotfiles are ignored (which also keeps
 * `.git` churn out of these events — git state has its own watcher).
 */

import path from 'node:path';
import chokidar from 'chokidar';

export interface WorkspaceWatcherHandle {
  /** Register a change listener. Returns an unregister function. */
  onChange(listener: (relPath: string) => void): () => void;
  /** Release this acquisition; closes the watcher when it was the last one. */
  release(): void;
}

interface WatcherState {
  watcher: chokidar.FSWatcher;
  listeners: Set<(relPath: string) => void>;
  acquisitions: number;
}

const watchers = new Map<string, WatcherState>();

export function acquireWorkspaceWatcher(rootPath: string): WorkspaceWatcherHandle {
  const key = path.resolve(rootPath);
  let state = watchers.get(key);
  if (!state) {
    const watcher = chokidar.watch(key, {
      ignoreInitial: true,
      ignored: /(^|[/\\])\../,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    const created: WatcherState = { watcher, listeners: new Set(), acquisitions: 0 };
    const broadcast = (absPath: string) => {
      const rel = '/' + path.relative(key, absPath).replace(/\\/g, '/');
      for (const listener of created.listeners) listener(rel);
    };
    watcher.on('add', broadcast);
    watcher.on('change', broadcast);
    watcher.on('unlink', broadcast);
    watcher.on('addDir', broadcast);
    watcher.on('unlinkDir', broadcast);
    watchers.set(key, created);
    state = created;
  }
  state.acquisitions += 1;

  const current = state;
  const own = new Set<(relPath: string) => void>();
  let released = false;
  return {
    onChange(listener) {
      if (released) return () => undefined;
      current.listeners.add(listener);
      own.add(listener);
      return () => {
        current.listeners.delete(listener);
        own.delete(listener);
      };
    },
    release() {
      if (released) return;
      released = true;
      for (const listener of own) current.listeners.delete(listener);
      current.acquisitions -= 1;
      if (current.acquisitions <= 0) {
        current.watcher.close().catch(() => undefined);
        watchers.delete(key);
      }
    },
  };
}
