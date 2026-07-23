/**
 * FileExplorer — tree component rendering FileSystemProvider contents.
 *
 * Shows a file/folder tree with expand/collapse, selection, and a toolbar
 * for creating new files/folders.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  isFileSystemMoveStateError,
  parseWorkspacePath,
  type FileSystemProvider,
  type FileSystemEntry,
} from '@bendyline/docblocks/filesystem';
import { useFileTree } from './useFileTree.js';
import {
  FileTreeNode,
  type FileTreeNodeBadge,
  type FileTreeNodeGitActions,
} from './FileTreeNode.js';
import {
  flattenVisibleRows,
  resolveActiveRow,
  treeKeyAction,
  TREE_NAV_KEYS,
} from './tree-keyboard.js';
import { NewFileIcon, NewFolderIcon, SortByLastModifiedIcon, SortByNameIcon } from '../icons.js';
import { useGitContext } from '../Git/GitContext.js';
import { BADGE_GLYPHS, BADGE_LABELS, isFileDirty } from '../Git/git-status.js';
import { PinnedDocuments } from './PinnedDocuments.js';
import type { PinnedDocumentListItem } from '../DocBlocksShell/pinned-documents.js';
import { filterVisibleFileEntries } from './entry-visibility.js';
import { sortFileEntries, type FileExplorerSortMode } from './entry-sort.js';

export type { FileExplorerSortMode } from './entry-sort.js';

const SUPPORTED_EXTENSIONS = new Set(['.txt', '.md', '.docx', '.pdf', '.dbk', '.zip']);
const INTERNAL_DRAG_TYPE = 'application/x-docblocks-entry';
/** Ties the new-item input to its error message for assistive tech. */
const NEW_ITEM_ERROR_ID = 'db-new-item-error';

export type FileTreeChange =
  | { type: 'create'; path: string; kind?: 'file' | 'directory' }
  | { type: 'delete'; path: string; kind: 'file' | 'directory' }
  | {
      type: 'move';
      oldPath: string;
      newPath: string;
      kind: 'file' | 'directory';
    };

export type FileTreeMutationHandler = (
  change: FileTreeChange,
  mutate: () => Promise<void>,
) => Promise<void>;

export interface WorkspaceMoveDestination {
  id: string;
  name: string;
}

function normalisePath(path: string): string {
  return parseWorkspacePath(path);
}

function hasEquivalentPath(paths: ReadonlySet<string>, path: string): boolean {
  const canonical = normalisePath(path);
  return (
    paths.has(path) || paths.has(canonical) || (canonical !== '' && paths.has(`/${canonical}`))
  );
}

function getEquivalentPathValue<T>(values: ReadonlyMap<string, T>, path: string): T | undefined {
  const canonical = normalisePath(path);
  return values.get(path) ?? values.get(canonical) ?? values.get(`/${canonical}`);
}

function parentPath(path: string): string {
  const clean = normalisePath(path);
  const slash = clean.lastIndexOf('/');
  return slash < 0 ? '' : clean.slice(0, slash);
}

function pathInDirectory(entry: FileSystemEntry, directoryPath: string): string {
  const prefix = directoryPath.replace(/\/+$/, '');
  if (prefix) return `${prefix}/${entry.name}`;
  return entry.path.startsWith('/') ? `/${entry.name}` : entry.name;
}

function canMoveTo(entry: FileSystemEntry, directoryPath: string): boolean {
  const source = normalisePath(entry.path);
  const target = normalisePath(directoryPath);
  if (parentPath(source) === target) return false;
  if (entry.kind === 'directory' && (target === source || target.startsWith(`${source}/`))) {
    return false;
  }
  return true;
}

function isInternalDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(INTERNAL_DRAG_TYPE);
}

