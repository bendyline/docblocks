import React, { useEffect, useState } from 'react';
import type { DocumentSessionConflict } from '@bendyline/docblocks/document';
import { Dialog } from '../components/Dialog.js';

export interface DocumentConflictDialogProps {
  conflict: DocumentSessionConflict;
  readSavedFile: () => Promise<{ content: string | null; lastModified: string | null } | null>;
  onUseLocal: () => Promise<boolean>;
  onUseSaved: () => Promise<boolean>;
  onClose: () => void;
}

function formattedTime(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : null;
}

export default function DocumentConflictDialog({
  conflict,
  readSavedFile,
  onUseLocal,
  onUseSaved,
  onClose,
}: DocumentConflictDialogProps) {
  const [savedFile, setSavedFile] = useState<{
    content: string | null;
    lastModified: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    void readSavedFile().then(
      (file) => {
        if (!disposed) setSavedFile(file);
      },
      () => {
        // Metadata is optional; a denied read must not invent a save time or
        // prevent comparison of the two already captured branches.
        if (!disposed) setSavedFile(null);
      },
    );
    return () => {
      disposed = true;
    };
  }, [readSavedFile, conflict.targetKey, conflict.externalContent, conflict.externalVersion]);

  const capturedAt = formattedTime(conflict.recoveredDraftCapturedAt);
  // Only attach a timestamp to the exact bytes shown in this pane. A later
  // read can race a watcher; a different file is not evidence about this copy.
  const savedAt =
    savedFile?.content === conflict.externalContent ? formattedTime(savedFile?.lastModified) : null;
  const localLabel = conflict.recoveredDraft ? 'Recovery draft' : 'Your unsaved version';

  const choose = async (resolve: () => Promise<boolean>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (await resolve()) onClose();
      else setError('Could not resolve this conflict. Both versions are still available.');
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Could not resolve this conflict.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Compare document versions"
      size="full"
      className="db-conflict-dialog"
      onClose={() => {
        if (!busy) onClose();
      }}
      closeOnBackdrop={!busy}
      footer={
        <button type="button" disabled={busy} onClick={onClose}>
          Decide later
        </button>
      }
    >
      <p>
        {conflict.recoveredDraft
          ? 'This draft was recovered from a previous session. The saved file may contain newer edits.'
          : 'The saved file changed while you had unsaved edits.'}{' '}
        Compare the document text before choosing. Neither version changes until you choose.
      </p>
      <div className="db-conflict-columns" aria-busy={busy}>
        <section className="db-conflict-version" aria-label={localLabel}>
          <h3>{localLabel}</h3>
          <p className="db-conflict-metadata">
            {conflict.recoveredDraft
              ? capturedAt
                ? `Recovery copy captured: ${capturedAt}`
                : 'Recovery capture time unavailable'
              : 'Not saved in this session'}
          </p>
          <textarea
            className="db-conflict-preview"
            aria-label={`${localLabel} preview`}
            value={conflict.localContent}
            readOnly
            spellCheck={false}
          />
          <p className="db-conflict-consequence">
            Replaces the saved file with the draft shown above.
          </p>
          <button type="button" disabled={busy} onClick={() => void choose(onUseLocal)}>
            {conflict.recoveredDraft ? 'Replace file with draft' : 'Keep mine'}
          </button>
        </section>
        <section className="db-conflict-version" aria-label="Saved file">
          <h3>Saved file</h3>
          <p className="db-conflict-metadata">
            {conflict.externalContent === null
              ? 'File was deleted outside DocBlocks'
              : savedAt
                ? `File last modified: ${savedAt}`
                : 'File modification time unavailable'}
          </p>
          {conflict.externalContent === null ? (
            <div className="db-conflict-preview">The saved file no longer exists.</div>
          ) : (
            <textarea
              className="db-conflict-preview"
              aria-label="Saved file preview"
              value={conflict.externalContent}
              readOnly
              spellCheck={false}
            />
          )}
          <p className="db-conflict-consequence">
            {conflict.externalContent === null
              ? 'Discards the draft and closes this document.'
              : 'Discards the draft and opens the saved file shown above.'}
          </p>
          <button type="button" disabled={busy} onClick={() => void choose(onUseSaved)}>
            {conflict.externalContent === null ? 'Accept deletion' : 'Use saved file'}
          </button>
        </section>
      </div>
      {error && <p role="alert">{error}</p>}
    </Dialog>
  );
}
