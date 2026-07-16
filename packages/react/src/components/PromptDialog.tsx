/**
 * PromptDialog — a single-line text prompt on the shared `Dialog` primitive.
 *
 * The product's replacement for `window.prompt()`, which Electron's renderer
 * does not implement. Callers drive it through `usePromptDialog()`, which owns
 * the open/settle lifecycle; this component is only the view.
 */

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Dialog } from './Dialog.js';

export interface PromptRequest {
  /** Dialog heading, e.g. "New document". */
  title: string;
  /** Visible label for the text field, e.g. "Document name". */
  label: string;
  /** Pre-filled (and pre-selected) value. */
  initialValue?: string;
  /** Confirm button text; defaults to "OK". */
  confirmLabel?: string;
}

export interface PromptDialogProps {
  request: PromptRequest;
  /** Called exactly once with the entered value, or `null` on cancel. */
  onSettle: (value: string | null) => void;
}

export function PromptDialog({ request, onSettle }: PromptDialogProps) {
  const [value, setValue] = useState(request.initialValue ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const cancel = useCallback(() => onSettle(null), [onSettle]);
  const submit = useCallback(() => {
    // An empty name is never a meaningful answer, and every caller treats it
    // as a cancel anyway. Refuse it here so the button state matches.
    if (value.trim() === '') return;
    onSettle(value);
  }, [onSettle, value]);

  // Pre-select the seeded value so typing replaces it -- the behaviour the
  // native prompt() had, and what a rename dialog needs to feel usable.
  useEffect(() => {
    inputRef.current?.select();
  }, []);

  return (
    <Dialog
      title={request.title}
      onClose={cancel}
      initialFocusRef={inputRef}
      // A stray backdrop click must not discard something the user typed.
      closeOnBackdrop={false}
      footer={
        <>
          <button type="button" className="db-git-secondary-btn" onClick={cancel}>
            Cancel
          </button>
          <button
            type="button"
            className="db-git-primary-btn"
            disabled={value.trim() === ''}
            onClick={submit}
          >
            {request.confirmLabel ?? 'OK'}
          </button>
        </>
      }
    >
      <div className="db-git-form-row">
        <label className="db-git-form-label" htmlFor={inputId}>
          {request.label}
        </label>
        <input
          id={inputId}
          ref={inputRef}
          className="db-git-form-input"
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            // Own Enter explicitly: implicit form submission is not something
            // a bare input in a dialog gets for free.
            e.preventDefault();
            submit();
          }}
        />
      </div>
    </Dialog>
  );
}