export interface FileExplorerProps {
  /** The filesystem to display. */
  provider: FileSystemProvider | null;
  /** Changes after a non-watch provider has durably updated file metadata. */
  metadataRefreshKey?: string | number | null;
  /** Active document to select and reveal by expanding all ancestor folders. */
  activeFilePath?: string | null;
  /** Presentation order for files within each directory. */
  sortMode?: FileExplorerSortMode;
  /** Called when a file ordering toolbar button is selected. */
  onSortModeChange?: (mode: FileExplorerSortMode) => void;
  /** Active workspace identity, used to decorate a selected cross-workspace pin. */
  activeWorkspaceId?: string | null;
  /** Documents pinned across every workspace, shown above the active file tree. */
  pinnedDocuments?: readonly PinnedDocumentListItem[];
  /** Canonical paths pinned inside the active workspace. */
  pinnedPaths?: readonly string[];
  /** Opens a pinned document, switching workspace when necessary. */
  onPinnedDocumentSelect?: (document: PinnedDocumentListItem) => void;
  /** Removes a document from the global pinned list. */
  onPinnedDocumentUnpin?: (document: PinnedDocumentListItem) => void | Promise<void>;
  /** Renames a pinned document without requiring its workspace to be active. */
  onPinnedDocumentRename?: (document: PinnedDocumentListItem) => void | Promise<void>;
  /** Deletes a pinned document without requiring its workspace to be active. */
  onPinnedDocumentDelete?: (document: PinnedDocumentListItem) => void | Promise<void>;
  /** Pins or unpins a file in the active workspace. */
  onTogglePin?: (path: string) => void | Promise<void>;
  /** Called when any entry is selected (file or directory). */
  onSelect?: (path: string, kind: 'file' | 'directory') => void;
  /**
   * Wraps destructive tree mutations so the active document session can
   * flush, cancel, or retarget itself before storage changes.
   */
  onTreeMutation?: FileTreeMutationHandler;
  /** Called after any mutation, with move details when paths change. */
  onTreeChange?: (change?: FileTreeChange) => void;
  /** Called when supported files are dropped onto the explorer. */
  onImportFiles?: (files: File[]) => void;
  /**
   * Ask the user to confirm an irreversible delete. Resolve `false` to abort.
   * Hosts with their own dialog pass it here; otherwise the tree falls back to
   * a native prompt rather than deleting unasked.
   */
  confirmDelete?: (message: string) => boolean | Promise<boolean>;
  /** Persisted workspaces that can receive the current transient workspace. */
  moveDestinations?: readonly WorkspaceMoveDestination[];
  /** When provided, shows the transient-workspace move action above the tree. */
  onMoveToWorkspace?: (workspaceId: string) => Promise<void>;
  /** Optional className for the root element. */
  className?: string;
}

