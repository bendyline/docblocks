/**
 * useFileTree — hook that reads from a FileSystemProvider,
 * maintains expanded/collapsed state, and provides CRUD operations.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  FsError,
  getFileSystemProviderV2,
  moveFileSystemEntry,
  parseWorkspacePath,
  type FileSystemProvider,
  type FileSystemEntry,
} from '@bendyline/docblocks/filesystem';

function normalisePath(path: string): string {
  return parseWorkspacePath(path);
}

function relocatePath(path: string, oldPath: string, newPath: string): string {
  const current = normalisePath(path);
  const oldNormalised = normalisePath(oldPath);
  if (current !== oldNormalised && !current.startsWith(`${oldNormalised}/`)) return path;
  const suffix = current.slice(oldNormalised.length);
  return `${newPath.replace(/\/+$/, '')}${suffix}`;
}

function ancestorPaths(path: string): string[] {
  const canonical = normalisePath(path);
  if (!canonical) return [];
  const segments = canonical.split('/');
  const prefix = /^[\\/]/u.test(path) ? '/' : '';
  return segments
    .slice(0, -1)
    .map((_, index) => `${prefix}${segments.slice(0, index + 1).join('/')}`);
}

function equivalentPathKeys(path: string): string[] {
  const canonical = normalisePath(path);
  return canonical ? [path, canonical, `/${canonical}`] : [path, canonical];
}

function hasEquivalentPath(paths: ReadonlySet<string>, path: string): boolean {
  return equivalentPathKeys(path).some((candidate) => paths.has(candidate));
}

async function readProviderDirectory(
  provider: FileSystemProvider,
  path: string,
): Promise<FileSystemEntry[]> {
  const providerV2 = getFileSystemProviderV2(provider);
  if (!providerV2) return provider.readDirectory(path);
  const entries = await providerV2.readDirectory(parseWorkspacePath(path));
  return entries.map((entry) => ({ kind: entry.kind, name: entry.name, path: entry.path }));
}

export interface FileTreeState {
  /** Flat list of entries for the current directory view. */
  entries: FileSystemEntry[];
  /** Set of expanded directory paths. */
  expanded: Set<string>;
  /** Currently selected path — file or directory (null if none). */
  selectedPath: string | null;
  /** Kind of the selected entry. */
  selectedKind: 'file' | 'directory' | null;
  /** Whether the tree is loading. */
  loading: boolean;
  /** Latest provider/read/watch failure, cleared by a successful refresh. */
  error: string | null;
}

export interface FileTreeActions {
  /** Toggle a directory's expanded state. */
  toggleExpand: (path: string) => void;
  /** Select a file or directory. */
  select: (path: string, kind: 'file' | 'directory') => void;
  /** Select an entry and expand each directory needed to reveal it. */
  reveal: (path: string, kind: 'file' | 'directory') => void;
  /** Create a new file with optional initial content. */
  createFile: (path: string, content?: string) => Promise<void>;
  /** Create a new directory. */
  createDirectory: (path: string) => Promise<void>;
  /** Delete a file or directory. */
  deleteEntry: (path: string) => Promise<void>;
  /** Rename or move a file or directory, including a markdown companion folder. */
  renameEntry: (oldPath: string, newPath: string, kind?: 'file' | 'directory') => Promise<void>;
  /** Force refresh the tree. */
  refresh: () => Promise<void>;
}

