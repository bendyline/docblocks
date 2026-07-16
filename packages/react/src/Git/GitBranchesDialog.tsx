/**
 * GitBranchesDialog — switch between local branches or create a new one.
 *
 * Loads the branch list once from the host git API on mount. Remote
 * branches are display-only in v1 (a collapsed disclosure); switching and
 * creating go through the GitValue actions so errors (e.g. uncommitted
 * changes blocking a checkout) surface inline via lastResult.
 */

import { useEffect, useRef, useState } from 'react';
import type { GitBranchInfo } from '@bendyline/docblocks/host';
import { Dialog } from '../components/Dialog.js';
import { useGitContext } from './GitContext.js';

export function GitBranchesDialog({
  createFocus,
  onClose,
}: {
  createFocus?: boolean;
  onClose: () => void;
}) {
  const git = useGitContext();
  const gitApi = git?.gitApi ?? null;
  const repositoryId = git?.repositoryId ?? null;

  const [branches, setBranches] = useState<GitBranchInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const createInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!gitApi || !repositoryId) return;
    let cancelled = false;
    void gitApi.listBranches(repositoryId).then(
      (result) => {
        if (cancelled) return;
        if (result.ok) setBranches(result.value);
        else setLoadError(result.error.message || 'Could not list branches');
      },
      // A rejected call (the host went away) left the dialog on
      // "Loading branches…" forever. Fail visibly instead.
      (error: unknown) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : 'Could not list branches');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [gitApi, repositoryId]);

  if (!git) return null;

  const locals = branches?.filter((b) => b.kind === 'local') ?? [];
  const remotes = branches?.filter((b) => b.kind === 'remote') ?? [];
  const canCreate = newName.trim().length > 0 && git.busy === null;

  const handleSwitch = async (name: string) => {
    const ok = await git.switchBranch(name);
    if (ok) onClose();
  };

  const handleCreate = async () => {
    if (!canCreate) return;
    const ok = await git.createBranch(newName.trim());
    if (ok) onClose();
  };

  return (
    <Dialog
      title="Branches"
      onClose={onClose}
      initialFocusRef={createFocus ? createInputRef : undefined}
    >
      {branches === null && loadError === null && <p className="db-git-hint">Loading branches…</p>}
      {loadError !== null && (
        <p className="db-git-form-error" role="alert">
          {loadError}
        </p>
      )}
      {branches !== null && (
        <div className="db-git-branch-list">
          {locals.map((branch) =>
            branch.current ? (
              <span
                key={branch.name}
                className="db-git-branch-row db-git-branch-row--current"
                aria-current="true"
              >
                {branch.name}
              </span>
            ) : (
              <button
                key={branch.name}
                type="button"
                className="db-git-branch-row"
                disabled={git.busy !== null}
                onClick={() => void handleSwitch(branch.name)}
              >
                {branch.name}
              </button>
            ),
          )}
        </div>
      )}
      {git.lastResult?.tone === 'error' && (
        <p className="db-git-form-error" role="alert">
          {git.lastResult.message}
        </p>
      )}
      <hr />
      <div className="db-git-form-row">
        <label className="db-git-form-label" htmlFor="db-git-new-branch-name">
          New branch
        </label>
        <input
          id="db-git-new-branch-name"
          ref={createInputRef}
          className="db-git-form-input"
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleCreate();
          }}
          placeholder="feature/my-branch"
          spellCheck={false}
        />
        <button
          type="button"
          className="db-git-primary-btn"
          disabled={!canCreate}
          onClick={() => void handleCreate()}
        >
          Create
        </button>
      </div>
      {remotes.length > 0 && (
        <details>
          <summary>Remote branches ({remotes.length})</summary>
          <div className="db-git-branch-list">
            {remotes.map((branch) => (
              <span key={branch.name} className="db-git-branch-row">
                {branch.name}
              </span>
            ))}
          </div>
        </details>
      )}
    </Dialog>
  );
}
