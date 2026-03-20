/**
 * FileTreeNode — recursive tree node for the file explorer.
 */

import { useCallback, useState, useRef, useEffect } from 'react';
import type { FileSystemEntry } from '@bendyline/docblocks/filesystem';

export interface FileTreeNodeProps {
  entry: FileSystemEntry;
  depth: number;
  expanded: boolean;
  selected: boolean;
  children?: FileSystemEntry[];
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onDelete: (path: string) => Promise<void>;
  onRename: (oldPath: string, newPath: string) => Promise<void>;
  renderChildren?: (dirPath: string) => React.ReactNode;
}

export function FileTreeNode({
  entry,
  depth,
  expanded,
  selected,
  onToggle,
  onSelect,
  onDelete,
  onRename,
  renderChildren,
}: FileTreeNodeProps) {
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(entry.name);
  const [showContext, setShowContext] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const contextRef = useRef<HTMLDivElement>(null);

  const isDir = entry.kind === 'directory';
  const icon = isDir ? (expanded ? '\u25BE' : '\u25B8') : '\u00A0\u00A0';

  const handleClick = useCallback(() => {
    if (isDir) {
      onToggle(entry.path);
    }
    onSelect(entry.path);
  }, [isDir, entry.path, onToggle, onSelect]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setShowContext(!showContext);
    },
    [showContext],
  );

  const handleRenameStart = useCallback(() => {
    setRenameValue(entry.name);
    setRenaming(true);
    setShowContext(false);
  }, [entry.name]);

  const handleRenameSubmit = useCallback(async () => {
    if (renameValue && renameValue !== entry.name) {
      const parentPath = entry.path.includes('/')
        ? entry.path.slice(0, entry.path.lastIndexOf('/'))
        : '';
      const newPath = parentPath ? `${parentPath}/${renameValue}` : renameValue;
      await onRename(entry.path, newPath);
    }
    setRenaming(false);
  }, [renameValue, entry.name, entry.path, onRename]);

  const handleDeleteClick = useCallback(async () => {
    setShowContext(false);
    await onDelete(entry.path);
  }, [entry.path, onDelete]);

  // Close context menu on outside click
  useEffect(() => {
    if (!showContext) return;
    function handleOutsideClick(e: MouseEvent) {
      if (contextRef.current && !contextRef.current.contains(e.target as Node)) {
        setShowContext(false);
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [showContext]);

  // Focus input when renaming
  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming]);

  return (
    <div className="db-tree-node">
      <div
        className={`db-tree-row ${selected ? 'db-tree-row--selected' : ''}`}
        style={{ paddingLeft: depth * 16 + 4 }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        role="treeitem"
        aria-expanded={isDir ? expanded : undefined}
        aria-selected={selected}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleClick();
        }}
      >
        <span className="db-tree-icon">{icon}</span>
        {renaming ? (
          <input
            ref={inputRef}
            className="db-tree-rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleRenameSubmit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRenameSubmit();
              if (e.key === 'Escape') setRenaming(false);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="db-tree-label">{entry.name}</span>
        )}
      </div>

      {/* Context menu */}
      {showContext && (
        <div ref={contextRef} className="db-tree-context">
          <button className="db-tree-context-item" onClick={handleRenameStart}>
            Rename
          </button>
          <button
            className="db-tree-context-item db-tree-context-item--danger"
            onClick={handleDeleteClick}
          >
            Delete
          </button>
        </div>
      )}

      {/* Render children if directory is expanded */}
      {isDir && expanded && renderChildren && (
        <div className="db-tree-children" role="group">
          {renderChildren(entry.path)}
        </div>
      )}
    </div>
  );
}
