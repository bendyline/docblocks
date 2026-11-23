/**
 * DocumentTitleField — the open document's name at the left edge of the
 * editor toolbar, editable in place to rename the file.
 *
 * It shows the name the file lists do (a Markdown document without its `.md`)
 * and hands the host the full new file name: the host performs the rename
 * through the explorer, which also moves the document's companion folder and
 * retargets the open session. Enter or leaving the field commits; Escape puts
 * the current name back.
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent } from 'react';
import { renameDraft, renamedFileName } from '../FileExplorer/file-names.js';

/**
 * The field's rendered width, published on its toolbar. The field sizes to
 * the name, but the two-row toolbars need the View section beside it to fill
 * the rest of the first row exactly — that is what breaks the actions onto
 * the second — and CSS cannot read a sibling's width.
 */
export const DOCUMENT_TITLE_WIDTH_PROPERTY = '--db-document-title-used';

/** Keep `--db-document-title-used` on the field's parent in step with its width. */
function usePublishedWidth(element: HTMLElement | null): void {
  useLayoutEffect(() => {
    const parent = element?.parentElement;
    if (!element || !parent) return;
    const publish = () => {
      parent.style.setProperty(
        DOCUMENT_TITLE_WIDTH_PROPERTY,
        `${element.getBoundingClientRect().width}px`,
      );
    };
    publish();
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => publish());
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      parent.style.removeProperty(DOCUMENT_TITLE_WIDTH_PROPERTY);
    };
  }, [element]);
}

export interface DocumentTitleFieldProps {
  /** The open file's name, extension included (`notes.md`). */
  fileName: string;
  /**
   * Rename the open file to `newName`, a bare file name with its extension.
   * The host reports any failure itself; once this settles the field shows
   * whatever `fileName` then is.
   */
  onRename: (newName: string) => Promise<void>;
  /** Show the name without allowing edits. */
  readOnly?: boolean;
}

export function DocumentTitleField({
  fileName,
  onRename,
  readOnly = false,
}: DocumentTitleFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [wrapper, setWrapper] = useState<HTMLDivElement | null>(null);
  usePublishedWidth(wrapper);
  /** What the user has typed, or `null` while the field just mirrors `fileName`. */
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Enter commits and then blurs, and the blur would commit a second time —
   * against a file that no longer has the old name. Latches per edit.
   */
  const settledRef = useRef(false);
  /** A pointer focus keeps the caret where the user clicked. */
  const pointerFocusRef = useRef(false);

  const { value: shownName, selectionEnd } = renameDraft(fileName, 'file');
  const value = draft ?? shownName;

  const commit = useCallback(async () => {
    if (settledRef.current) return;
    settledRef.current = true;
    const newName = draft === null ? null : renamedFileName(fileName, draft, 'file');
    if (newName === null) {
      setDraft(null);
      return;
    }
    setBusy(true);
    try {
      await onRename(newName);
    } finally {
      setBusy(false);
      setDraft(null);
    }
  }, [draft, fileName, onRename]);

  const handleFocus = useCallback(
    (event: FocusEvent<HTMLInputElement>) => {
      settledRef.current = false;
      if (readOnly) return;
      // Keyboard focus selects the title, never the extension, as the tree's
      // rename does; a click leaves the caret where it landed.
      if (!pointerFocusRef.current) event.currentTarget.setSelectionRange(0, selectionEnd);
      pointerFocusRef.current = false;
    },
    [readOnly, selectionEnd],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        void commit();
        inputRef.current?.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        // Keep the editor (or a dialog behind it) from also handling Escape.
        event.stopPropagation();
        settledRef.current = true;
        setDraft(null);
        inputRef.current?.blur();
      }
    },
    [commit],
  );

  // The wrapper is the toolbar item: it fills the row's height with the View
  // section's surface, so the name and the View button read as one block, and
  // sizes itself to the name through `data-value` (see docblocks.css). The
  // input's `size` of 1 keeps its default width out of that measure.
  return (
    <div ref={setWrapper} className="db-document-title" data-value={value}>
      <input
        ref={inputRef}
        type="text"
        size={1}
        className="db-document-title-input"
        aria-label="Rename document"
        title={fileName}
        value={value}
        readOnly={readOnly || busy}
        aria-busy={busy || undefined}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        onPointerDown={() => {
          pointerFocusRef.current = true;
        }}
        onFocus={handleFocus}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          pointerFocusRef.current = false;
          void commit();
        }}
      />
    </div>
  );
}
