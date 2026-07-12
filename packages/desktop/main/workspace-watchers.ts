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

import fss from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';

export interface WorkspaceWatcherEvent {
  readonly type: 'created' | 'modified' | 'removed';
  readonly kind: 'file' | 'directory';
  readonly path: string;
}

export interface WorkspaceWatcherHandle {
  readonly ready: Promise<void>;
  /** Register a change listener. Returns an unregister function. */
  onChange(listener: (relPath: string) => void): () => void;
  onEvent(listener: (event: WorkspaceWatcherEvent) => void | Promise<void>): () => void;
  onError(listener: (error: unknown) => void): () => void;
  /** Release this acquisition; closes the watcher when it was the last one. */
  release(): void;
  /** Awaitable release for lifecycle-sensitive consumers. */
  dispose(): Promise<void>;
}

interface WatcherState {
  watcher: chokidar.FSWatcher;
  listeners: Set<(relPath: string) => void>;
  eventListeners: Set<(event: WorkspaceWatcherEvent) => void | Promise<void>>;
  errorListeners: Set<(error: unknown) => void>;
  ready: Promise<void>;
  acquisitions: number;
}

const watchers = new Map<string, WatcherState>();

function canonicalWatcherRoot(rootPath: string): string {
  // Watching is privileged native I/O. A missing or inaccessible root must
  // fail closed instead of silently falling back to a lexical path that can
  // later be replaced by a symlink or junction.
  return fss.realpathSync.native(rootPath);
}

export function acquireWorkspaceWatcher(rootPath: string): WorkspaceWatcherHandle {
  const key = canonicalWatcherRoot(rootPath);
  let state = watchers.get(key);
  if (!state) {
    const watcher = chokidar.watch(key, {
      ignoreInitial: true,
      ignored: /(^|[/\\])\../,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    let readySettled = false;
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Existing v1 consumers do not observe readiness; keep a failed startup
    // from becoming an unhandled rejection while v2 still receives it.
    void ready.catch(() => undefined);
    const created: WatcherState = {
      watcher,
      listeners: new Set(),
      eventListeners: new Set(),
      errorListeners: new Set(),
      ready,
      acquisitions: 0,
    };
    const broadcast = (
      type: WorkspaceWatcherEvent['type'],
      kind: WorkspaceWatcherEvent['kind'],
      absPath: string,
    ) => {
      const relative = path.relative(key, path.resolve(absPath));
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return;
      }
      const rel = '/' + relative.replace(/\\/g, '/');
      const event: WorkspaceWatcherEvent = { type, kind, path: rel };
      for (const listener of [...created.listeners]) {
        try {
          listener(rel);
        } catch {
          // Watchers are observational and cannot roll back a native event.
        }
      }
      for (const listener of [...created.eventListeners]) {
        try {
          void Promise.resolve(listener(event)).catch(() => undefined);
        } catch {
          // Isolate consumers from one another.
        }
      }
    };
    watcher.on('add', (item) => broadcast('created', 'file', item));
    watcher.on('change', (item) => broadcast('modified', 'file', item));
    watcher.on('unlink', (item) => broadcast('removed', 'file', item));
    watcher.on('addDir', (item) => broadcast('created', 'directory', item));
    watcher.on('unlinkDir', (item) => broadcast('removed', 'directory', item));
    watcher.once('ready', () => {
      readySettled = true;
      resolveReady();
    });
    watcher.on('error', (error) => {
      if (!readySettled) {
        readySettled = true;
        rejectReady(error);
      }
      for (const listener of [...created.errorListeners]) {
        try {
          listener(error);
        } catch {
          // Isolate consumers from one another.
        }
      }
    });
    watchers.set(key, created);
    state = created;
  }
  state.acquisitions += 1;

  const current = state;
  const own = new Set<(relPath: string) => void>();
  const ownEvents = new Set<(event: WorkspaceWatcherEvent) => void | Promise<void>>();
  const ownErrors = new Set<(error: unknown) => void>();
  let released = false;
  let releasePromise: Promise<void> | null = null;
  const dispose = (): Promise<void> => {
    if (releasePromise) return releasePromise;
    released = true;
    for (const listener of own) current.listeners.delete(listener);
    for (const listener of ownEvents) current.eventListeners.delete(listener);
    for (const listener of ownErrors) current.errorListeners.delete(listener);
    current.acquisitions -= 1;
    if (current.acquisitions <= 0) {
      watchers.delete(key);
      releasePromise = current.watcher.close();
    } else {
      releasePromise = Promise.resolve();
    }
    return releasePromise;
  };
  return {
    ready: current.ready,
    onChange(listener) {
      if (released) return () => undefined;
      current.listeners.add(listener);
      own.add(listener);
      return () => {
        current.listeners.delete(listener);
        own.delete(listener);
      };
    },
    onEvent(listener) {
      if (released) return () => undefined;
      current.eventListeners.add(listener);
      ownEvents.add(listener);
      return () => {
        current.eventListeners.delete(listener);
        ownEvents.delete(listener);
      };
    },
    onError(listener) {
      if (released) return () => undefined;
      current.errorListeners.add(listener);
      ownErrors.add(listener);
      return () => {
        current.errorListeners.delete(listener);
        ownErrors.delete(listener);
      };
    },
    release() {
      void dispose().catch(() => undefined);
    },
    dispose,
  };
}
