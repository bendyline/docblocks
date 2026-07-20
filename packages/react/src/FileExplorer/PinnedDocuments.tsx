import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreIcon, PinIcon } from '../icons.js';
import {
  pinnedDocumentDisplayPath,
  pinnedDocumentName,
  type PinnedDocumentListItem,
} from '../DocBlocksShell/pinned-documents.js';

type PinnedDocumentAction = (document: PinnedDocumentListItem) => void | Promise<void>;

export interface PinnedDocumentsProps {
  documents: readonly PinnedDocumentListItem[];
  activeWorkspaceId?: string | null;
  activeFilePath?: string | null;
  onSelect: PinnedDocumentAction;
  onUnpin?: PinnedDocumentAction;
  onRename?: PinnedDocumentAction;
  onDelete?: PinnedDocumentAction;
}

interface PinnedDocumentRowProps {
  document: PinnedDocumentListItem;
  selected: boolean;
  onSelect: PinnedDocumentAction;
  onUnpin?: PinnedDocumentAction;
  onRename?: PinnedDocumentAction;
  onDelete?: PinnedDocumentAction;
}

function displayName(document: PinnedDocumentListItem): string {
  const name = pinnedDocumentName(document);
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}

function PinnedDocumentRow({
  document: pinnedDocument,
  selected,
  onSelect,
  onUnpin,
  onRename,
  onDelete,
}: PinnedDocumentRowProps) {
  const [showContext, setShowContext] = useState(false);
  const [contextPos, setContextPos] = useState({ x: 0, y: 0 });
  const [actionError, setActionError] = useState<string | null>(null);
  const contextRef = useRef<HTMLDivElement>(null);
  const selectRef = useRef<HTMLButtonElement>(null);
  const keyboardMenuRef = useRef(false);
  const missing = pinnedDocument.availability === 'missing';
  const name = pinnedDocumentName(pinnedDocument);
  const displayPath = pinnedDocumentDisplayPath(pinnedDocument);
  const hasActions = Boolean(onUnpin || onRename || onDelete);

  const closeMenu = useCallback((returnFocus: boolean) => {
    setShowContext(false);
    keyboardMenuRef.current = false;
    if (returnFocus) selectRef.current?.focus({ preventScroll: true });
  }, []);

  const openMenuAt = useCallback((x: number, y: number, keyboard: boolean) => {
    keyboardMenuRef.current = keyboard;
    setContextPos({ x, y });
    setShowContext(true);
  }, []);

  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      if (!hasActions) return;
      event.preventDefault();
      event.stopPropagation();
      openMenuAt(event.clientX, event.clientY, false);
    },
    [hasActions, openMenuAt],
  );

  const handleMoreClick = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      openMenuAt(rect.right, rect.bottom, false);
    },
    [openMenuAt],
  );

  const openMenuByKeyboard = useCallback(() => {
    if (!hasActions) return;
    const rect = selectRef.current?.getBoundingClientRect();
    openMenuAt(rect ? rect.left + 16 : 0, rect ? rect.bottom : 0, true);
  }, [hasActions, openMenuAt]);

  const menuItems = useCallback(
    () => [...(contextRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])],
    [],
  );

  const focusMenuItem = useCallback(
    (index: number) => {
      const items = menuItems();
      if (items.length === 0) return;
      const target = items[((index % items.length) + items.length) % items.length];
      target?.focus({ preventScroll: true });
    },
    [menuItems],
  );

  const handleMenuKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        event.stopPropagation();
        closeMenu(true);
        return;
      }
      const items = menuItems();
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          focusMenuItem(current + 1);
          break;
        case 'ArrowUp':
          event.preventDefault();
          focusMenuItem(current - 1);
          break;
        case 'Home':
          event.preventDefault();
          focusMenuItem(0);
          break;
        case 'End':
          event.preventDefault();
          focusMenuItem(items.length - 1);
          break;
        default:
          break;
      }
    },
    [closeMenu, focusMenuItem, menuItems],
  );

  const runAction = useCallback(
    async (action: PinnedDocumentAction | undefined, fallbackMessage: string) => {
      closeMenu(false);
      setActionError(null);
      if (!action) return;
      try {
        await action(pinnedDocument);
      } catch (caught: unknown) {
        setActionError(caught instanceof Error ? caught.message : fallbackMessage);
      }
    },
    [closeMenu, pinnedDocument],
  );

  useEffect(() => {
    if (!showContext) return;
    function handleOutsideAction(event: Event) {
      if (!contextRef.current?.contains(event.target as Node)) setShowContext(false);
    }
    function handleScroll() {
      setShowContext(false);
    }
    document.addEventListener('click', handleOutsideAction, true);
    document.addEventListener('contextmenu', handleOutsideAction, true);
    document.addEventListener('scroll', handleScroll, { capture: true, once: true });
    return () => {
      document.removeEventListener('click', handleOutsideAction, true);
      document.removeEventListener('contextmenu', handleOutsideAction, true);
      document.removeEventListener('scroll', handleScroll, true);
    };
  }, [showContext]);

  useEffect(() => {
    if (showContext && keyboardMenuRef.current) focusMenuItem(0);
  }, [focusMenuItem, showContext]);

  useLayoutEffect(() => {
    if (!showContext || !contextRef.current) return;
    const rect = contextRef.current.getBoundingClientRect();
    setContextPos((current) => ({
      x: Math.max(4, Math.min(current.x, window.innerWidth - rect.width - 4)),
      y: Math.max(4, Math.min(current.y, window.innerHeight - rect.height - 4)),
    }));
  }, [showContext]);

  return (
    <div className={`db-pinned-document-row${selected ? ' db-pinned-document-row--selected' : ''}`}>
      <button
        ref={selectRef}
        type="button"
        className="db-pinned-document"
        aria-current={selected ? 'page' : undefined}
        aria-label={`${name}, ${displayPath}${missing ? ', missing' : ''}`}
        aria-keyshortcuts={hasActions ? 'Shift+F10' : undefined}
        title={displayPath}
        onClick={() => void onSelect(pinnedDocument)}
        onContextMenu={handleContextMenu}
        onKeyDown={(event) => {
          if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
            event.preventDefault();
            openMenuByKeyboard();
          }
        }}
      >
        <span className="db-pinned-document-heading">
          <span className="db-pinned-document-name">{displayName(pinnedDocument)}</span>
          {missing && <span className="db-pinned-document-missing">(missing)</span>}
        </span>
      </button>
      {hasActions && (
        <button
          type="button"
          className={`db-pinned-document-more${showContext ? ' db-pinned-document-more--active' : ''}`}
          aria-label={`More actions for ${name}`}
          aria-haspopup="menu"
          aria-expanded={showContext}
          title="More actions"
          onClick={handleMoreClick}
          onContextMenu={handleMoreClick}
        >
          <MoreIcon />
        </button>
      )}
      {actionError && (
        <div className="db-tree-error db-pinned-document-error" role="alert">
          {actionError}
        </div>
      )}
      {showContext &&
        createPortal(
          <div
            ref={contextRef}
            className="db-tree-context"
            style={{ left: contextPos.x, top: contextPos.y }}
            role="menu"
            aria-label={`Actions for ${name}`}
            onKeyDown={handleMenuKeyDown}
          >
            {onRename && (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="db-tree-context-item"
                onClick={() => void runAction(onRename, 'Unable to rename this document.')}
              >
                Rename
              </button>
            )}
            {onUnpin && (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="db-tree-context-item"
                onClick={() => void runAction(onUnpin, 'Unable to unpin this document.')}
              >
                Unpin
              </button>
            )}
            {onDelete && (onRename || onUnpin) && (
              <div className="db-tree-context-divider" role="separator" />
            )}
            {onDelete && (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="db-tree-context-item db-tree-context-item--danger"
                onClick={() => void runAction(onDelete, 'Unable to delete this document.')}
              >
                Delete
              </button>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

export function PinnedDocuments({
  documents,
  activeWorkspaceId,
  activeFilePath,
  onSelect,
  onUnpin,
  onRename,
  onDelete,
}: PinnedDocumentsProps) {
  const titleId = useId();
  if (documents.length === 0) return null;

  return (
    <section className="db-pinned-documents" aria-labelledby={titleId}>
      <h2 id={titleId} className="db-explorer-title db-pinned-documents-title">
        <PinIcon />
        <span>Pinned</span>
      </h2>
      <div className="db-pinned-document-list">
        {documents.map((document) => (
          <PinnedDocumentRow
            key={`${document.workspaceId}\0${document.path}`}
            document={document}
            selected={
              document.workspaceId === activeWorkspaceId &&
              document.path === activeFilePath?.replace(/^\/+|\/+$/g, '')
            }
            onSelect={onSelect}
            onUnpin={onUnpin}
            onRename={onRename}
            onDelete={onDelete}
          />
        ))}
      </div>
    </section>
  );
}
