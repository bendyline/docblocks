/**
 * FileTreeNode — recursive tree node for the file explorer.
 */

import { useCallback, useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import type { FileSystemEntry } from '@bendyline/docblocks/filesystem';
import { MoreIcon } from '../icons.js';

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
  const [contextPos, setContextPos] = useState({ x: 0, y: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const contextRef = useRef<HTMLDivElement>(null);
  const nodeRef = useRef<HTMLDivElement>(null);

  const isDir = entry.kind === 'directory';
  const icon = isDir ? (expanded ? '\u25BE' : '\u25B8') : '\u00A0\u00A0';

  const handleClick = useCallback(() => {
    if (isDir) {
      onToggle(entry.path);
    }
    onSelect(entry.path);
  }, [isDir, entry.path, onToggle, onSelect]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextPos({ x: e.clientX, y: e.clientY });
    setShowContext(true);
  }, []);

  const handleMoreClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setContextPos({ x: rect.right, y: rect.bottom });
    setShowContext(true);
  }, []);

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

  // Close context menu on outside click or scroll
  useEffect(() => {
    if (!showContext) return;
    function handleClose(e: Event) {
      if (contextRef.current && !contextRef.current.contains(e.target as Node)) {
        setShowContext(false);
      }
    }
    // Use click (not mousedown) so menu button clicks register first
    document.addEventListener('click', handleClose, true);
    document.addEventListener('contextmenu', handleClose, true);
    document.addEventListener('scroll', () => setShowContext(false), { capture: true, once: true });
    return () => {
      document.removeEventListener('click', handleClose, true);
      document.removeEventListener('contextmenu', handleClose, true);
    };
  }, [showContext]);

  // Focus input when renaming
  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming]);

  // Clamp menu inside viewport after it renders
  useLayoutEffect(() => {
    if (!showContext || !contextRef.current) return;
    const menu = contextRef.current;
    const rect = menu.getBoundingClientRect();
    const margin = 4;
    let left = contextPos.x;
    let top = contextPos.y;
    if (rect.right > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    if (rect.bottom > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    if (left !== contextPos.x || top !== contextPos.y) {
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
    }
  }, [showContext, contextPos]);

  return (
    <div className="db-tree-node" ref={nodeRef}>
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
          <>
            <span className="db-tree-label">
              {entry.name.endsWith('.md') ? entry.name.slice(0, -3) : entry.name}
            </span>
            <button
              type="button"
              className={`db-tree-more${showContext ? ' db-tree-more--active' : ''}`}
              onClick={handleMoreClick}
              onContextMenu={handleMoreClick}
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={showContext}
              tabIndex={-1}
            >
              <MoreIcon width={14} height={14} />
            </button>
          </>
        )}
      </div>

      {/* Context menu — portaled so ancestor overflow:hidden doesn't clip it */}
      {showContext &&
        createPortal(
          <div
            ref={contextRef}
            className="db-tree-context"
            style={{ left: contextPos.x, top: contextPos.y }}
          >
            <button className="db-tree-context-item" onClick={handleRenameStart}>
              Rename
            </button>
            <button
              className="db-tree-context-item db-tree-context-item--danger"
              onClick={handleDeleteClick}
            >
              Delete
            </button>
          </div>,
          document.body,
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
