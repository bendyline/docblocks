/**
 * GitCommitDialog — message + per-file selection for committing changes.
 *
 * All changed files are included by default; while a merge is being
 * concluded, conflicted files are force-included (locked) because a commit
 * that omits them would not resolve the merge. Selection logic lives in
 * commit-selection.ts so it stays unit-testable.
 */

import { useRef, useState } from 'react';
import { Dialog } from '../components/Dialog.js';
import { useGitContext } from './GitContext.js';
import { BADGE_LABELS, badgeKindFor } from './git-status.js';
import {
  canCommit,
  initSelection,
  isMergeCommit,
  selectedPaths,
  setAllSelected,
  toggleSelection,
  type CommitSelection,
} from './commit-selection.js';

export function GitCommitDialog({ onClose }: { onClose: () => void }) {
  const git = useGitContext();
  const status = git?.status ?? null;
  const merging = isMergeCommit(status);

  const [message, setMessage] = useState('');
  const [selection, setSelection] = useState<CommitSelection>(() =>
    initSelection(status?.changes ?? [], merging),
  );
  const messageRef = useRef<HTMLTextAreaElement>(null);

  if (!git || !status) return null;

  const allOn = [...selection.included.values()].every(Boolean);
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
          onClick={() => setSelection((s) => setAllSelected(s, !allOn))}
        >
          {allOn ? 'Select none' : 'Select all'}
        </button>
      </div>
      <ul className="db-git-file-list">
        {status.changes.map((change) => {
          const kind = badgeKindFor(change);
          const locked = selection.locked.has(change.path);
          const checked = locked || (selection.included.get(change.path) ?? true);
          return (
            <li key={change.path} className="db-git-file-row">
              <label>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={locked}
                  onChange={() => setSelection((s) => toggleSelection(s, change.path))}
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
