/**
 * FileTreeNode — recursive tree node for the file explorer.
 *
 * Keyboard contract (WAI-ARIA tree-view pattern). The tree is a single tab
 * stop: FileExplorer owns the roving tabindex and arrow-key navigation
 * across rows, this node owns the keys that act on the row itself.
 *
 *   Enter        activate (open file / toggle folder)
 *   F2           rename in place
 *   Delete       delete (with the same confirm as the menu item)
 *   Shift+F10 /
 *   ContextMenu  open the row's actions menu, focused on its first item
 *   Escape       close the menu and hand focus back to the row
 *
 * The "More actions" button stays out of the tab order on purpose — one
 * tab stop per row would make tabbing through a large tree unusable, which
 * is precisely what the tree pattern's roving tabindex exists to avoid.
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

/**
 * Last-resort confirmation for a host that supplies none. Native `confirm` is
 * the wrong look for the product -- `<DocBlocksShell>` passes its own dialog --
 * but silently destroying a document because no host wired one up would be
 * worse than an ugly prompt.
 */
function defaultConfirmDelete(message: string): boolean {
  if (typeof window === 'undefined') return false;
  return window.confirm(message);
}

export interface FileTreeNodeProps {
  entry: FileSystemEntry;
  depth: number;
  expanded: boolean;
  selected: boolean;
  badge?: FileTreeNodeBadge;
  gitActions?: FileTreeNodeGitActions;
  children?: FileSystemEntry[];
  /**
   * Roving tabindex: true only for the tree's single tab stop. Defaults to
   * true so a node rendered on its own is still reachable.
   */
  focusable?: boolean;
  /** 1-based position among siblings, for aria-posinset. */
  posInSet?: number;
  /** Number of siblings, for aria-setsize. */
  setSize?: number;
  /** The row took focus (click or arrow key) — move the roving tab stop. */
  onRowFocus?: (path: string) => void;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  /**
   * Ask the user to confirm an irreversible delete. Resolve `false` to abort.
   *
   * Optional so a standalone `<FileTreeNode>` still asks before destroying
   * something; hosts that have their own dialog (as `<DocBlocksShell>` does)
   * pass it here so the prompt matches the product instead of being a native
   * browser/Electron dialog.
   */
  confirmDelete?: (message: string) => boolean | Promise<boolean>;
  onDelete: (path: string, kind: 'file' | 'directory') => Promise<void>;
  onRename: (oldPath: string, newPath: string, kind: 'file' | 'directory') => Promise<void>;
  /** Whether this document is present in the shell's cross-workspace pin list. */
  pinned?: boolean;
  /** Pin or unpin this file. Omitted for directories and standalone trees. */
  onTogglePin?: (path: string) => void | Promise<void>;
  draggable?: boolean;
  dragging?: boolean;
  dropTarget?: boolean;
  onDragStart?: (event: React.DragEvent, entry: FileSystemEntry) => void;
  onDragEnd?: () => void;
  onDragOverEntry?: (event: React.DragEvent, entry: FileSystemEntry) => void;
  onDropEntry?: (event: React.DragEvent, entry: FileSystemEntry) => void;
  renderChildren?: (dirPath: string) => React.ReactNode;
  /** Path-scoped directory loading failure, rendered outside the ARIA tree group. */
  childError?: React.ReactNode;
}

