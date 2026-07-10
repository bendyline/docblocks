/**
 * GitCloneDialog — clone a remote repository into a new local workspace.
 *
 * The renderer only collects the URL; the main process shows the native
 * destination picker, streams progress back, and registers the clone as a
 * workspace. An auth failure swaps the body to the shared credential
 * guidance copy (no credentials are ever collected here).
 */

import { useEffect, useRef, useState } from 'react';
import type {
  ElectronWorkspaceInfo,
  GitCloneHandle,
  GitCloneProgress,
} from '@bendyline/docblocks/host';
import { Dialog } from '../components/Dialog.js';
import { useGitContext } from './GitContext.js';
import { deriveCloneFolderName, isLikelyGitUrl } from './git-clone-utils.js';
import { GitCredentialGuidance } from './GitAuthGuidanceDialog.js';

export function GitCloneDialog({
  onClose,
  onCloned,
}: {
  onClose: () => void;
  onCloned: (info: ElectronWorkspaceInfo) => void;
}) {
  const git = useGitContext();
  const gitApi = git?.gitApi ?? null;

  const [url, setUrl] = useState('');
  const [cloning, setCloning] = useState(false);
  const [progress, setProgress] = useState<GitCloneProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Non-null → show embedded credential guidance instead of the form. */
  const [authDetail, setAuthDetail] = useState<{ detail?: string } | null>(null);
  const handleRef = useRef<GitCloneHandle | null>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  // Closing the dialog mid-clone abandons it — kill git and clean up.
  useEffect(
    () => () => {
      handleRef.current?.cancel();
    },
    [],
  );

  if (!gitApi || typeof gitApi.clone !== 'function') return null;

  const canClone = isLikelyGitUrl(url) && !cloning;

  const handleClone = async () => {
    if (!canClone) return;
    setCloning(true);
    setError(null);
    setProgress(null);
    const handle = gitApi.clone(url.trim(), (p) => setProgress(p));
    handleRef.current = handle;
    const result = await handle.result;
    handleRef.current = null;
    setCloning(false);
    setProgress(null);
    if (!result.ok) {
      switch (result.error.code) {
        case 'invalid-url':
          setError('That doesn’t look like a valid repository URL.');
          break;
        case 'destination-exists':
          setError('A folder with that name already exists there. Pick a different location.');
          break;
        case 'auth-failed':
          setAuthDetail({ detail: result.error.message });
          break;
        case 'cancelled':
          break; // user cancelled — just return to the form
        default:
          setError(result.error.message);
      }
      return;
    }
    if (result.value === null) return; // user cancelled the destination picker
    onCloned(result.value);
  };

  const progressPercent = progress?.percent ?? null;
  const progressText =
    progress !== null
      ? `${progress.phase}…${progressPercent !== null ? ` ${Math.round(progressPercent)}%` : ''}`
      : 'Starting clone…';

  if (authDetail !== null) {
    return (
      <Dialog
        title="Clone repository"
        onClose={onClose}
        footer={
          <>
            <button
              type="button"
              className="db-git-secondary-btn"
              onClick={() => setAuthDetail(null)}
            >
              Back
            </button>
            <button type="button" className="db-git-primary-btn" onClick={onClose}>
              Close
            </button>
          </>
        }
      >
        <p className="db-settings-hint">Git could not authenticate with that remote.</p>
        <GitCredentialGuidance detail={authDetail.detail} />
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Clone repository"
      onClose={onClose}
      closeOnBackdrop={!cloning}
      initialFocusRef={urlInputRef}
      footer={
        <>
          <button
            type="button"
            className="db-git-secondary-btn"
            onClick={onClose}
            disabled={cloning}
          >
            Cancel
          </button>
          <button
            type="button"
            className="db-git-primary-btn"
            disabled={!canClone}
            onClick={() => void handleClone()}
          >
            Clone
          </button>
        </>
      }
    >
      <div className="db-git-form-row">
        <label className="db-git-form-label" htmlFor="db-git-clone-url">
          Repository URL
        </label>
        <input
          id="db-git-clone-url"
          ref={urlInputRef}
          className="db-git-form-input"
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleClone();
          }}
          placeholder="https://github.com/owner/repo.git"
          disabled={cloning}
          spellCheck={false}
        />
      </div>
      {isLikelyGitUrl(url) && (
        <p className="db-git-hint">
          Will clone into: <b>{deriveCloneFolderName(url)}</b> — you&rsquo;ll pick where next
        </p>
      )}
      <p className="db-git-hint">
        HTTPS and SSH URLs both work. You&rsquo;ll choose the destination folder in the next step.
      </p>
      {error !== null && (
        <p className="db-git-form-error" role="alert">
          {error}
        </p>
      )}
      {cloning && (
        <div className="db-git-progress">
          {progressPercent !== null && (
            <div
              className="db-git-progress-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progressPercent)}
              style={{ width: `${progressPercent}%` }}
            />
          )}
          <p className="db-git-progress-text">{progressText}</p>
          <button
            type="button"
            className="db-git-secondary-btn"
            onClick={() => handleRef.current?.cancel()}
          >
            Cancel
          </button>
        </div>
      )}
    </Dialog>
  );
}
