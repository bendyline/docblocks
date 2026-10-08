/**
 * NewDocumentDialog — names a new document and picks its type, on the shared
 * `Dialog` primitive.
 *
 * The shell's counterpart to the explorer's inline new-file form, offering the
 * same types through `NewFileFormatOptions`. This component is only the view: the
 * shell creates the document from the settled choice.
 */

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Dialog } from './Dialog.js';
import { newFileName, type NewFileFormat } from '../FileExplorer/new-file-formats.js';
import { NewFileFormatOptions } from '../FileExplorer/NewFileFormatOptions.js';

export interface NewDocumentChoice {
  /** The name with the chosen type's extension. */
  filename: string;
  format: NewFileFormat;
}

export interface NewDocumentDialogProps {
  /** Called exactly once with the choice, or `null` on cancel. */
  onSettle: (choice: NewDocumentChoice | null) => void;
  /** The type preselected when the dialog opens. Defaults to Markdown. */
  initialFormat?: NewFileFormat;
}

export function NewDocumentDialog({
  onSettle,
  initialFormat = 'markdown',
}: NewDocumentDialogProps) {
  const [name, setName] = useState('Untitled');
  const [format, setFormat] = useState<NewFileFormat>(initialFormat);
  const inputRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const formatId = useId();
  const filename = newFileName(name, format);
  const cancel = useCallback(() => onSettle(null), [onSettle]);
  const submit = useCallback(() => {
    if (filename) onSettle({ filename, format });
  }, [filename, format, onSettle]);

  // Pre-select the seeded name so typing replaces it.
  useEffect(() => {
    inputRef.current?.select();
  }, []);

  return (
    <Dialog
      title="New document"
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
            disabled={filename === null}
            onClick={submit}
          >
            Create
          </button>
        </>
      }
    >
      <div className="db-new-document-fields">
        <label className="db-git-form-label" htmlFor={nameId}>
          Document name
        </label>
        <input
          id={nameId}
          ref={inputRef}
          className="db-git-form-input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            // Own Enter explicitly: implicit form submission is not something
            // a bare input in a dialog gets for free.
            e.preventDefault();
            submit();
          }}
        />
        <label className="db-git-form-label" htmlFor={formatId}>
          Type
        </label>
        <select
          id={formatId}
          className="db-git-form-input"
          value={format}
          onChange={(e) => setFormat(e.target.value as NewFileFormat)}
        >
          <NewFileFormatOptions />
        </select>
      </div>
    </Dialog>
  );
}
