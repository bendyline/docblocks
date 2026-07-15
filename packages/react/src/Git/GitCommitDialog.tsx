/**
 * GitCommitDialog — message + per-file selection for committing changes.
 *
 * All changed files are included by default; while a merge is being
 * concluded, conflicted files are force-included (locked) because a commit
 * that omits them would not resolve the merge. Selection logic lives in
 * commit-selection.ts so it stays unit-testable.
 */

import { useMemo, useRef, useState } from 'react';
import { Dialog } from '../components/Dialog.js';
import { useGitContext } from './GitContext.js';
import { BADGE_LABELS, badgeKindFor } from './git-status.js';
import {
  allSelected,
  canCommit,
  isIncluded,
  isLocked,
  isMergeCommit,
  NO_OVERRIDES,
  resolveSelection,
  selectedPaths,
  setAllOverrides,
  toggleOverride,
  type CommitOverrides,
} from './commit-selection.js';

export function GitCommitDialog({ onClose }: { onClose: () => void }) {
  const git = useGitContext();
  const status = git?.status ?? null;
  const merging = isMergeCommit(status);
  const changes = status?.changes;

  const [message, setMessage] = useState('');
  /** Only the user's explicit choices persist across status refreshes. */
  const [overrides, setOverrides] = useState<CommitOverrides>(NO_OVERRIDES);
  const messageRef = useRef<HTMLTextAreaElement>(null);

  // Resolved every render against the live change list: a file that appears
  // while the dialog is open (autosave triggers a status refresh every
  // 1.5s) is rendered checked *and* committed, rather than rendered checked
  // and silently dropped from a mount-time snapshot.
  const selection = useMemo(
    () => resolveSelection(changes ?? [], merging, overrides),
    [changes, merging, overrides],
  );

  if (!git || !status) return null;

  const allOn = allSelected(selection);
  const commitDisabled = !canCommit(message, selection) || git.busy !== null;

  const handleCommit = async () => {
    const ok = await git.commit(message, selectedPaths(selection));
    if (ok) onClose();
  };

  return (
    <Dialog
      title={merging ? 'Commit merge' : 'Commit changes'}
      onClose={onClose}
      size="wide"
      closeOnBackdrop={false}
      initialFocusRef={messageRef}
      footer={
        <>
          <button type="button" className="db-git-secondary-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="db-git-primary-btn"
            disabled={commitDisabled}
            onClick={() => void handleCommit()}
          >
            Commit
          </button>
        </>
      }
    >
      {merging && (
        <p className="db-settings-hint">
          You&rsquo;re completing a merge. Committing will conclude it.
        </p>
      )}
      <textarea
        ref={messageRef}
        className="db-git-commit-message"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Commit message"
        aria-label="Commit message"
        rows={3}
      />
      <div className="db-git-form-row">
        <button
          type="button"
          className="db-git-secondary-btn"
          onClick={() => setOverrides(setAllOverrides(selection, !allOn))}
        >
          {allOn ? 'Select none' : 'Select all'}
        </button>
      </div>
      <ul className="db-git-file-list">
        {status.changes.map((change) => {
          const kind = badgeKindFor(change);
          const locked = isLocked(selection, change.path);
          const checked = isIncluded(selection, change.path);
          return (
            <li key={change.path} className="db-git-file-row">
              <label>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={locked}
                  onChange={() => setOverrides((o) => toggleOverride(o, selection, change.path))}
                />
                <span>{change.path.replace(/^\/+/, '')}</span>
              </label>
              <span className="db-git-file-kind">{BADGE_LABELS[kind]}</span>
            </li>
          );
        })}
      </ul>
      {git.lastResult?.tone === 'error' && (
        <p className="db-git-form-error" role="alert">
          {git.lastResult.message}
        </p>
      )}
    </Dialog>
  );
}
