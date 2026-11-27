import React from 'react';

export interface DocumentConflictNoticeProps {
  /** The text here is a draft recovered from an earlier session, not this session's typing. */
  recoveredDraft: boolean;
  onResolve: () => void;
}

/**
 * What stays on screen while a conflict blocks saving, until it is resolved.
 * It leads straight to the comparison, where the choice is made: there is
 * nothing to read in between that the comparison does not show better.
 */
export function DocumentConflictNotice({ recoveredDraft, onResolve }: DocumentConflictNoticeProps) {
  return (
    <div className="db-document-conflict-notice">
      <span role="alert">
        {recoveredDraft
          ? 'Saving paused: a recovered draft differs from the saved file.'
          : 'Saving paused: this document changed outside DocBlocks.'}
      </span>
      <button type="button" onClick={onResolve}>
        Resolve
      </button>
    </div>
  );
}
