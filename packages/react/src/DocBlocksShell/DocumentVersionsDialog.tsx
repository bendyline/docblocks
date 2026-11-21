import React, { useEffect, useState } from 'react';
import { resolveFileKind } from '@bendyline/squisq-editor-react';
import { MediaContext } from '@bendyline/squisq-react';
import type { MediaProvider } from '@bendyline/squisq/schemas';
import type { ConflictCopy } from '@bendyline/docblocks/filesystem';
import { Dialog } from '../components/Dialog.js';
import { GitDiffView } from '../Git/GitDiffView.js';
import { RenderedVersion, VersionText } from './ConflictVersionPreview.js';
import { describeAge } from './conflict-summary.js';
import { describeVersion, describeVersionSource } from './document-versions.js';

export interface DocumentVersionsDialogProps {
  /** Versions to look at, newest first. Never empty while the dialog is open. */
  copies: readonly ConflictCopy[];
  /**
   * `waiting` (default): versions set aside that need a decision.
   * `combined`: texts kept from before the app combined edits by itself.
   * Nothing is pending there; the dialog is for looking, and for going back.
   */
  kind?: 'waiting' | 'combined';
  /** The document as it is now, unsaved edits included. */
  currentContent: string;
  fileName: string;
  theme: 'light' | 'dark';
  defaultThemeId?: string;
  mediaProvider?: MediaProvider | null;
  /** Null when the version cannot be read right now. */
  readVersion: (copy: ConflictCopy) => Promise<string | null>;
  /**
   * Waits between further attempts when a version cannot be read. Storage that
   * syncs is often busy for a few seconds after the very conflict that set the
   * version aside, so one failed read is not an answer.
   */
  retryDelaysMs?: readonly number[];
  /** Each resolves true when done; the version then leaves the list. */
  onUse: (copy: ConflictCopy, content: string) => Promise<boolean>;
  onDiscard: (copy: ConflictCopy) => Promise<boolean>;
  /** Absent where a version cannot become a document of its own. */
  onKeepBoth?: (copy: ConflictCopy, content: string) => Promise<boolean>;
  onClose: () => void;
}

type Loaded = { path: string; content: string | null };

const READ_RETRY_DELAYS_MS: readonly number[] = Object.freeze([600, 1_500, 3_000, 6_000]);

/**
 * Review the other versions of a document that were set aside: by a sync
 * service when two devices saved it, or by DocBlocks so the user could leave
 * a document with unsaved edits. Each is compared with the document as it is
 * now; nothing changes until the user chooses.
 */
