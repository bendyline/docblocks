/**
 * DocumentTitleField — the open document's name at the left edge of the
 * editor toolbar, editable in place to rename the file.
 *
 * It shows the document's name without its extension, for every type, and
 * hands the host the full new file name with that extension kept: the field
 * renames a document but never changes its type, which stays with the file
 * list's rename. The host performs the rename through the explorer, which
 * also moves the document's companion folder and retargets the open session. Enter or leaving the field commits; Escape puts
 * the current name back.
 *
 * A just-created document is named here: with `naming` set, the field takes
 * focus with the name selected, so the first thing typed replaces it.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent } from 'react';
import { renamedFromTitle, titleFieldName } from '../FileExplorer/file-names.js';

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
  /**
   * The document was just created and still has its starting name. The
   * field takes focus with the name selected once, when this turns on.
   */
  naming?: boolean;
  /**
   * What was typed while the document opened, before the field could take
   * focus (`\n` for Enter). Read once, as naming starts; it replaces the
   * selected name, and an Enter in it finishes naming.
   */
  takeTypedText?: () => string;
  /**
   * Naming is over: Enter or Escape in the field, or focus went elsewhere.
   * Reported after any rename has settled. `typedAfter` is what was typed
   * while opening after an Enter, meant for the document itself.
   */
  onNamingDone?: (how: 'enter' | 'escape' | 'blur', typedAfter: string) => void;
  /**
   * Enter or Escape is ending naming, before any rename runs. The host holds
   * keys from here: renaming reopens the document, and words typed straight
   * after Enter would otherwise land nowhere.
   */
  onNamingCommit?: () => void;
}

export function DocumentTitleField({
  fileName,
  onRename,
  readOnly = false,
  naming = false,
  takeTypedText,
  onNamingDone,
  onNamingCommit,
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
  /** Naming is under way and has not been reported done. */
  const namingOpenRef = useRef(false);
  /** Enter or Escape is closing the field; its own blur reports nothing. */
  const closingRef = useRef(false);
  const takeTypedTextRef = useRef(takeTypedText);
  takeTypedTextRef.current = takeTypedText;
  const onNamingDoneRef = useRef(onNamingDone);
  onNamingDoneRef.current = onNamingDone;
  const onNamingCommitRef = useRef(onNamingCommit);
  onNamingCommitRef.current = onNamingCommit;
  /** Tell the host naming is ending, once, while it still is under way. */
  const commitNaming = useCallback(() => {
    if (namingOpenRef.current) onNamingCommitRef.current?.();
  }, []);

  const finishNaming = useCallback((how: 'enter' | 'escape' | 'blur', typedAfter = '') => {
    if (!namingOpenRef.current) return;
    namingOpenRef.current = false;
    onNamingDoneRef.current?.(how, typedAfter);
  }, []);

  // The name alone, for every type: the field renames, it never changes type.
  const shownName = titleFieldName(fileName);
  const selectionEnd = shownName.length;
  const value = draft ?? shownName;

  const commit = useCallback(async () => {
    if (settledRef.current) return;
    settledRef.current = true;
    const newName = draft === null ? null : renamedFromTitle(fileName, draft);
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

  // Take focus as naming starts: after the frame that mounts the editor,
  // since the dialog that created the document is closing in the same
  // commit, and focus cannot land under its overlay or the welcome screen.
  useEffect(() => {
    if (!naming || readOnly) return;
    namingOpenRef.current = true;
    const frame = requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      // Focus first, then take what was held, all in this one task: no key
      // can fall between the two, and each later key reaches the field.
      input.focus();
      const typed = takeTypedTextRef.current?.() ?? '';
      if (!typed) return;
      const enter = typed.indexOf('\n');
      const name = enter < 0 ? typed : typed.slice(0, enter);
      if (enter < 0) {
        // Replaces the selected name, as typing into it would have. Written
        // to the field now as well as to state: a key arriving before React
        // renders would otherwise replace the selection, and the held text.
        input.value = name;
        input.setSelectionRange(name.length, name.length);
        setDraft(name);
        return;
      }
      // Enter was pressed while it opened: name it, then hand the rest on.
      settledRef.current = true;
      closingRef.current = true;
      commitNaming();
      const newName = name ? renamedFromTitle(fileName, name) : null;
      void (async () => {
        if (newName) {
          setBusy(true);
          try {
            await onRename(newName);
          } finally {
            setBusy(false);
            setDraft(null);
          }
        }
        inputRef.current?.blur();
        finishNaming('enter', typed.slice(enter + 1));
      })();
    });
    return () => cancelAnimationFrame(frame);
    // Only the switch matters: the name and rename handler are read as they
    // stand when naming begins.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [naming, readOnly]);

  const handleFocus = useCallback(
    (event: FocusEvent<HTMLInputElement>) => {
      settledRef.current = false;
      closingRef.current = false;
      if (readOnly) return;
      // Keyboard focus selects the whole name; a click leaves the caret where
      // it landed.
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
        closingRef.current = true;
        commitNaming();
        void commit().finally(() => finishNaming('enter'));
        inputRef.current?.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        // Keep the editor (or a dialog behind it) from also handling Escape.
        event.stopPropagation();
        settledRef.current = true;
        closingRef.current = true;
        commitNaming();
        setDraft(null);
        inputRef.current?.blur();
        finishNaming('escape');
      }
    },
    [commit, commitNaming, finishNaming],
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
          if (closingRef.current) return;
          void commit().finally(() => finishNaming('blur'));
        }}
      />
    </div>
  );
}
