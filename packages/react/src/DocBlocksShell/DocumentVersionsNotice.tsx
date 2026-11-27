import React from 'react';
import { describeVersionCount } from './document-versions.js';

export interface DocumentVersionsNoticeProps {
  count: number;
  onReview: () => void;
}

/**
 * Stays on screen while the open document has other versions waiting. Unlike
 * a save conflict it blocks nothing, so it never interrupts: it waits where
 * the conflict notice would be, which is never showing at the same time.
 */
export function DocumentVersionsNotice({ count, onReview }: DocumentVersionsNoticeProps) {
  if (count <= 0) return null;
  return (
    <div className="db-document-conflict-notice db-document-versions-notice" role="status">
      <span>{describeVersionCount(count)}</span>
      <button type="button" onClick={onReview}>
        Review
      </button>
    </div>
  );
}

export interface DocumentSessionNoticeProps {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  /** A second, quieter thing to do, such as looking at what was combined. */
  secondaryLabel?: string;
  onSecondary?: () => void;
  onDismiss: () => void;
}

/** What the app just did to the open document by itself, with a way back where there is one. */
export function DocumentSessionNotice({
  message,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondary,
  onDismiss,
}: DocumentSessionNoticeProps) {
  return (
    <div className="db-document-session-notice" role="status" aria-live="polite">
      <span>{message}</span>
      {/* Kept together, so on a phone they move below the sentence as one row. */}
      <div className="db-document-session-notice-actions">
        {actionLabel && onAction && (
          <button type="button" onClick={onAction}>
            {actionLabel}
          </button>
        )}
        {secondaryLabel && onSecondary && (
          <button type="button" onClick={onSecondary}>
            {secondaryLabel}
          </button>
        )}
        <button type="button" className="db-document-session-notice-close" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
