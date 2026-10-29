import React, { useEffect, useState } from 'react';
import type { DocumentSessionConflict } from '@bendyline/docblocks/document';
import { describeConflictVersions, localVersionTime, MINUTE_MS } from './conflict-summary.js';

export interface DocumentConflictBannerProps {
  conflict: DocumentSessionConflict;
  readSavedFile: () => Promise<{ content: string | null; lastModified: string | null } | null>;
  onCompare: () => void;
  onDismiss: () => void;
}

export function DocumentConflictBanner({
  conflict,
  readSavedFile,
  onCompare,
  onDismiss,
}: DocumentConflictBannerProps) {
  const [savedAt, setSavedAt] = useState<number | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let disposed = false;
    setSavedAt(undefined);
    if (conflict.externalContent === null) return;
    void readSavedFile().then(
      (file) => {
        // Only date the exact bytes being described; a later read can race a
        // watcher, and a different file is not evidence about this copy.
        if (disposed || !file?.lastModified || file.content !== conflict.externalContent) return;
        const parsed = Date.parse(file.lastModified);
        if (Number.isFinite(parsed)) setSavedAt(parsed);
      },
      () => {
        // The save time is optional detail; the sizes still describe both branches.
      },
    );
    return () => {
      disposed = true;
    };
  }, [readSavedFile, conflict.targetKey, conflict.externalContent, conflict.externalVersion]);

  // Keep the relative times honest while the banner stays open.
  const localAt = localVersionTime(conflict);
  useEffect(() => {
    if (localAt === undefined && savedAt === undefined) return;
    const newest = Math.max(localAt ?? 0, savedAt ?? 0);
    const timer = setTimeout(
      () => setNow(Date.now()),
      Date.now() - newest < MINUTE_MS ? 5_000 : 30_000,
    );
    return () => clearTimeout(timer);
  }, [now, localAt, savedAt]);

  return (
    <div className="db-document-conflict">
      <div className="db-document-conflict-text">
        {/* Only the headline is live: the details tick and track typing. */}
        <span role="alert">
          {conflict.recoveredDraft
            ? 'A recovery draft from a previous session differs from the saved file. The saved file may be newer. Choose which version to use.'
            : 'This document changed outside DocBlocks. Your unsaved version is still intact, but saving is paused until you choose a version.'}
        </span>
        <span className="db-document-conflict-details">
          {describeConflictVersions(conflict, savedAt, now)}
        </span>
      </div>
      <div className="db-document-conflict-actions">
        <button type="button" onClick={onCompare}>
          Compare versions
        </button>
        <button type="button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

export interface DocumentConflictNoticeProps {
  onReview: () => void;
}

/**
 * What stays on screen after the banner is dismissed. The conflict still
 * blocks every save, so the window must keep saying so until it is resolved.
 */
export function DocumentConflictNotice({ onReview }: DocumentConflictNoticeProps) {
  return (
    <div className="db-document-conflict-notice" role="status">
      <span>Saving paused: this document changed outside DocBlocks.</span>
      <button type="button" onClick={onReview}>
        Review
      </button>
    </div>
  );
}
