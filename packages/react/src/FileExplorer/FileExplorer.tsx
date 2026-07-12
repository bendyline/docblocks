/**
 * FileExplorer — tree component rendering FileSystemProvider contents.
 *
 * Shows a file/folder tree with expand/collapse, selection, and a toolbar
 * for creating new files/folders.
 */

import { useCallback, useRef, useState } from 'react';
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
import { NewFileIcon, NewFolderIcon } from '../icons.js';
import { useGitContext } from '../Git/GitContext.js';
import { BADGE_GLYPHS, BADGE_LABELS, isFileDirty } from '../Git/git-status.js';

const SUPPORTED_EXTENSIONS = new Set(['.txt', '.md', '.docx', '.pdf', '.dbk', '.zip']);
const INTERNAL_DRAG_TYPE = 'application/x-docblocks-entry';

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

function normalisePath(path: string): string {
  return parseWorkspacePath(path);
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

/**
 * Hide dot-entries (`.git`, `.gitignore`, `.DS_Store`, …) — never user
 * documents — and auto-generated `<basename>_files/` companion folders,
 * which hold per-document images and version snapshots (useful to the
 * editor, noisy in the user-facing file list). Everything still exists on
 * disk; we just don't surface it in the explorer.
 */
function isHiddenEntry(entry: FileSystemEntry): boolean {
  const name = entry.path.replace(/^\/+/, '').split('/').pop() ?? '';
  if (name.startsWith('.')) return true;
  return entry.kind === 'directory' && name.endsWith('_files');
}

function filterVisible(entries: FileSystemEntry[]): FileSystemEntry[] {
  return entries.filter((e) => !isHiddenEntry(e));
}

export interface FileExplorerProps {
  /** The filesystem to display. */
  provider: FileSystemProvider | null;
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
  /** Optional className for the root element. */
  className?: string;
}

export function FileExplorer({
  provider,
  onSelect,
  onTreeMutation,
  onTreeChange,
  onImportFiles,
  className,
}: FileExplorerProps) {
  const tree = useFileTree(provider);
  const { childEntries } = tree as typeof tree & {
    childEntries: Map<string, FileSystemEntry[]>;
  };
  // Null on surfaces without git (site, tests) — everything degrades.
  const git = useGitContext();

  const [newItemName, setNewItemName] = useState('');
  const [newItemType, setNewItemType] = useState<'file' | 'directory' | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [draggedEntry, setDraggedEntry] = useState<FileSystemEntry | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const dragCounter = useRef(0);

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
    if (!newItemName.trim()) {
      setNewItemType(null);
      return;
    }
    const name = newItemName.trim();
    // Scope to currently selected folder (or root)
    const prefix =
      tree.selectedKind === 'directory' && tree.selectedPath ? `${tree.selectedPath}/` : '';
    let createdPath = `${prefix}${name}`;
    if (newItemType === 'file') {
      const filename = name.endsWith('.md') ? name : `${name}.md`;
      createdPath = `${prefix}${filename}`;
      await tree.createFile(createdPath, '');
    } else if (newItemType === 'directory') {
      await tree.createDirectory(createdPath);
    }
    setNewItemName('');
    setNewItemType(null);
    onTreeChange?.({ type: 'create', path: createdPath });
  }, [newItemName, newItemType, tree, onTreeChange]);

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

  const renderEntries = useCallback(
    (entries: FileSystemEntry[], depth: number): React.ReactNode => {
      return filterVisible(entries).map((entry) => (
        <FileTreeNode
          key={entry.path}
          entry={entry}
          depth={depth}
          expanded={tree.expanded.has(entry.path)}
          selected={tree.selectedPath === entry.path}
          badge={badgeFor(entry)}
          gitActions={gitActionsFor(entry)}
          onToggle={tree.toggleExpand}
          onSelect={handleSelect}
          onDelete={handleDelete}
          onRename={handleRename}
          draggable
          dragging={draggedEntry?.path === entry.path}
          dropTarget={dropTarget === entry.path}
          onDragStart={handleInternalDragStart}
          onDragEnd={handleInternalDragEnd}
          onDragOverEntry={handleEntryDragOver}
          onDropEntry={handleEntryDrop}
          renderChildren={(dirPath: string) => {
            const children = childEntries.get(dirPath) ?? [];
            return renderEntries(children, depth + 1);
          }}
        />
      ));
    },
    [
      tree,
      handleSelect,
      handleDelete,
      handleRename,
      childEntries,
      badgeFor,
      gitActionsFor,
      draggedEntry,
      dropTarget,
      handleInternalDragStart,
      handleInternalDragEnd,
      handleEntryDragOver,
      handleEntryDrop,
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
      {/* Toolbar */}
      <div className="db-explorer-toolbar">
        <span className="db-explorer-title">Files</span>
        <div className="db-explorer-actions">
          <button
            className="db-explorer-btn"
            onClick={() => setNewItemType('file')}
            title="New File"
            aria-label="New File"
          >
            <NewFileIcon />
          </button>
          <button
            className="db-explorer-btn"
            onClick={() => setNewItemType('directory')}
            title="New Folder"
            aria-label="New Folder"
          >
            <NewFolderIcon />
          </button>
        </div>
      </div>

      {/* New item input */}
      {newItemType && (
        <div className="db-new-item">
          <form
            className="db-new-item-row"
            onSubmit={(e) => {
              e.preventDefault();
              handleNewItemSubmit();
            }}
          >
            <input
              className="db-new-item-input"
              placeholder={newItemType === 'file' ? 'filename' : 'folder-name'}
              value={newItemName}
              onChange={(e) => setNewItemName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setNewItemType(null);
                  setNewItemName('');
                }
              }}
              autoFocus
            />
            {newItemType === 'file' && <span className="db-new-item-suffix">.md</span>}
            <button type="submit" className="db-new-item-add">
              Add
            </button>
          </form>
        </div>
      )}

      {moveError && (
        <div className="db-tree-error" role="alert">
          {moveError}
        </div>
      )}

      {/* Tree — role="tree" only when there are real treeitem children; the
          loading/empty states get a status role so axe doesn't flag the
          tree as missing required children. */}
      {tree.loading ? (
        <div className="db-tree" role="status" aria-live="polite">
          <div className="db-tree-loading">Loading...</div>
        </div>
      ) : filterVisible(tree.entries).length === 0 ? (
        <div className="db-tree">
          <div className="db-tree-empty">No files yet</div>
        </div>
      ) : (
        <div
          className={`db-tree ${dropTarget === '' ? 'db-tree--drop-target' : ''}`}
          role="tree"
          onDragOver={handleRootDragOver}
          onDrop={handleRootDrop}
        >
          {renderEntries(tree.entries, 0)}
        </div>
      )}
    </div>
  );
}
