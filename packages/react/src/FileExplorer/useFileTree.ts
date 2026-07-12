/**
 * useFileTree — hook that reads from a FileSystemProvider,
 * maintains expanded/collapsed state, and provides CRUD operations.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import {
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
}

export interface FileTreeActions {
  /** Toggle a directory's expanded state. */
  toggleExpand: (path: string) => void;
  /** Select a file or directory. */
  select: (path: string, kind: 'file' | 'directory') => void;
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

  // Track child entries for expanded directories
  const [childEntries, setChildEntries] = useState<Map<string, FileSystemEntry[]>>(new Map());

  const providerRef = useRef(provider);
  providerRef.current = provider;

  const loadRoot = useCallback(async () => {
    if (!providerRef.current) {
      setEntries([]);
      return;
    }
    setLoading(true);
    try {
      const root = await readProviderDirectory(providerRef.current, '');
      setEntries(root);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadChildren = useCallback(async (dirPath: string) => {
    if (!providerRef.current) return;
    const children = await readProviderDirectory(providerRef.current, dirPath);
    setChildEntries((prev) => {
      const next = new Map(prev);
      next.set(dirPath, children);
      return next;
    });
  }, []);

  // Load root on provider change
  useEffect(() => {
    setExpanded(new Set());
    setChildEntries(new Map());
    setSelectedPath(null);
    setSelectedKind(null);
    loadRoot();
  }, [provider, loadRoot]);

  const toggleExpand = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          // Load children when expanding
          loadChildren(path);
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
        } catch {
          // A later watcher event or window resume will retry the read.
        } finally {
          refreshing = false;
          if (refreshAgain && !disposed) requestRefresh();
        }
      })();
    };

    const subscription = providerV2.watch(requestRefresh, { onError: requestRefresh });
    void subscription.ready.catch(() => undefined);
    return () => {
      disposed = true;
      void subscription.dispose();
    };
  }, [provider]);

  // File System Access and IndexedDB do not expose a dependable external
  // watcher. Refreshing on resume catches changes made while this surface was
  // in the background without continuously polling the filesystem.
  useEffect(() => {
    if (!provider) return;
    const refreshOnFocus = () => {
      void refreshRef.current().catch(() => undefined);
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
  }, [provider]);

  const createFile = useCallback(
    async (path: string, content = '') => {
      if (!providerRef.current) return;
      const providerV2 = getFileSystemProviderV2(providerRef.current);
      if (providerV2) {
        await providerV2.writeFile(parseWorkspacePath(path), new TextEncoder().encode(content), {
          mode: 'create',
        });
      } else {
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
    toggleExpand,
    select,
    createFile,
    createDirectory,
    deleteEntry,
    renameEntry,
    refresh,
    // Expose child entries for rendering
    ...{ childEntries },
  } as FileTreeState & FileTreeActions & { childEntries: Map<string, FileSystemEntry[]> };
}