export function useFileTree(provider: FileSystemProvider | null): FileTreeState & FileTreeActions {
  const [entries, setEntries] = useState<FileSystemEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedKind, setSelectedKind] = useState<'file' | 'directory' | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track child entries for expanded directories
  const [childEntries, setChildEntries] = useState<Map<string, FileSystemEntry[]>>(new Map());

  const providerRef = useRef(provider);
  providerRef.current = provider;

  const reportError = useCallback((caught: unknown) => {
    setError(caught instanceof Error ? caught.message : 'Unable to read this workspace.');
  }, []);

  const loadRoot = useCallback(async () => {
    const sourceProvider = providerRef.current;
    if (!sourceProvider) {
      setEntries([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const root = await readProviderDirectory(sourceProvider, '');
      if (providerRef.current !== sourceProvider) return;
      setEntries(root);
    } catch (caught: unknown) {
      if (providerRef.current === sourceProvider) reportError(caught);
    } finally {
      if (providerRef.current === sourceProvider) setLoading(false);
    }
  }, [reportError]);

  const loadChildren = useCallback(
    async (dirPath: string) => {
      const sourceProvider = providerRef.current;
      if (!sourceProvider) return;
      try {
        const children = await readProviderDirectory(sourceProvider, dirPath);
        if (providerRef.current !== sourceProvider) return;
        setChildEntries((prev) => {
          const next = new Map(prev);
          next.set(dirPath, children);
          return next;
        });
      } catch (caught: unknown) {
        if (providerRef.current === sourceProvider) reportError(caught);
      }
    },
    [reportError],
  );

  // Load root on provider change
  useEffect(() => {
    setEntries([]);
    setExpanded(new Set());
    setChildEntries(new Map());
    setSelectedPath(null);
    setSelectedKind(null);
    setError(null);
    void loadRoot();
  }, [provider, loadRoot]);

  const toggleExpand = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (hasEquivalentPath(next, path)) {
          for (const candidate of equivalentPathKeys(path)) next.delete(candidate);
        } else {
          next.add(path);
          // Load children when expanding
          void loadChildren(path);
        }
        return next;
      });
    },
    [loadChildren],
  );

  const select = useCallback((path: string, kind: 'file' | 'directory') => {
    setSelectedPath(path);
    setSelectedKind(kind);
  }, []);

  const reveal = useCallback(
    (path: string, kind: 'file' | 'directory') => {
      const ancestors = ancestorPaths(path);
      setSelectedPath(path);
      setSelectedKind(kind);
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const ancestor of ancestors) {
          if (!hasEquivalentPath(next, ancestor)) next.add(ancestor);
        }
        return next;
      });
      for (const ancestor of ancestors) {
        void loadChildren(ancestor);
      }
    },
    [loadChildren],
  );

  const refresh = useCallback(async () => {
    await loadRoot();
    // Reload all expanded directories
    const expandedPaths = [...expanded];
    for (const dirPath of expandedPaths) {
      await loadChildren(dirPath);
    }
  }, [loadRoot, loadChildren, expanded]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Keep the explorer synchronized with provider changes. Watch-capable
  // providers (including Electron's chokidar-backed provider) update in real
  // time. Calls are serialized and coalesced so event bursts cannot publish
  // directory reads out of order.
  useEffect(() => {
    if (!provider) return;
    const providerV2 = getFileSystemProviderV2(provider);
    if (!providerV2?.capabilities.watch) return;

    let disposed = false;
    let refreshing = false;
    let refreshAgain = false;

    const requestRefresh = () => {
      if (disposed) return;
      if (refreshing) {
        refreshAgain = true;
        return;
      }
      refreshing = true;
      void (async () => {
        try {
          do {
            refreshAgain = false;
            await refreshRef.current();
          } while (refreshAgain && !disposed);
        } catch (caught: unknown) {
          reportError(caught);
        } finally {
          refreshing = false;
          if (refreshAgain && !disposed) requestRefresh();
        }
      })();
    };

    const subscription = providerV2.watch(
      (event) => {
        // File content changes do not alter the directory tree. In particular,
        // every Electron autosave emits a local `modified` event; refreshing in
        // response briefly replaces the explorer with its loading state on
        // every save and needlessly re-reads every expanded directory.
        if (event.type === 'modified') return;
        requestRefresh();
      },
      {
        onError: (caught) => {
          if (disposed) return;
          reportError(caught);
          requestRefresh();
        },
      },
    );
    void subscription.ready.catch((caught: unknown) => {
      if (!disposed) reportError(caught);
    });
    return () => {
      disposed = true;
      void subscription.dispose();
    };
  }, [provider, reportError]);

  // File System Access and IndexedDB do not expose a dependable external
  // watcher. Refreshing on resume catches changes made while this surface was
  // in the background without continuously polling the filesystem.
  useEffect(() => {
    if (!provider) return;
    const refreshOnFocus = () => {
      void refreshRef.current().catch(reportError);
    };
    const refreshOnVisibility = () => {
      if (document.visibilityState === 'visible') refreshOnFocus();
    };
    window.addEventListener('focus', refreshOnFocus);
    document.addEventListener('visibilitychange', refreshOnVisibility);
    return () => {
      window.removeEventListener('focus', refreshOnFocus);
      document.removeEventListener('visibilitychange', refreshOnVisibility);
    };
  }, [provider, reportError]);

  const createFile = useCallback(
    async (path: string, content = '') => {
      if (!providerRef.current) return;
      const providerV2 = getFileSystemProviderV2(providerRef.current);
      if (providerV2) {
        await providerV2.writeFile(parseWorkspacePath(path), new TextEncoder().encode(content), {
          mode: 'create',
        });
      } else {
        // The v2 path above uses `mode: 'create'`, which refuses to clobber.
        // The legacy seam has no such mode, so enforce the same contract here
        // -- otherwise "create a new document" silently truncates whatever is
        // already at `path`. Unreachable with the first-party providers (they
        // all expose v2), but `FileSystemProvider` is a public interface and a
        // consumer's own provider would land here. Mirrors the same guard in
        // `provider-io.ts`'s legacy branch.
        if (await providerRef.current.exists(path)) {
          throw new FsError('already-exists', 'File already exists.', {
            operation: 'write',
            path,
          });
        }
        await providerRef.current.writeFile(path, content);
      }
      await refresh();
    },
    [refresh],
  );

  const createDirectory = useCallback(
    async (path: string) => {
      if (!providerRef.current) return;
      const providerV2 = getFileSystemProviderV2(providerRef.current);
      if (providerV2) {
        await providerV2.createDirectory(parseWorkspacePath(path), { mode: 'create' });
      } else {
        await providerRef.current.createDirectory(path);
      }
      await refresh();
    },
    [refresh],
  );

  const deleteEntry = useCallback(
    async (path: string) => {
      if (!providerRef.current) return;
      const providerV2 = getFileSystemProviderV2(providerRef.current);
      if (providerV2) {
        const canonical = parseWorkspacePath(path);
        const entry = await providerV2.stat(canonical);
        if (entry) {
          await providerV2.remove(canonical, {
            recursive: entry.kind === 'directory',
            missing: 'error',
            expectedVersion: entry.version,
          });
        }
      } else {
        await providerRef.current.delete(path);
      }
      if (selectedPath === path) {
        setSelectedPath(null);
        setSelectedKind(null);
      }
      await refresh();
    },
    [refresh, selectedPath],
  );

  const renameEntry = useCallback(
    async (oldPath: string, newPath: string, kind?: 'file' | 'directory') => {
      if (!providerRef.current) return;
      const oldNormalised = normalisePath(oldPath);
      const knownEntry = [...entries, ...childEntries.values()]
        .flat()
        .find((entry) => normalisePath(entry.path) === oldNormalised);
      const entryKind = kind ?? knownEntry?.kind ?? 'file';
      await moveFileSystemEntry(providerRef.current, oldPath, newPath, entryKind);

      if (selectedPath) {
        setSelectedPath(relocatePath(selectedPath, oldPath, newPath));
      }

      const nextExpanded = new Set(
        [...expanded].map((path) => relocatePath(path, oldPath, newPath)),
      );
      setExpanded(nextExpanded);
      setChildEntries(new Map());
      await loadRoot();
      for (const dirPath of nextExpanded) {
        await loadChildren(dirPath);
      }
    },
    [selectedPath, entries, childEntries, expanded, loadRoot, loadChildren],
  );

  // Merge root entries with child entries for a flat tree representation
  // (consumers use `expanded` and `childEntries` to render recursively)

  return {
    entries,
    expanded,
    selectedPath,
    selectedKind,
    loading,
    error,
    toggleExpand,
    select,
    reveal,
    createFile,
    createDirectory,
    deleteEntry,
    renameEntry,
    refresh,
    // Expose child entries for rendering
    ...{ childEntries },
  } as FileTreeState & FileTreeActions & { childEntries: Map<string, FileSystemEntry[]> };
}
