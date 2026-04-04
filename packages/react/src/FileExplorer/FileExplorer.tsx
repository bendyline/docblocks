/**
 * FileExplorer — tree component rendering FileSystemProvider contents.
 *
 * Shows a file/folder tree with expand/collapse, selection, and a toolbar
 * for creating new files/folders.
 */

import { useCallback, useState } from 'react';
import type { FileSystemProvider, FileSystemEntry } from '@bendyline/docblocks/filesystem';
import { useFileTree } from './useFileTree.js';
import { FileTreeNode } from './FileTreeNode.js';
import { NewFileIcon, NewFolderIcon, RefreshIcon } from '../icons.js';

const SUPPORTED_EXTENSIONS = new Set(['.txt', '.md', '.docx', '.pdf', '.dbk', '.zip']);

export interface FileExplorerProps {
  /** The filesystem to display. */
  provider: FileSystemProvider | null;
  /** Called when any entry is selected (file or directory). */
  onSelect?: (path: string, kind: 'file' | 'directory') => void;
  /** Called after any mutation (create, delete, rename). */
  onTreeChange?: () => void;
  /** Called when supported files are dropped onto the explorer. */
  onImportFiles?: (files: File[]) => void;
  /** Optional className for the root element. */
  className?: string;
}

export function FileExplorer({
  provider,
  onSelect,
  onTreeChange,
  onImportFiles,
  className,
}: FileExplorerProps) {
  const tree = useFileTree(provider);
  const { childEntries } = tree as typeof tree & {
    childEntries: Map<string, FileSystemEntry[]>;
  };

  const [newItemName, setNewItemName] = useState('');
  const [newItemType, setNewItemType] = useState<'file' | 'directory' | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useState({ current: 0 })[0];

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
      e.preventDefault();
      dragCounter.current += 1;
      if (hasSupported(e.dataTransfer)) setDragOver(true);
    },
    [hasSupported, dragCounter],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDragLeave = useCallback(
    (e: React.DragEvent) => {
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
      e.preventDefault();
      dragCounter.current = 0;
      setDragOver(false);
      const supported = Array.from(e.dataTransfer.files).filter((f) => {
        const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase();
        return SUPPORTED_EXTENSIONS.has(ext);
      });
      if (supported.length > 0) onImportFiles?.(supported);
    },
    [onImportFiles, dragCounter],
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
    if (newItemType === 'file') {
      const filename = name.endsWith('.md') ? name : `${name}.md`;
      await tree.createFile(`${prefix}${filename}`, '');
    } else if (newItemType === 'directory') {
      await tree.createDirectory(`${prefix}${name}`);
    }
    setNewItemName('');
    setNewItemType(null);
    onTreeChange?.();
  }, [newItemName, newItemType, tree, onTreeChange]);

  const handleDelete = useCallback(
    async (path: string) => {
      await tree.deleteEntry(path);
      onTreeChange?.();
    },
    [tree, onTreeChange],
  );

  const handleRename = useCallback(
    async (oldPath: string, newPath: string) => {
      await tree.renameEntry(oldPath, newPath);
      onTreeChange?.();
    },
    [tree, onTreeChange],
  );

  const renderEntries = useCallback(
    (entries: FileSystemEntry[], depth: number): React.ReactNode => {
      return entries.map((entry) => (
        <FileTreeNode
          key={entry.path}
          entry={entry}
          depth={depth}
          expanded={tree.expanded.has(entry.path)}
          selected={tree.selectedPath === entry.path}
          onToggle={tree.toggleExpand}
          onSelect={handleSelect}
          onDelete={handleDelete}
          onRename={handleRename}
          renderChildren={(dirPath: string) => {
            const children = childEntries.get(dirPath) ?? [];
            return renderEntries(children, depth + 1);
          }}
        />
      ));
    },
    [tree, handleSelect, handleDelete, handleRename, childEntries],
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
          <button
            className="db-explorer-btn"
            onClick={() => tree.refresh()}
            title="Refresh file list"
            aria-label="Refresh file list"
          >
            <RefreshIcon />
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

      {/* Tree */}
      <div className="db-tree" role="tree">
        {tree.loading ? (
          <div className="db-tree-loading">Loading...</div>
        ) : tree.entries.length === 0 ? (
          <div className="db-tree-empty">No files yet</div>
        ) : (
          renderEntries(tree.entries, 0)
        )}
      </div>
    </div>
  );
}
