/**
 * FileTreeNode — recursive tree node for the file explorer.
 */

import { useCallback, useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import type { FileSystemEntry } from '@bendyline/docblocks/filesystem';
import { MoreIcon } from '../icons.js';

/** Git decoration for a row — precomputed by FileExplorer so this node stays context-free. */
export interface FileTreeNodeBadge {
  kind: string;
  glyph: string;
  label: string;
}

/** Git context-menu actions, prebound to this entry's path. */
export interface FileTreeNodeGitActions {
  viewChanges?: () => void;
  fileHistory?: () => void;
  openOnRemote?: () => void;
}

export interface FileTreeNodeProps {
  entry: FileSystemEntry;
  depth: number;
  expanded: boolean;
  selected: boolean;
  badge?: FileTreeNodeBadge;
  gitActions?: FileTreeNodeGitActions;
  children?: FileSystemEntry[];
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onDelete: (path: string, kind: 'file' | 'directory') => Promise<void>;
  onRename: (oldPath: string, newPath: string, kind: 'file' | 'directory') => Promise<void>;
  draggable?: boolean;
  dragging?: boolean;
  dropTarget?: boolean;
  onDragStart?: (event: React.DragEvent, entry: FileSystemEntry) => void;
  onDragEnd?: () => void;
  onDragOverEntry?: (event: React.DragEvent, entry: FileSystemEntry) => void;
  onDropEntry?: (event: React.DragEvent, entry: FileSystemEntry) => void;
  renderChildren?: (dirPath: string) => React.ReactNode;
}

export function FileTreeNode({
  entry,
  depth,
  expanded,
  selected,
  badge,
  gitActions,
  onToggle,
  onSelect,
  onDelete,
  onRename,
  draggable = false,
  dragging = false,
  dropTarget = false,
  onDragStart,
  onDragEnd,
  onDragOverEntry,
  onDropEntry,
  renderChildren,
}: FileTreeNodeProps) {
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(entry.name);
  const [showContext, setShowContext] = useState(false);
  const [contextPos, setContextPos] = useState({ x: 0, y: 0 });
  /** Failure from this row's own async actions (delete/rename). */
  const [actionError, setActionError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const contextRef = useRef<HTMLDivElement>(null);
  const nodeRef = useRef<HTMLDivElement>(null);
  /**
   * Latches once a rename attempt is under way. The input submits from both
   * Enter and blur, and Enter can be followed by a blur (the row re-renders
   * or focus moves while `onRename` is still in flight) — without this the
   * same rename fires twice, the second against an entry that no longer
   * exists.
   */
  const renameSubmittedRef = useRef(false);

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
    renameSubmittedRef.current = false;
    setActionError(null);
    setRenameValue(entry.name);
    setRenaming(true);
    setShowContext(false);
  }, [entry.name]);

  /** Abandon the rename and make sure a trailing blur cannot submit it. */
  const handleRenameCancel = useCallback(() => {
    renameSubmittedRef.current = true;
    setRenaming(false);
  }, []);

  const handleRenameSubmit = useCallback(async () => {
    if (renameSubmittedRef.current) return;
    renameSubmittedRef.current = true;

    if (renameValue && renameValue !== entry.name) {
      const parentPath = entry.path.includes('/')
        ? entry.path.slice(0, entry.path.lastIndexOf('/'))
        : '';
      const newPath = parentPath ? `${parentPath}/${renameValue}` : renameValue;
      try {
        await onRename(entry.path, newPath, entry.kind);
      } catch (caught: unknown) {
        setActionError(caught instanceof Error ? caught.message : 'Unable to rename this entry.');
      }
    }
    setRenaming(false);
  }, [renameValue, entry.name, entry.path, entry.kind, onRename]);

  const handleDeleteClick = useCallback(async () => {
    setShowContext(false);
    setActionError(null);
    const description = entry.kind === 'directory' ? 'folder and everything inside it' : 'document';
    if (!window.confirm(`Delete the ${description} "${entry.name}"? This cannot be undone.`)) {
      return;
    }
    try {
      await onDelete(entry.path, entry.kind);
    } catch (caught: unknown) {
      // The explorer surfaces rename failures itself but lets delete
      // failures reject; without this the row silently keeps the entry.
      setActionError(caught instanceof Error ? caught.message : 'Unable to delete this entry.');
    }
  }, [entry.name, entry.path, entry.kind, onDelete]);

  // Close context menu on outside click or scroll
  useEffect(() => {
    if (!showContext) return;
    function handleClose(e: Event) {
      if (contextRef.current && !contextRef.current.contains(e.target as Node)) {
        setShowContext(false);
      }
    }
    // Named so the cleanup can actually remove it. An inline arrow left a
    // listener behind on every menu that closed by click rather than
    // scroll, each one firing setState on a possibly-unmounted row.
    function handleScrollClose() {
      setShowContext(false);
    }
    // Use click (not mousedown) so menu button clicks register first
    document.addEventListener('click', handleClose, true);
    document.addEventListener('contextmenu', handleClose, true);
    document.addEventListener('scroll', handleScrollClose, { capture: true, once: true });
    return () => {
      document.removeEventListener('click', handleClose, true);
      document.removeEventListener('contextmenu', handleClose, true);
      document.removeEventListener('scroll', handleScrollClose, true);
    };
  }, [showContext]);

  // Focus input when renaming
  useEffect(() => {
    if (renaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renaming]);

  // Active documents can be revealed after asynchronous ancestor loads. Keep
  // the selected row inside the explorer's scroll viewport once it mounts.
  useEffect(() => {
    if (selected) nodeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

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
        className={`db-tree-row ${selected ? 'db-tree-row--selected' : ''} ${dragging ? 'db-tree-row--dragging' : ''} ${dropTarget ? 'db-tree-row--drop-target' : ''}`}
        style={{ paddingLeft: depth * 16 + 4 }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        draggable={draggable && !renaming}
        onDragStart={(event) => onDragStart?.(event, entry)}
        onDragEnd={onDragEnd}
        onDragOver={(event) => onDragOverEntry?.(event, entry)}
        onDrop={(event) => onDropEntry?.(event, entry)}
        role="treeitem"
        aria-expanded={isDir ? expanded : undefined}
        aria-selected={selected}
        aria-label={badge ? `${entry.name}, ${badge.label}` : undefined}
        tabIndex={0}
        onKeyDown={(e) => {
          // Only the row itself activates on Enter. Keystrokes from nested
          // controls (the rename input) must not open the row underneath —
          // that raced a rename against a load of the pre-rename path.
          if (e.target !== e.currentTarget) return;
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
            onBlur={() => void handleRenameSubmit()}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== 'Escape') return;
              // Belt and braces with the row's own target guard: the row
              // must never see these keys.
              e.preventDefault();
              e.stopPropagation();
              if (e.key === 'Enter') void handleRenameSubmit();
              else handleRenameCancel();
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <>
            <span className="db-tree-label">
              {entry.name.endsWith('.md') ? entry.name.slice(0, -3) : entry.name}
            </span>
            {badge && (
              <span className={`db-git-badge db-git-badge--${badge.kind}`} aria-hidden="true">
                {badge.glyph}
              </span>
            )}
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
              <MoreIcon />
            </button>
          </>
        )}
      </div>

      {actionError && (
        <div className="db-tree-error" role="alert">
          {actionError}
        </div>
      )}

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
            {gitActions && (gitActions.viewChanges || gitActions.fileHistory) && (
              <>
                <div className="db-tree-context-divider" role="separator" />
                {gitActions.viewChanges && (
                  <button
                    className="db-tree-context-item"
                    onClick={() => {
                      setShowContext(false);
                      gitActions.viewChanges?.();
                    }}
                  >
                    View changes
                  </button>
                )}
                {gitActions.fileHistory && (
                  <button
                    className="db-tree-context-item"
                    onClick={() => {
                      setShowContext(false);
                      gitActions.fileHistory?.();
                    }}
                  >
                    File history…
                  </button>
                )}
                {gitActions.openOnRemote && (
                  <button
                    className="db-tree-context-item"
                    onClick={() => {
                      setShowContext(false);
                      gitActions.openOnRemote?.();
                    }}
                  >
                    Open on remote
                  </button>
                )}
                <div className="db-tree-context-divider" role="separator" />
              </>
            )}
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
