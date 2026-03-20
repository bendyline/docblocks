/**
 * useFileTree — hook that reads from a FileSystemProvider,
 * maintains expanded/collapsed state, and provides CRUD operations.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { FileSystemProvider, FileSystemEntry } from '@bendyline/docblocks/filesystem';

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
  /** Rename a file or directory. */
  renameEntry: (oldPath: string, newPath: string) => Promise<void>;
  /** Force refresh the tree. */
  refresh: () => Promise<void>;
}

export function useFileTree(
  provider: FileSystemProvider | null,
): FileTreeState & FileTreeActions {
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
      const root = await providerRef.current.readDirectory('');
      setEntries(root);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadChildren = useCallback(async (dirPath: string) => {
    if (!providerRef.current) return;
    const children = await providerRef.current.readDirectory(dirPath);
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

  const createFile = useCallback(
    async (path: string, content = '') => {
      if (!providerRef.current) return;
      await providerRef.current.writeFile(path, content);
      await refresh();
    },
    [refresh],
  );

  const createDirectory = useCallback(
    async (path: string) => {
      if (!providerRef.current) return;
      await providerRef.current.createDirectory(path);
      await refresh();
    },
    [refresh],
  );

  const deleteEntry = useCallback(
    async (path: string) => {
      if (!providerRef.current) return;
      await providerRef.current.delete(path);
      if (selectedPath === path) {
        setSelectedPath(null);
        setSelectedKind(null);
      }
      await refresh();
    },
    [refresh, selectedPath],
  );

  const renameEntry = useCallback(
    async (oldPath: string, newPath: string) => {
      if (!providerRef.current) return;
      await providerRef.current.rename(oldPath, newPath);
      if (selectedPath === oldPath) {
        setSelectedPath(newPath);
      }
      await refresh();
    },
    [refresh, selectedPath],
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