export function FileTreeNode({
  entry,
  depth,
  expanded,
  selected,
  badge,
  gitActions,
  focusable = true,
  posInSet,
  setSize,
  onRowFocus,
  onToggle,
  onSelect,
  confirmDelete = defaultConfirmDelete,
  onDelete,
  onRename,
  pinned = false,
  onTogglePin,
  draggable = false,
  dragging = false,
  dropTarget = false,
  onDragStart,
  onDragEnd,
  onDragOverEntry,
  onDropEntry,
  renderChildren,
  childError,
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
  const rowRef = useRef<HTMLDivElement>(null);
  /**
   * Whether the open menu was summoned by keyboard. A pointer user's focus
   * should stay where they clicked; a keyboard user must land inside the
   * menu, and be returned to the row when it closes.
   */
  const keyboardMenuRef = useRef(false);
  /**
   * Latches once a rename attempt is under way. The input submits from both
   * Enter and blur, and Enter can be followed by a blur (the row re-renders
   * or focus moves while `onRename` is still in flight) — without this the
   * same rename fires twice, the second against an entry that no longer
   * exists.
   */
  const renameSubmittedRef = useRef(false);
  /** Return keyboard focus to the treeitem after Enter/Escape unmounts the input. */
  const returnFocusAfterRenameRef = useRef(false);

  const isDir = entry.kind === 'directory';
  const icon = expanded ? '\u25BE' : '\u25B8';
  const nestedFileInset = !isDir && depth > 0 ? 8 : 0;

  const handleClick = useCallback(() => {
    if (isDir) {
      onToggle(entry.path);
    }
    onSelect(entry.path);
  }, [isDir, entry.path, onToggle, onSelect]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    keyboardMenuRef.current = false;
    setContextPos({ x: e.clientX, y: e.clientY });
    setShowContext(true);
  }, []);

  const handleMoreClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    keyboardMenuRef.current = false;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setContextPos({ x: rect.right, y: rect.bottom });
    setShowContext(true);
  }, []);

  /** Shift+F10 / the ContextMenu key — anchor the menu under the row. */
  const openMenuByKeyboard = useCallback(() => {
    const rect = rowRef.current?.getBoundingClientRect();
    keyboardMenuRef.current = true;
    setContextPos({ x: rect ? rect.left + 16 : 0, y: rect ? rect.bottom : 0 });
    setShowContext(true);
  }, []);

  /** Close, optionally handing focus back to the row that owns the menu. */
  const closeMenu = useCallback((returnFocus: boolean) => {
    setShowContext(false);
    keyboardMenuRef.current = false;
    if (returnFocus) rowRef.current?.focus();
  }, []);

  const menuItems = useCallback(
    () =>
      [
        ...(contextRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
      ].filter((item) => !item.disabled),
    [],
  );

  const focusMenuItem = useCallback(
    (index: number) => {
      const items = menuItems();
      if (items.length === 0) return;
      // Wrap, so Up from the first item lands on the last.
      const target = items[((index % items.length) + items.length) % items.length];
      // preventScroll: the menu's own scroll listener closes it, and
      // focus()'s default scroll-into-view would trip that immediately.
      target?.focus({ preventScroll: true });
    },
    [menuItems],
  );

  const handleMenuKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Tab') {
        // Escape must not also reach a dialog/shell handler behind us.
        e.preventDefault();
        e.stopPropagation();
        closeMenu(true);
        return;
      }
      const items = menuItems();
      if (items.length === 0) return;
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          focusMenuItem(current + 1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          // -1 (nothing focused yet) wraps to the last item, as it should.
          focusMenuItem(current - 1);
          break;
        case 'Home':
          e.preventDefault();
          focusMenuItem(0);
          break;
        case 'End':
          e.preventDefault();
          focusMenuItem(items.length - 1);
          break;
        default:
          break;
      }
    },
    [closeMenu, focusMenuItem, menuItems],
  );

  const handleRenameStart = useCallback(() => {
    renameSubmittedRef.current = false;
    setActionError(null);
    setRenameValue(entry.name);
    setRenaming(true);
    // The rename input focuses itself, so don't pull focus back to the row.
    closeMenu(false);
  }, [entry.name, closeMenu]);

  /** Abandon the rename and make sure a trailing blur cannot submit it. */
  const handleRenameCancel = useCallback(() => {
    renameSubmittedRef.current = true;
    returnFocusAfterRenameRef.current = true;
    setRenaming(false);
  }, []);

  const handleRenameSubmit = useCallback(
    async (returnFocus = false) => {
      if (renameSubmittedRef.current) return;
      renameSubmittedRef.current = true;
      returnFocusAfterRenameRef.current = returnFocus;
      // Enter is a commit gesture: leave edit mode immediately instead of
      // keeping a stale textbox mounted while the filesystem move resolves.
      setRenaming(false);

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
    },
    [renameValue, entry.name, entry.path, entry.kind, onRename],
  );

  const handleDeleteClick = useCallback(async () => {
    closeMenu(false);
    setActionError(null);
    const description = entry.kind === 'directory' ? 'folder and everything inside it' : 'document';
    if (
      !(await confirmDelete(`Delete the ${description} "${entry.name}"? This cannot be undone.`))
    ) {
      return;
    }
    try {
      await onDelete(entry.path, entry.kind);
    } catch (caught: unknown) {
      // The explorer surfaces rename failures itself but lets delete
      // failures reject; without this the row silently keeps the entry.
      setActionError(caught instanceof Error ? caught.message : 'Unable to delete this entry.');
    }
  }, [entry.name, entry.path, entry.kind, confirmDelete, onDelete, closeMenu]);

  const handleTogglePin = useCallback(async () => {
    closeMenu(false);
    setActionError(null);
    try {
      await onTogglePin?.(entry.path);
    } catch (caught: unknown) {
      setActionError(
        caught instanceof Error
          ? caught.message
          : `Unable to ${pinned ? 'unpin' : 'pin'} this file.`,
      );
    }
  }, [closeMenu, entry.path, onTogglePin, pinned]);

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

  useEffect(() => {
    if (renaming || !returnFocusAfterRenameRef.current) return;
    returnFocusAfterRenameRef.current = false;
    rowRef.current?.focus({ preventScroll: true });
  }, [renaming]);

  // A keyboard-opened menu must take focus, or the keys that operate it
  // would go to the row underneath and the menu would be unreachable.
  useEffect(() => {
    if (!showContext || !keyboardMenuRef.current) return;
    focusMenuItem(0);
  }, [showContext, focusMenuItem]);

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
        ref={rowRef}
        className={`db-tree-row ${selected ? 'db-tree-row--selected' : ''} ${dragging ? 'db-tree-row--dragging' : ''} ${dropTarget ? 'db-tree-row--drop-target' : ''}`}
        style={{ paddingLeft: depth * 12 + 4 + nestedFileInset }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        draggable={draggable && !renaming}
        onDragStart={(event) => onDragStart?.(event, entry)}
        onDragEnd={onDragEnd}
        onDragOver={(event) => onDragOverEntry?.(event, entry)}
        onDrop={(event) => onDropEntry?.(event, entry)}
        role="treeitem"
        data-path={entry.path}
        aria-expanded={isDir ? expanded : undefined}
        aria-selected={selected}
        aria-label={badge ? `${entry.name}, ${badge.label}` : undefined}
        // The intermediate .db-tree-node wrapper means nesting alone does
        // not convey depth to assistive tech — state it outright.
        aria-level={depth + 1}
        aria-posinset={posInSet}
        aria-setsize={setSize}
        tabIndex={focusable ? 0 : -1}
        onFocus={(e) => {
          // Ignore focus bubbling out of the More button / rename input.
          if (e.target !== e.currentTarget) return;
          onRowFocus?.(entry.path);
        }}
        onKeyDown={(e) => {
          // Only the row itself acts. Keystrokes from nested controls (the
          // rename input) must not open the row underneath — that raced a
          // rename against a load of the pre-rename path.
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter') {
            handleClick();
            return;
          }
          if (e.key === 'F2') {
            e.preventDefault();
            handleRenameStart();
            return;
          }
          if (e.key === 'Delete') {
            e.preventDefault();
            void handleDeleteClick();
            return;
          }
          // The platform gestures for "open this row's context menu".
          if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
            e.preventDefault();
            openMenuByKeyboard();
          }
        }}
      >
        {(isDir || depth === 0) && <span className="db-tree-icon">{isDir ? icon : null}</span>}
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
              if (e.key === 'Enter') void handleRenameSubmit(true);
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
              // Advertise the keyboard route, since the tree's roving
              // tabindex deliberately keeps this button out of the tab order.
              aria-keyshortcuts="Shift+F10"
              title="More actions (Shift+F10)"
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
            role="menu"
            aria-label={`Actions for ${entry.name}`}
            onKeyDown={handleMenuKeyDown}
          >
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="db-tree-context-item"
              onClick={handleRenameStart}
            >
              Rename
            </button>
            {!isDir && onTogglePin && (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="db-tree-context-item"
                onClick={() => void handleTogglePin()}
              >
                {pinned ? 'Unpin' : 'Pin'}
              </button>
            )}
            {gitActions && (gitActions.viewChanges || gitActions.fileHistory) && (
              <>
                <div className="db-tree-context-divider" role="separator" />
                {gitActions.viewChanges && (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className="db-tree-context-item"
                    onClick={() => {
                      closeMenu(false);
                      gitActions.viewChanges?.();
                    }}
                  >
                    View changes
                  </button>
                )}
                {gitActions.fileHistory && (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className="db-tree-context-item"
                    onClick={() => {
                      closeMenu(false);
                      gitActions.fileHistory?.();
                    }}
                  >
                    File history…
                  </button>
                )}
                {gitActions.openOnRemote && (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className="db-tree-context-item"
                    onClick={() => {
                      closeMenu(false);
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
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="db-tree-context-item db-tree-context-item--danger"
              onClick={() => void handleDeleteClick()}
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
      {isDir && expanded && childError}
    </div>
  );
}
