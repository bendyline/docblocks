/**
 * GitExpandedGrantDialog — the in-app replacement for the native
 * "Allow access to the full Git repository?" message box.
 *
 * Opening a folder that happens to live inside a big repository used to pop
 * a modal before the user had asked for anything git-related. Now git simply
 * stays off, the status bar carries a warning chip, and this dialog is what
 * that chip opens: the same disclosure, on the user's schedule, with the
 * answer remembered so it is asked at most once per repository.
 */

import { useState } from 'react';
import { useGitContext } from './GitContext.js';
import { Dialog } from '../components/Dialog.js';

export function GitExpandedGrantDialog({ onClose }: { onClose: () => void }) {
  const git = useGitContext();
  const [always, setAlways] = useState(false);
  if (!git) return null;

  const repositoryRoot = git.pendingGrant?.repositoryRoot ?? null;

  return (
    <Dialog
      title="Enable Git for this folder?"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="db-git-secondary-btn" onClick={onClose}>
            Not now
          </button>
          <button
            type="button"
            className="db-git-primary-btn"
            disabled={git.grantBusy}
            onClick={() => {
              void git.enableExpandedRepo({ always }).then(() => onClose());
            }}
          >
            {git.grantBusy ? 'Enabling…' : 'Enable Git'}
          </button>
        </>
      }
    >
      <p className="db-settings-hint">
        This folder is part of a larger Git repository. Git operations such as pull, branch
        switching, and commit can change files outside the folder you opened.
      </p>
      {repositoryRoot && (
        <p className="db-git-hint">
          Repository: <code>{repositoryRoot}</code>
        </p>
      )}
      <label className="db-git-grant-remember">
        <input
          type="checkbox"
          checked={always}
          onChange={(event) => setAlways(event.target.checked)}
        />
        <span>Enable Git for every folder inside a repository, without asking</span>
      </label>
      <p className="db-settings-hint">
        DocBlocks remembers this repository either way. You can turn the choice back off by removing
        it from the desktop settings file.
      </p>
    </Dialog>
  );
}