export function FileExplorer({
  provider,
  metadataRefreshKey,
  activeFilePath,
  sortMode,
  onSortModeChange,
  activeWorkspaceId,
  pinnedDocuments = [],
  pinnedPaths = [],
  onPinnedDocumentSelect,
  onPinnedDocumentUnpin,
  onPinnedDocumentRename,
  onPinnedDocumentDelete,
  onTogglePin,
  onSelect,
  onTreeMutation,
  onTreeChange,
  onImportFiles,
  confirmDelete,
  moveDestinations = [],
  onMoveToWorkspace,
  className,
}: FileExplorerProps) {
  const tree = useFileTree(provider, metadataRefreshKey, activeFilePath);
  const { childEntries, childIssues } = tree;
  const { reveal } = tree;
  // Null on surfaces without git (site, tests) — everything degrades.
  const git = useGitContext();
  const pinnedPathSet = useMemo(
    () => new Set(pinnedPaths.map((path) => normalisePath(path))),
    [pinnedPaths],
  );

  const [newItemName, setNewItemName] = useState('');
  const [uncontrolledSortMode, setUncontrolledSortMode] = useState<FileExplorerSortMode>('name');
  const selectedSortMode = sortMode ?? uncontrolledSortMode;
  const selectSortMode = useCallback(
    (mode: FileExplorerSortMode) => {
      if (sortMode === undefined) setUncontrolledSortMode(mode);
      onSortModeChange?.(mode);
    },
    [onSortModeChange, sortMode],
  );
  const [newItemType, setNewItemType] = useState<'file' | 'directory' | null>(null);
  const [newItemCreationPending, setNewItemCreationPending] = useState(false);
  const newItemCreationPendingRef = useRef(false);
  /** Failure from the new-file/new-folder form — surfaced beside its input. */
  const [newItemError, setNewItemError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [draggedEntry, setDraggedEntry] = useState<FileSystemEntry | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [movePanelOpen, setMovePanelOpen] = useState(false);
  const [moveDestinationId, setMoveDestinationId] = useState(moveDestinations[0]?.id ?? '');
  const [movingToWorkspace, setMovingToWorkspace] = useState(false);
  const [moveWorkspaceError, setMoveWorkspaceError] = useState<string | null>(null);
  const dragCounter = useRef(0);
  /** Row holding the tree's single tab stop; null until one is resolved. */
  const [activePath, setActivePath] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (moveDestinations.some((destination) => destination.id === moveDestinationId)) return;
    setMoveDestinationId(moveDestinations[0]?.id ?? '');
  }, [moveDestinationId, moveDestinations]);

  useEffect(() => {
    if (activeFilePath) reveal(activeFilePath, 'file');
  }, [activeFilePath, provider, reveal]);

  const hasSupported = useCallback((dt: DataTransfer): boolean => {
    for (const item of Array.from(dt.items)) {
      if (item.kind !== 'file') continue;
      const name = (item as DataTransferItem & { getAsFile(): File | null }).getAsFile?.()?.name;
      // During dragover the filename may not be available, so accept broadly
      if (!name) return true;
      const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
      if (SUPPORTED_EXTENSIONS.has(ext)) return true;
    }
    return dt.items.length > 0;
  }, []);

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (isInternalDrag(e.dataTransfer)) return;
      e.preventDefault();
      dragCounter.current += 1;
      if (hasSupported(e.dataTransfer)) setDragOver(true);
    },
    [hasSupported, dragCounter],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (isInternalDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (isInternalDrag(e.dataTransfer)) return;
      e.preventDefault();
      dragCounter.current -= 1;
      if (dragCounter.current <= 0) {
        dragCounter.current = 0;
        setDragOver(false);
      }
    },
    [dragCounter],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (isInternalDrag(e.dataTransfer)) return;
      e.preventDefault();
      dragCounter.current = 0;
      setDragOver(false);
      const supported = Array.from(e.dataTransfer.files).filter((f) => {
        const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase();
        return SUPPORTED_EXTENSIONS.has(ext);
      });
      if (supported.length > 0) onImportFiles?.(supported);
    },
    [onImportFiles],
  );

  const handleSelect = useCallback(
    (path: string) => {
      // Determine kind from entries (root + children)
      const findKind = (p: string): 'file' | 'directory' => {
        for (const e of tree.entries) {
          if (e.path === p) return e.kind;
        }
        for (const children of childEntries.values()) {
          for (const e of children) {
            if (e.path === p) return e.kind;
          }
        }
        return 'file';
      };
      const kind = findKind(path);
      tree.select(path, kind);
      onSelect?.(path, kind);
    },
    [tree, onSelect, childEntries],
  );

  const handleNewItemSubmit = useCallback(async () => {
    if (newItemCreationPendingRef.current) return;
    if (!newItemName.trim()) {
      setNewItemType(null);
      setNewItemError(null);
      return;
    }
    const name = newItemName.trim();
    const itemType = newItemType;
    // Scope to currently selected folder (or root)
    const prefix =
      tree.selectedKind === 'directory' && tree.selectedPath ? `${tree.selectedPath}/` : '';
    let createdPath = `${prefix}${name}`;
    setNewItemError(null);
    newItemCreationPendingRef.current = true;
    setNewItemCreationPending(true);
    try {
      if (itemType === 'file') {
        const filename = name.endsWith('.md') ? name : `${name}.md`;
        createdPath = `${prefix}${filename}`;
        await tree.createFile(createdPath, '');
        handleSelect(createdPath);
      } else if (itemType === 'directory') {
        await tree.createDirectory(createdPath);
      }
    } catch (error: unknown) {
      // `createFile`/`createDirectory` use mode:'create', which rejects
      // with already-exists on a duplicate name. The form used to swallow
      // this and sit there looking idle. Keep the typed name so the user
      // can correct it rather than retype from scratch.
      setNewItemError(error instanceof Error ? error.message : 'Unable to create this item.');
      return;
    } finally {
      newItemCreationPendingRef.current = false;
      setNewItemCreationPending(false);
    }
    setNewItemName('');
    setNewItemType(null);
    onTreeChange?.({ type: 'create', path: createdPath });
  }, [newItemName, newItemType, tree, handleSelect, onTreeChange]);

  const handleMoveToWorkspace = useCallback(async () => {
    if (!onMoveToWorkspace || !moveDestinationId || movingToWorkspace) return;
    setMovingToWorkspace(true);
    setMoveWorkspaceError(null);
    try {
      await onMoveToWorkspace(moveDestinationId);
    } catch (error: unknown) {
      setMoveWorkspaceError(
        error instanceof Error ? error.message : 'The temporary document could not be moved.',
      );
    } finally {
      setMovingToWorkspace(false);
    }
  }, [moveDestinationId, movingToWorkspace, onMoveToWorkspace]);

  const runTreeMutation = useCallback(
    async (change: FileTreeChange, mutate: () => Promise<void>) => {
      if (onTreeMutation) await onTreeMutation(change, mutate);
      else await mutate();
      onTreeChange?.(change);
    },
    [onTreeMutation, onTreeChange],
  );

  const handleDelete = useCallback(
    async (path: string, kind: 'file' | 'directory') => {
      const change: FileTreeChange = { type: 'delete', path, kind };
      await runTreeMutation(change, () => tree.deleteEntry(path));
    },
    [tree, runTreeMutation],
  );

  const handleRename = useCallback(
    async (oldPath: string, newPath: string, kind: 'file' | 'directory') => {
      setMoveError(null);
      const change: FileTreeChange = { type: 'move', oldPath, newPath, kind };
      try {
        await runTreeMutation(change, () => tree.renameEntry(oldPath, newPath, kind));
      } catch (error: unknown) {
        await tree.refresh();
        if (isFileSystemMoveStateError(error) && error.documentLocation === 'destination') {
          onTreeChange?.(change);
        }
        setMoveError(error instanceof Error ? error.message : 'Unable to move this entry.');
      }
    },
    [tree, runTreeMutation, onTreeChange],
  );

  const handleMove = useCallback(
    async (entry: FileSystemEntry, directoryPath: string) => {
      if (!canMoveTo(entry, directoryPath)) return;
      const newPath = pathInDirectory(entry, directoryPath);
      await handleRename(entry.path, newPath, entry.kind);
      if (directoryPath && !tree.expanded.has(directoryPath)) {
        tree.toggleExpand(directoryPath);
      }
    },
    [handleRename, tree],
  );

  const handleInternalDragStart = useCallback((e: React.DragEvent, entry: FileSystemEntry) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(INTERNAL_DRAG_TYPE, entry.path);
    e.dataTransfer.setData('text/plain', entry.path);
    setDraggedEntry(entry);
    setMoveError(null);
  }, []);

  const handleInternalDragEnd = useCallback(() => {
    setDraggedEntry(null);
    setDropTarget(null);
  }, []);

  const handleEntryDragOver = useCallback(
    (e: React.DragEvent, entry: FileSystemEntry) => {
      if (!isInternalDrag(e.dataTransfer)) return;
      e.stopPropagation();
      const canDrop =
        entry.kind === 'directory' && draggedEntry && canMoveTo(draggedEntry, entry.path);
      e.dataTransfer.dropEffect = canDrop ? 'move' : 'none';
      if (canDrop) {
        e.preventDefault();
        setDropTarget(entry.path);
      } else {
        setDropTarget(null);
      }
    },
    [draggedEntry],
  );

  const handleEntryDrop = useCallback(
    (e: React.DragEvent, entry: FileSystemEntry) => {
      if (!isInternalDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(null);
      if (entry.kind === 'directory' && draggedEntry) {
        void handleMove(draggedEntry, entry.path);
      }
    },
    [draggedEntry, handleMove],
  );

  const handleRootDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!isInternalDrag(e.dataTransfer) || !draggedEntry) return;
      e.preventDefault();
      e.stopPropagation();
      const canDrop = canMoveTo(draggedEntry, '');
      e.dataTransfer.dropEffect = canDrop ? 'move' : 'none';
      setDropTarget(canDrop ? '' : null);
    },
    [draggedEntry],
  );

  const handleRootDrop = useCallback(
    (e: React.DragEvent) => {
      if (!isInternalDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(null);
      if (draggedEntry) void handleMove(draggedEntry, '');
    },
    [draggedEntry, handleMove],
  );

  const badgeFor = useCallback(
    (entry: FileSystemEntry): FileTreeNodeBadge | undefined => {
      if (!git?.repo) return undefined;
      const key = entry.path.startsWith('/') ? entry.path : `/${entry.path}`;
      const kind = git.badges.get(key);
      if (!kind) return undefined;
      return { kind, glyph: BADGE_GLYPHS[kind], label: BADGE_LABELS[kind] };
    },
    [git],
  );

  const gitActionsFor = useCallback(
    (entry: FileSystemEntry): FileTreeNodeGitActions | undefined => {
      if (!git?.repo || entry.kind !== 'file') return undefined;
      const path = entry.path.startsWith('/') ? entry.path : `/${entry.path}`;
      return {
        viewChanges: isFileDirty(git.status, path)
          ? () => git.openDialog({ kind: 'diff', path })
          : undefined,
        fileHistory: () => git.openDialog({ kind: 'history', path }),
        openOnRemote: git.remoteWeb ? () => git.openOnRemote(path) : undefined,
      };
    },
    [git],
  );

  const orderedVisibleEntries = useCallback(
    (entries: readonly FileSystemEntry[]) =>
      sortFileEntries(filterVisibleFileEntries(entries), selectedSortMode),
    [selectedSortMode],
  );

  // The same walk renderEntries performs, as data — so arrow keys move
  // through exactly the rows on screen, in the order they appear.
  const visibleRows = useMemo(
    () =>
      flattenVisibleRows({
        roots: orderedVisibleEntries(tree.entries),
        childrenOf: (dirPath) =>
          orderedVisibleEntries(getEquivalentPathValue(childEntries, dirPath) ?? []),
        isExpanded: (dirPath) => hasEquivalentPath(tree.expanded, dirPath),
        isVisible: () => true,
      }),
    [tree.entries, tree.expanded, childEntries, orderedVisibleEntries],
  );

  // `selectedPath` can be slash-prefixed (reveal() takes the caller's form)
  // while entry paths are not, so match it with the explorer's own
  // equivalence rules and hand tree-keyboard an exact row path.
  const selectedRowPath = useMemo(() => {
    if (!tree.selectedPath) return null;
    const target = normalisePath(tree.selectedPath);
    return visibleRows.find((row) => normalisePath(row.path) === target)?.path ?? null;
  }, [visibleRows, tree.selectedPath]);

  // Resolved rather than stored: rows come and go (loads, deletes,
  // collapses), and the tree must never be left without a tab stop.
  const activeRowPath = resolveActiveRow(visibleRows, activePath, selectedRowPath);

  /** Move DOM focus to a row. It already exists, so this is safe to call
      synchronously from the keydown that decided to move. */
  const focusRow = useCallback((path: string) => {
    const rows = treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]');
    for (const row of rows ?? []) {
      if (row.dataset.path === path) {
        row.focus();
        return;
      }
    }
  }, []);

  const handleTreeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // React portals bubble through the component tree, so the row menu's
      // keys would arrive here too. Only real rows navigate.
      const target = e.target as HTMLElement;
      if (!target.classList?.contains('db-tree-row')) return;
      if (!TREE_NAV_KEYS.has(e.key)) return;

      const action = treeKeyAction(visibleRows, activeRowPath, e.key);
      if (action.type === 'none') {
        // Still ours: Arrow keys must not scroll the pane out from under
        // the user just because the move was a no-op at an edge.
        e.preventDefault();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      switch (action.type) {
        case 'focus':
          setActivePath(action.path);
          focusRow(action.path);
          break;
        case 'expand':
        case 'collapse':
          tree.toggleExpand(action.path);
          break;
      }
    },
    [visibleRows, activeRowPath, focusRow, tree],
  );

  const renderEntries = useCallback(
    (entries: readonly FileSystemEntry[], depth: number): React.ReactNode => {
      const visible = orderedVisibleEntries(entries);
      return visible.map((entry, index) => {
        const childIssue =
          entry.kind === 'directory' ? getEquivalentPathValue(childIssues, entry.path) : undefined;
        return (
          <FileTreeNode
            key={entry.path}
            entry={entry}
            depth={depth}
            focusable={entry.path === activeRowPath}
            posInSet={index + 1}
            setSize={visible.length}
            onRowFocus={setActivePath}
            expanded={hasEquivalentPath(tree.expanded, entry.path)}
            selected={
              tree.selectedPath !== null &&
              normalisePath(tree.selectedPath) === normalisePath(entry.path)
            }
            badge={badgeFor(entry)}
            gitActions={gitActionsFor(entry)}
            onToggle={tree.toggleExpand}
            onSelect={handleSelect}
            confirmDelete={confirmDelete}
            onDelete={handleDelete}
            onRename={handleRename}
            pinned={entry.kind === 'file' && pinnedPathSet.has(normalisePath(entry.path))}
            onTogglePin={entry.kind === 'file' ? onTogglePin : undefined}
            draggable
            dragging={draggedEntry?.path === entry.path}
            dropTarget={dropTarget === entry.path}
            onDragStart={handleInternalDragStart}
            onDragEnd={handleInternalDragEnd}
            onDragOverEntry={handleEntryDragOver}
            onDropEntry={handleEntryDrop}
            renderChildren={(dirPath: string) => {
              const children = getEquivalentPathValue(childEntries, dirPath) ?? [];
              return renderEntries(children, depth + 1);
            }}
            childError={
              childIssue ? (
                <div
                  className="db-tree-error db-tree-error--child"
                  role="alert"
                  data-directory-path={childIssue.directoryPath}
                >
                  <span>{childIssue.message}</span>{' '}
                  <button
                    type="button"
                    className="db-tree-error-retry"
                    onClick={() => void tree.retryDirectory(childIssue.directoryPath)}
                  >
                    Retry folder
                  </button>
                </div>
              ) : undefined
            }
          />
        );
      });
    },
    [
      tree,
      handleSelect,
      confirmDelete,
      handleDelete,
      handleRename,
      childEntries,
      childIssues,
      badgeFor,
      gitActionsFor,
      draggedEntry,
      dropTarget,
      handleInternalDragStart,
      handleInternalDragEnd,
      handleEntryDragOver,
      handleEntryDrop,
      activeRowPath,
      pinnedPathSet,
      onTogglePin,
      orderedVisibleEntries,
    ],
  );

  return (
    <div
      className={`db-file-explorer ${dragOver ? 'db-file-explorer--drop-active' : ''} ${className ?? ''}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {onPinnedDocumentSelect && (
        <PinnedDocuments
          documents={pinnedDocuments}
          activeWorkspaceId={activeWorkspaceId}
          activeFilePath={activeFilePath}
          onSelect={onPinnedDocumentSelect}
          onUnpin={onPinnedDocumentUnpin}
          onRename={onPinnedDocumentRename}
          onDelete={onPinnedDocumentDelete}
        />
      )}

      {/* Toolbar */}
      <div className="db-explorer-toolbar">
        <span className="db-explorer-title">Files</span>
        <div className="db-explorer-actions">
          <div className="db-explorer-sort-actions" role="group" aria-label="File sorting">
            <button
              type="button"
              className="db-explorer-btn"
              onClick={() => selectSortMode('name')}
              title="Sort by name"
              aria-label="Sort by name"
              aria-pressed={selectedSortMode === 'name'}
            >
              <SortByNameIcon />
            </button>
            <button
              type="button"
              className="db-explorer-btn"
              onClick={() => selectSortMode('last-modified')}
              title="Sort by last modified"
              aria-label="Sort by last modified"
              aria-pressed={selectedSortMode === 'last-modified'}
            >
              <SortByLastModifiedIcon />
            </button>
          </div>
          <span className="db-explorer-action-divider" aria-hidden="true" />
          <button
            type="button"
            className="db-explorer-btn"
            disabled={newItemCreationPending}
            onClick={() => {
              setNewItemError(null);
              setNewItemType('directory');
            }}
            title="New Folder"
            aria-label="New Folder"
          >
            <NewFolderIcon />
          </button>
          <button
            type="button"
            className="db-explorer-btn"
            disabled={newItemCreationPending}
            onClick={() => {
              setNewItemError(null);
              setNewItemType('file');
            }}
            title="New File"
            aria-label="New File"
          >
            <NewFileIcon />
          </button>
        </div>
      </div>

      {onMoveToWorkspace && (
        <div className="db-transient-move">
          {!movePanelOpen ? (
            <button
              type="button"
              className="db-transient-move-trigger"
              onClick={() => {
                setMoveWorkspaceError(null);
                setMovePanelOpen(true);
              }}
            >
              Move this into a workspace
            </button>
          ) : (
            <form
              className="db-transient-move-form"
              aria-label="Move this into a workspace"
              onSubmit={(event) => {
                event.preventDefault();
                void handleMoveToWorkspace();
              }}
            >
              <label className="db-transient-move-label" htmlFor="db-transient-move-destination">
                Move this document into
              </label>
              <select
                id="db-transient-move-destination"
                className="db-transient-move-select"
                value={moveDestinationId}
                disabled={movingToWorkspace || moveDestinations.length === 0}
                onChange={(event) => {
                  setMoveDestinationId(event.currentTarget.value);
                  setMoveWorkspaceError(null);
                }}
              >
                {moveDestinations.map((destination) => (
                  <option key={destination.id} value={destination.id}>
                    {destination.name}
                  </option>
                ))}
              </select>
              {moveDestinations.length === 0 && (
                <p className="db-transient-move-hint">Open or create another workspace first.</p>
              )}
              {moveWorkspaceError && (
                <div className="db-transient-move-error" role="alert">
                  {moveWorkspaceError}
                </div>
              )}
              <div className="db-transient-move-actions">
                <button
                  type="button"
                  className="db-transient-move-cancel"
                  disabled={movingToWorkspace}
                  onClick={() => {
                    setMoveWorkspaceError(null);
                    setMovePanelOpen(false);
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="db-transient-move-submit"
                  disabled={movingToWorkspace || !moveDestinationId}
                >
                  {movingToWorkspace ? 'Moving…' : 'Move'}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* New item input */}
      {newItemType && (
        <div className="db-new-item">
          <form
            className="db-new-item-row"
            aria-busy={newItemCreationPending}
            onSubmit={(e) => {
              e.preventDefault();
              void handleNewItemSubmit();
            }}
          >
            <input
              className="db-new-item-input"
              placeholder={newItemType === 'file' ? 'filename' : 'folder-name'}
              value={newItemName}
              aria-label={newItemType === 'file' ? 'New file name' : 'New folder name'}
              aria-invalid={newItemError !== null}
              aria-describedby={newItemError ? NEW_ITEM_ERROR_ID : undefined}
              disabled={newItemCreationPending}
              onChange={(e) => {
                setNewItemName(e.target.value);
                // The name changed, so the previous complaint about it no
                // longer applies.
                setNewItemError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setNewItemType(null);
                  setNewItemName('');
                  setNewItemError(null);
                }
              }}
              autoFocus
            />
            {newItemType === 'file' && <span className="db-new-item-suffix">.md</span>}
            <button type="submit" className="db-new-item-add" disabled={newItemCreationPending}>
              {newItemCreationPending ? 'Adding…' : 'Add'}
            </button>
          </form>
          {newItemError && (
            <div id={NEW_ITEM_ERROR_ID} className="db-tree-error" role="alert">
              {newItemError}
            </div>
          )}
        </div>
      )}

      {moveError && (
        <div className="db-tree-error" role="alert">
          {moveError}
        </div>
      )}

      {tree.rootIssue && (
        <div
          className="db-tree-error"
          role="alert"
          data-directory-path={tree.rootIssue.directoryPath}
        >
          <span>{tree.rootIssue.message}</span>{' '}
          <button
            type="button"
            className="db-tree-error-retry"
            onClick={() => void tree.retryDirectory('')}
          >
            Retry
          </button>
        </div>
      )}

      {/* Tree — role="tree" only when there are real treeitem children; the
          loading/empty states get a status role so axe doesn't flag the
          tree as missing required children. */}
      {tree.loading ? (
        <div className="db-tree" role="status" aria-live="polite">
          <div className="db-tree-loading">Loading...</div>
        </div>
      ) : filterVisibleFileEntries(tree.entries).length === 0 ? (
        <div className="db-tree">
          <div className="db-tree-empty">No files yet</div>
        </div>
      ) : (
        <div
          ref={treeRef}
          className={`db-tree ${dropTarget === '' ? 'db-tree--drop-target' : ''}`}
          role="tree"
          aria-label="Files"
          onDragOver={handleRootDragOver}
          onDrop={handleRootDrop}
          onKeyDown={handleTreeKeyDown}
        >
          {renderEntries(tree.entries, 0)}
        </div>
      )}
    </div>
  );
}
