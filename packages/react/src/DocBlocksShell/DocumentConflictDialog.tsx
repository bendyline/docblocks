import React, { useEffect, useState } from 'react';
import { resolveFileKind } from '@bendyline/squisq-editor-react';
import { MediaContext } from '@bendyline/squisq-react';
import type { MediaProvider } from '@bendyline/squisq/schemas';
import type { DocumentSessionConflict } from '@bendyline/docblocks/document';
import { Dialog } from '../components/Dialog.js';
import { GitDiffView } from '../Git/GitDiffView.js';
import { RenderedVersion, VersionText } from './ConflictVersionPreview.js';

export interface DocumentConflictDialogProps {
  conflict: DocumentSessionConflict;
  /** The conflicting file; Markdown renders as a page, anything else as its text. */
  fileName: string;
  /** Shell color scheme, for the source diff. */
  theme: 'light' | 'dark';
  /** Theme for a version that names none, as the editor previews it. */
  defaultThemeId?: string;
  /** Resolves the document's relative images in the rendered versions. */
  mediaProvider?: MediaProvider | null;
  readSavedFile: () => Promise<{ content: string | null; lastModified: string | null } | null>;
  onUseLocal: () => Promise<boolean>;
  onUseSaved: () => Promise<boolean>;
  /**
   * Save text the user combined from both versions. When absent, or when the
   * saved file was deleted, the dialog offers only the two whole versions.
   */
  onUseMerged?: (content: string) => Promise<boolean>;
  onClose: () => void;
}

type DiffView = 'inline' | 'side-by-side' | 'changes';

const DIFF_VIEWS: ReadonlyArray<{ value: DiffView; label: string }> = [
  { value: 'inline', label: 'Inline' },
  { value: 'side-by-side', label: 'Side by side' },
  { value: 'changes', label: 'Changes only' },
];

function formattedTime(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : null;
}

export default function DocumentConflictDialog({
  conflict,
  fileName,
  theme,
  defaultThemeId,
  mediaProvider,
  readSavedFile,
  onUseLocal,
  onUseSaved,
  onUseMerged,
  onClose,
}: DocumentConflictDialogProps) {
  const [savedFile, setSavedFile] = useState<{
    content: string | null;
    lastModified: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Inline by default: it fits the middle pane, which side by side widens.
  const [diffView, setDiffView] = useState<DiffView>('inline');
  // Combining by hand: the text the editable side started from (fixed while
  // editing, so typing is never replaced) and what it holds now.
  const [combineStart, setCombineStart] = useState<string | null>(null);
  const [combined, setCombined] = useState('');
  const canCombine = onUseMerged !== undefined && conflict.externalContent !== null;
  const combining = canCombine && combineStart !== null;
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
  const fileKind = resolveFileKind(fileName);
  const version = (label: string, content: string) =>
    fileKind.mode === 'markdown' ? (
      <RenderedVersion label={label} content={content} defaultThemeId={defaultThemeId} />
    ) : (
      <VersionText label={label} content={content} />
    );

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
        Compare the two versions before choosing. Neither version changes until you choose.
      </p>
      <MediaContext.Provider value={mediaProvider ?? null}>
        {combining && (
          <section className="db-conflict-diff db-conflict-combine" aria-label="Combined version">
            <div className="db-conflict-diff-header">
              <h3>Combine both versions</h3>
              <button type="button" disabled={busy} onClick={() => setCombineStart(null)}>
                Back to comparing
              </button>
            </div>
            <p className="db-conflict-metadata">
              The saved file is shown for reference. The other side starts as{' '}
              {localLabel.toLowerCase()} and is yours to edit: type in it, or use the arrow beside a
              difference to take the saved file&rsquo;s text there.
            </p>
            <GitDiffView
              original={conflict.externalContent ?? ''}
              modified={combineStart ?? ''}
              fileName={fileName}
              language={fileKind.language}
              theme={theme}
              editable
              onModifiedChange={setCombined}
              labels={{ original: 'Saved file', modified: 'Combined version (edit here)' }}
            />
            <p className="db-conflict-consequence">
              Saves the combined version as the document. Neither original is kept.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void choose(() => onUseMerged!(combined))}
            >
              Save combined version
            </button>
          </section>
        )}
        <div
          className={
            diffView === 'side-by-side'
              ? 'db-conflict-columns db-conflict-columns--wide-diff'
              : 'db-conflict-columns'
          }
          aria-busy={busy}
          hidden={combining}
        >
          <section className="db-conflict-version" aria-label={localLabel}>
            <h3>{localLabel}</h3>
            <p className="db-conflict-metadata">
              {conflict.recoveredDraft
                ? capturedAt
                  ? `Recovery copy captured: ${capturedAt}`
                  : 'Recovery capture time unavailable'
                : 'Not saved in this session'}
            </p>
            {version(localLabel, conflict.localContent)}
            <p className="db-conflict-consequence">
              Replaces the saved file with the draft shown above.
            </p>
            <button type="button" disabled={busy} onClick={() => void choose(onUseLocal)}>
              {conflict.recoveredDraft ? 'Replace file with draft' : 'Keep mine'}
            </button>
          </section>
          <section className="db-conflict-diff" aria-label="Differences">
            <div className="db-conflict-diff-header">
              <h3>Differences</h3>
              <label className="db-conflict-diff-view">
                <span>View</span>
                <select
                  value={diffView}
                  onChange={(event) => setDiffView(event.currentTarget.value as DiffView)}
                >
                  {DIFF_VIEWS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="db-conflict-metadata">
              − Only in {localLabel.toLowerCase()} · + Only in the saved file
            </p>
            <GitDiffView
              original={conflict.localContent}
              modified={conflict.externalContent ?? ''}
              fileName={fileName}
              language={fileKind.language}
              theme={theme}
              layout={diffView === 'side-by-side' ? 'side-by-side' : 'inline'}
              changesOnly={diffView === 'changes'}
            />
            {canCombine && (
              <>
                <p className="db-conflict-consequence">
                  Want parts of both? Edit them into one version yourself.
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setCombined(conflict.localContent);
                    setCombineStart(conflict.localContent);
                  }}
                >
                  Combine by hand
                </button>
              </>
            )}
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
              version('Saved file', conflict.externalContent)
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
      </MediaContext.Provider>
      {error && <p role="alert">{error}</p>}
    </Dialog>
  );
}
