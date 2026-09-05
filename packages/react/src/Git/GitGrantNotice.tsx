/**
 * GitGrantNotice — the quiet offer to turn Git on for a folder that sits
 * inside a larger repository.
 *
 * Nothing is wrong when this shows: the folder simply opened without Git,
 * which is the safe default until the user says otherwise. So it reads like
 * the sidebar footer it sits above — muted, unweighted, no icon — rather
 * than a warning. It is the only git surface that renders while `repo` is
 * null; the status bar stays empty until git is actually usable.
 */

import { useGitContext } from './GitContext.js';

export function GitGrantNotice() {
  const git = useGitContext();
  if (!git || git.repo || !git.pendingGrant) return null;

  const { repositoryRoot } = git.pendingGrant;
  const detail = repositoryRoot
    ? `This folder is part of the repository ${repositoryRoot}.`
    : 'This folder is part of a larger repository.';

  return (
    <div className="db-git-grant-notice">
      <span className="db-git-grant-notice-text">Git is off for this folder</span>
      <button
        type="button"
        className="db-git-grant-notice-action"
        onClick={() => git.openDialog({ kind: 'expanded-grant' })}
        aria-label={`Enable Git for this folder. ${detail}`}
        title={detail}
      >
        Enable
      </button>
    </div>
  );
}
