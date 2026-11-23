/**
 * PasteDocumentDialog — one place to hand DocBlocks something you already
 * have: paste text, drag text or files in, or choose a file.
 *
 * Pasting into a field always works, on every surface, without asking for
 * clipboard permission, so this is also where "New document from clipboard"
 * falls back when the platform will not let the app read the clipboard.
 *
 * A paste or a drop acts at once: the point is to see the result. Typing is
 * still possible, and Create turns what was typed into the document.
 */

import React, { useCallback, useId, useRef, useState } from 'react';
import { Dialog } from '../components/Dialog.js';
import { IMPORT_ACCEPT } from './import-file-types.js';
import { isApplePlatform } from './keyboard-shortcuts.js';
import { contentFromDataTransfer, type PastedContent } from './pasted-document.js';

export interface PasteDocumentDialogProps {
  /** The dialog's heading. */
  title: string;
  /** Said first, e.g. why the clipboard could not be read directly. */
  notice?: string | null;
  /** Text that was pasted, dragged in or typed. */
  onContent: (content: PastedContent) => void;
  /** Files that were dropped, pasted or chosen. */
  onFiles: (files: File[]) => void;
  onClose: () => void;
}

function draggedFiles(data: DataTransfer | null): File[] {
  return data ? Array.from(data.files) : [];
}

function carriesSomething(data: DataTransfer | null): boolean {
  if (!data) return false;
  const types = Array.from(data.types);
  return types.includes('Files') || types.includes('text/plain') || types.includes('text/html');
}

export function PasteDocumentDialog({
  title,
  notice,
  onContent,
  onFiles,
  onClose,
}: PasteDocumentDialogProps) {
  const [typed, setTyped] = useState('');
  const [dragging, setDragging] = useState(false);
  const targetRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Nested children fire dragleave as the pointer crosses them.
  const dragDepth = useRef(0);
  const introId = useId();
  // A phone pastes from its own menu; the shortcut means nothing there.
  const hasKeyboard = globalThis.matchMedia?.('(any-pointer: fine)').matches ?? true;
  const placeholder = hasKeyboard
    ? `Paste here (${isApplePlatform() ? '⌘V' : 'Ctrl+V'})`
    : 'Paste here';

  const takeTransfer = useCallback(
    (data: DataTransfer | null): boolean => {
      const files = draggedFiles(data);
      if (files.length > 0) {
        onFiles(files);
        return true;
      }
      const content = contentFromDataTransfer(data);
      if (!content) return false;
      onContent(content);
      return true;
    },
    [onContent, onFiles],
  );

  const create = useCallback(() => {
    if (typed.trim()) onContent({ text: typed });
  }, [onContent, typed]);

  return (
    <Dialog
      title={title}
      size="wide"
      onClose={onClose}
      initialFocusRef={targetRef}
      // A stray click outside must not throw away what was typed.
      closeOnBackdrop={false}
      bodyClassName="db-paste-document-body"
      footer={
        <>
          <button type="button" className="db-git-secondary-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="db-git-primary-btn"
            disabled={!typed.trim()}
            onClick={create}
          >
            Create document
          </button>
        </>
      }
    >
      <div
        className={`db-paste-document${dragging ? ' db-paste-document--dragging' : ''}`}
        onDragEnter={(event) => {
          if (!carriesSomething(event.dataTransfer)) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(event) => {
          if (!carriesSomething(event.dataTransfer)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={(event) => {
          dragDepth.current = 0;
          setDragging(false);
          if (!carriesSomething(event.dataTransfer)) return;
          event.preventDefault();
          takeTransfer(event.dataTransfer);
        }}
      >
        {notice && <p className="db-paste-document-notice">{notice}</p>}
        <p id={introId}>
          Paste text from an AI chat, an email or your notes, or drop in a Word, PDF or PowerPoint
          file. DocBlocks makes it a document you can edit, present and export.
        </p>
        <textarea
          ref={targetRef}
          className="db-paste-document-target"
          aria-describedby={introId}
          aria-label="Text for the new document"
          placeholder={placeholder}
          rows={6}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onPaste={(event) => {
            if (takeTransfer(event.clipboardData)) event.preventDefault();
          }}
        />
        <div className="db-paste-document-files">
          <span>or</span>
          <button
            type="button"
            className="db-git-secondary-btn"
            onClick={() => fileInputRef.current?.click()}
          >
            Choose a file…
          </button>
          <input
            ref={fileInputRef}
            type="file"
            hidden
            multiple
            accept={IMPORT_ACCEPT}
            aria-label="Choose a file to open"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = '';
              if (files.length > 0) onFiles(files);
            }}
          />
        </div>
      </div>
    </Dialog>
  );
}