export default function DocumentVersionsDialog({
  copies,
  kind = 'waiting',
  currentContent,
  fileName,
  theme,
  defaultThemeId,
  mediaProvider,
  readVersion,
  retryDelaysMs = READ_RETRY_DELAYS_MS,
  onUse,
  onDiscard,
  onKeepBoth,
  onClose,
}: DocumentVersionsDialogProps) {
  const [selectedPath, setSelectedPath] = useState<string | null>(copies[0]?.path ?? null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  // Bumped by Try again, to read the selected version afresh.
  const [readRequest, setReadRequest] = useState(0);

  // Keep a selection as versions are resolved; the last one closes the dialog.
  const selected = copies.find((copy) => copy.path === selectedPath) ?? copies[0] ?? null;
  useEffect(() => {
    if (copies.length === 0) onClose();
  }, [copies.length, onClose]);

  useEffect(() => {
    if (!selected) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setLoaded(null);
    const read = (attempt: number) => {
      void readVersion(selected)
        .catch(() => null)
        .then((content) => {
          if (disposed) return;
          const delay = retryDelaysMs[attempt];
          if (content !== null || delay === undefined) {
            setLoaded({ path: selected.path, content });
            return;
          }
          // Still "Loading" to the reader: the copy is kept, only not readable yet.
          timer = setTimeout(() => read(attempt + 1), delay);
        });
    };
    read(0);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
    // The path identifies an immutable copy; a new array of the same copies is not a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.path, readVersion, readRequest]);

  if (!selected) return null;
  const content = loaded?.path === selected.path ? loaded.content : undefined;
  const fileKind = resolveFileKind(fileName);
  const label = describeVersionSource(selected);
  const age = describeAge(selected.capturedAt, now);
  const combined = kind === 'combined';
  const setAside = combined
    ? age
      ? `Combined ${age}`
      : 'Combined at an unknown time'
    : age
      ? `Set aside ${age}`
      : 'Set aside at an unknown time';
  const preview = (title: string, text: string) =>
    fileKind.mode === 'markdown' ? (
      <RenderedVersion label={title} content={text} defaultThemeId={defaultThemeId} />
    ) : (
      <VersionText label={title} content={text} />
    );

  const act = async (work: () => Promise<boolean>, failure: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!(await work())) setError(failure);
    } catch {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={combined ? 'Review combined versions' : 'Review other versions'}
      size="full"
      className="db-conflict-dialog db-versions-dialog"
      onClose={() => {
        if (!busy) onClose();
      }}
      closeOnBackdrop={!busy}
      footer={
        <button type="button" disabled={busy} onClick={onClose}>
          {combined ? 'Close' : 'Decide later'}
        </button>
      }
    >
      {combined ? (
        <p>
          Edits made in two places at once were combined into the document, which now has both.
          {copies.length === 1
            ? ' The text from before is kept for a week.'
            : ' The texts from before are kept for a week.'}{' '}
          There is nothing you need to do; compare if you want to check.
        </p>
      ) : (
        <p>
          {copies.length === 1
            ? 'Another version of this document was set aside instead of replacing it.'
            : `${copies.length.toLocaleString()} other versions of this document were set aside instead of replacing it.`}{' '}
          Compare each with the document as it is now. Nothing changes until you choose.
        </p>
      )}
      {copies.length > 1 && (
        <label className="db-versions-picker">
          <span>Version</span>
          <select
            value={selected.path}
            disabled={busy}
            onChange={(event) => setSelectedPath(event.currentTarget.value)}
          >
            {copies.map((copy) => (
              <option key={copy.path} value={copy.path}>
                {describeVersion(copy, now)}
              </option>
            ))}
          </select>
        </label>
      )}
      <MediaContext.Provider value={mediaProvider ?? null}>
        <div className="db-conflict-columns" aria-busy={busy || content === undefined}>
          <section className="db-conflict-version" aria-label="The document now">
            <h3>The document now</h3>
            <p className="db-conflict-metadata">What is open in the editor</p>
            {preview('The document now', currentContent)}
            <p className="db-conflict-consequence">
              {combined ? 'Has the edits from both.' : 'Keeps the document as it is.'}
            </p>
            {!combined && (
              <div className="db-versions-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () => onDiscard(selected),
                      'Could not remove that version. It is still here.',
                    )
                  }
                >
                  Discard the other version
                </button>
              </div>
            )}
          </section>
          <section className="db-conflict-diff" aria-label="Differences">
            <div className="db-conflict-diff-header">
              <h3>Differences</h3>
            </div>
            <p className="db-conflict-metadata">
              {combined
                ? '− Only in the document now · + Only in the text from before'
                : '− Only in the document now · + Only in the other version'}
            </p>
            {typeof content === 'string' ? (
              <GitDiffView
                original={currentContent}
                modified={content}
                fileName={fileName}
                language={fileKind.language}
                theme={theme}
                layout="inline"
              />
            ) : (
              <div className="db-conflict-preview" role="status">
                {content === undefined
                  ? 'Loading this version…'
                  : 'This version could not be opened just now.'}
              </div>
            )}
          </section>
          <section className="db-conflict-version" aria-label={label}>
            <h3>{label}</h3>
            <p className="db-conflict-metadata">{setAside}</p>
            {typeof content === 'string' ? (
              preview(label, content)
            ) : (
              <div className="db-conflict-preview db-versions-unread" role="status">
                {content === undefined ? (
                  'Loading this version…'
                ) : (
                  <>
                    <span>
                      This version could not be opened just now. It is still kept; nothing was lost.
                      Storage is often busy for a moment after two devices save at once.
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setReadRequest((request) => request + 1)}
                    >
                      Try again
                    </button>
                  </>
                )}
              </div>
            )}
            <p className="db-conflict-consequence">
              {combined
                ? 'Goes back to this text, without what was combined since. The text it replaces is kept for a week.'
                : 'Replaces the document with this version. The text it replaces is kept for a week.'}
            </p>
            <div className="db-versions-actions">
              <button
                type="button"
                disabled={busy || typeof content !== 'string'}
                onClick={() =>
                  void act(
                    () => onUse(selected, content as string),
                    'Could not switch to that version. Nothing was changed.',
                  )
                }
              >
                {combined ? 'Go back to this version' : 'Use this version'}
              </button>
              {onKeepBoth && (
                <button
                  type="button"
                  disabled={busy || typeof content !== 'string'}
                  title="Saves this version as a separate document beside this one"
                  onClick={() =>
                    void act(
                      () => onKeepBoth(selected, content as string),
                      'Could not save that version as its own document. It is still here.',
                    )
                  }
                >
                  Keep both
                </button>
              )}
            </div>
          </section>
        </div>
      </MediaContext.Provider>
      {error && <p role="alert">{error}</p>}
    </Dialog>
  );
}
