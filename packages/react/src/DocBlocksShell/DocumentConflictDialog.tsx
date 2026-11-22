import React, { useEffect, useState } from 'react';
import { resolveFileKind } from '@bendyline/squisq-editor-react';
import { MediaContext } from '@bendyline/squisq-react';
import type { MediaProvider } from '@bendyline/squisq/schemas';
import type { DocumentSessionConflict } from '@bendyline/docblocks/document';
import { Dialog } from '../components/Dialog.js';
import { GitDiffView } from '../Git/GitDiffView.js';
import { ComparePanes } from './ComparePanes.js';
import { startsOnPhoneLayout } from './compare-layout.js';
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
  // Inline by default: it fits the middle pane, which side by side widens. On
  // a phone, only the changes: a whole document scrolled past a few edits
  // hides what there is to decide about.
  const [diffView, setDiffView] = useState<DiffView>(() =>
    startsOnPhoneLayout() ? 'changes' : 'inline',
  );
  // The pane a phone shows; wider screens show all three.
  const [pane, setPane] = useState('changes');
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

  const localTab = conflict.recoveredDraft ? 'Draft' : 'Yours';

  return (
    <Dialog
      title="Compare document versions"
      size="full"
      className="db-conflict-dialog"
      onClose={() => {
        if (!busy) onClose();
      }}
      closeOnBackdrop={!busy}
    >
      {/* The choices come first, above the versions they choose between: on a
          phone the versions run on for screens, and the decision must not
          wait at the end of them. */}
      <div className="db-compare-actions" role="group" aria-label="Choose a version">
        {combining ? (
          <>
            <button
              type="button"
              className="db-compare-choice"
              disabled={busy}
              onClick={() => void choose(() => onUseMerged!(combined))}
            >
              Save combined version
            </button>
            <button type="button" disabled={busy} onClick={() => setCombineStart(null)}>
              Back to comparing
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="db-compare-choice"
              data-side="removed"
              disabled={busy}
              onClick={() => void choose(onUseLocal)}
            >
              {conflict.recoveredDraft ? 'Use draft' : 'Keep mine'}
            </button>
            <button
              type="button"
              className="db-compare-choice"
              data-side="inserted"
              disabled={busy}
              onClick={() => void choose(onUseSaved)}
            >
              {conflict.externalContent === null ? 'Accept deletion' : 'Use saved file'}
            </button>
            {canCombine && (
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
            )}
          </>
        )}
        <button type="button" className="db-compare-later" disabled={busy} onClick={onClose}>
          Decide later
        </button>
      </div>
      {error && (
        <p className="db-compare-error" role="alert">
          {error}
        </p>
      )}
      <MediaContext.Provider value={mediaProvider ?? null}>
        {combining && (
          <section className="db-conflict-diff db-conflict-combine" aria-label="Combined version">
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
          </section>
        )}
        <ComparePanes
          active={pane}
          onSelect={setPane}
          className={diffView === 'side-by-side' ? 'db-conflict-columns--wide-diff' : undefined}
          busy={busy}
          hidden={combining}
          panes={[
            {
              key: 'local',
              tab: localTab,
              label: localLabel,
              className: 'db-conflict-version',
              side: 'removed',
              children: (
                <>
                  <h3>{localLabel}</h3>
                  <p className="db-conflict-metadata">
                    {conflict.recoveredDraft
                      ? capturedAt
                        ? `Recovery copy captured: ${capturedAt}`
                        : 'Recovery capture time unavailable'
                      : 'Not saved in this session'}
                  </p>
                  {version(localLabel, conflict.localContent)}
                </>
              ),
            },
            {
              key: 'changes',
              tab: 'Changes',
              label: 'Differences',
              className: 'db-conflict-diff',
              children: (
                <>
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
                    <span className="db-diff-mark" data-side="removed">
                      −
                    </span>{' '}
                    Only in {localLabel.toLowerCase()} ·{' '}
                    <span className="db-diff-mark" data-side="inserted">
                      +
                    </span>{' '}
                    Only in the saved file
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
                </>
              ),
            },
            {
              key: 'saved',
              tab: 'Saved file',
              label: 'Saved file',
              className: 'db-conflict-version',
              side: 'inserted',
              children: (
                <>
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
                </>
              ),
            },
          ]}
        />
      </MediaContext.Provider>
    </Dialog>
  );
}
