/**
 * Quick-open: jump to any document in the workspace by name or title.
 * A combobox input drives a listbox; focus never leaves the input.
 */

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { tryParseWorkspacePath } from '@bendyline/docblocks/filesystem';
import type { WorkspaceIndex, WorkspaceIndexStatus } from '@bendyline/docblocks/workspace-index';
import { Dialog } from '../components/Dialog.js';
import { HighlightedText } from '../components/HighlightedText.js';
import { rankQuickOpen, type QuickOpenItem, type QuickOpenPin } from './quick-open-ranking.js';

export interface QuickOpenDialogProps {
  readonly index: WorkspaceIndex | null;
  /** Re-renders the list as the index fills in. */
  readonly status: WorkspaceIndexStatus;
  readonly workspaceId: string;
  readonly activePath: string | null;
  /** Current workspace, most recent first. */
  readonly recent: readonly string[];
  readonly pins: readonly QuickOpenPin[];
  /** Advances when the shortcut is pressed again while open. */
  readonly focusRequest: number;
  readonly onOpen: (item: QuickOpenItem) => void;
  readonly onClose: () => void;
}

const PAGE = 10;

function statusMessage(status: WorkspaceIndexStatus, query: string, count: number): string | null {
  if (status.error) return status.error;
  if (!status.listed) return 'Listing workspace…';
  if (query.trim() && count === 0) return 'No matching documents';
  if (status.truncated) return 'Large workspace: some files are not listed.';
  return null;
}

export function QuickOpenDialog({
  index,
  status,
  workspaceId,
  activePath,
  recent,
  pins,
  focusRequest,
  onOpen,
  onClose,
}: QuickOpenDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const optionPrefix = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const canonicalActive = activePath === null ? null : tryParseWorkspacePath(activePath);

  const items = useMemo(
    () =>
      rankQuickOpen({
        query,
        workspaceId,
        files: index?.getFiles() ?? [],
        documents: index?.getDocuments() ?? [],
        recent,
        pins,
        activePath: canonicalActive,
      }),
    // `status.generation` stands in for the index's contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, workspaceId, index, status.generation, recent, pins, canonicalActive],
  );

  // A new query starts at the top, skipping the document already open.
  useEffect(() => {
    const first = items[0];
    const skipActive =
      items.length > 1 && first?.workspaceId === workspaceId && first.path === canonicalActive;
    setActive(skipActive ? 1 : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  const activeIndex = Math.min(active, Math.max(0, items.length - 1));
  const activeId = items.length > 0 ? `${optionPrefix}-${activeIndex}` : undefined;
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const move = (delta: number) => {
    if (items.length === 0) return;
    setActive(Math.max(0, Math.min(items.length - 1, activeIndex + delta)));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        break;
      case 'PageDown':
        event.preventDefault();
        move(PAGE);
        break;
      case 'PageUp':
        event.preventDefault();
        move(-PAGE);
        break;
      case 'Enter': {
        event.preventDefault();
        const chosen = items[activeIndex];
        if (chosen) onOpen(chosen);
        break;
      }
      default:
        break;
    }
  };

  const message = statusMessage(status, query, items.length);

  return (
    <Dialog
      title="Go to document"
      onClose={onClose}
      size="wide"
      placement="top"
      titleHidden
      initialFocusRef={inputRef}
      className="db-quick-open"
      bodyClassName="db-quick-open-body"
    >
      <input
        ref={inputRef}
        className="db-quick-open-input"
        type="text"
        role="combobox"
        aria-label="Go to document"
        aria-expanded={items.length > 0}
        aria-controls={listId}
        aria-activedescendant={activeId}
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
        placeholder="Search documents by name or title"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <ul id={listId} role="listbox" aria-label="Documents" className="db-quick-open-list">
        {items.map((item, position) => (
          <li
            key={item.key}
            id={`${optionPrefix}-${position}`}
            role="option"
            aria-selected={position === activeIndex}
            className={
              position === activeIndex
                ? 'db-quick-open-option db-quick-open-option--active'
                : 'db-quick-open-option'
            }
            // Keep focus in the input; a click still opens the row.
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={() => {
              if (position !== activeIndex) setActive(position);
            }}
            onClick={() => onOpen(item)}
          >
            <span className="db-quick-open-name">
              <HighlightedText text={item.name} ranges={item.nameRanges} />
            </span>
            {item.title && (
              <span className="db-quick-open-title">
                <HighlightedText text={item.title} ranges={item.titleRanges} />
              </span>
            )}
            <span className="db-quick-open-folder">
              {item.workspaceName && <>{item.workspaceName} · </>}
              <HighlightedText text={item.folder} ranges={item.folderRanges} />
            </span>
          </li>
        ))}
      </ul>
      {/* Always mounted: a live region must exist before its text changes. */}
      <p className="db-quick-open-status" role="status">
        {message}
      </p>
    </Dialog>
  );
}
