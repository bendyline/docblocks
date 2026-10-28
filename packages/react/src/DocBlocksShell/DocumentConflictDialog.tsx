import React, { Component, useEffect, useMemo, useState, type ReactNode } from 'react';
import { resolveFileKind } from '@bendyline/squisq-editor-react';
import { MediaContext } from '@bendyline/squisq-react';
import { LinearDocView } from '@bendyline/squisq-react/page';
import { markdownToDoc, resolveThemeForDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import type { MediaProvider } from '@bendyline/squisq/schemas';
import type { DocumentSessionConflict } from '@bendyline/docblocks/document';
import { Dialog } from '../components/Dialog.js';
import { GitDiffView } from '../Git/GitDiffView.js';

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

function VersionText({ label, content }: { label: string; content: string }) {
  return (
    <textarea
      className="db-conflict-preview"
      aria-label={`${label} preview`}
      value={content}
      readOnly
      spellCheck={false}
    />
  );
}

interface RenderBoundaryProps {
  /** A new value clears a caught error: a changed version gets another try. */
  resetKey: string;
  fallback: ReactNode;
  children: ReactNode;
}

class RenderBoundary extends Component<RenderBoundaryProps, { failed: boolean; resetKey: string }> {
  state = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: RenderBoundaryProps,
    state: { failed: boolean; resetKey: string },
  ): { failed: boolean; resetKey: string } | null {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * One version as the editor's preview draws it. A version that cannot be
 * parsed or drawn falls back to its exact text: both versions must stay
 * readable, or there is nothing to choose between.
 */
function RenderedVersion({
  label,
  content,
  defaultThemeId,
}: {
  label: string;
  content: string;
  defaultThemeId?: string;
}) {
  const rendered = useMemo(() => {
    try {
      const doc = markdownToDoc(parseMarkdown(content));
      // The workspace default applies only when the version names no theme.
      return { doc, theme: resolveThemeForDoc(doc, doc.themeId ? undefined : defaultThemeId) };
    } catch {
      return null;
    }
  }, [content, defaultThemeId]);
  const text = <VersionText label={label} content={content} />;
  if (!rendered) return text;
  return (
    <RenderBoundary resetKey={content} fallback={text}>
      <div
        className="db-conflict-preview db-conflict-preview--rendered"
        role="region"
        aria-label={`${label} preview`}
        tabIndex={0}
        style={{ background: rendered.theme.colors.background }}
      >
        <LinearDocView
          doc={rendered.doc}
          theme={rendered.theme}
          variant="document"
          showCover={false}
          thinMargins
          animationsEnabled={false}
        />
      </div>
    </RenderBoundary>
  );
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
        <div
          className={
            diffView === 'side-by-side'
              ? 'db-conflict-columns db-conflict-columns--wide-diff'
              : 'db-conflict-columns'
          }
          aria-busy={busy}
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
