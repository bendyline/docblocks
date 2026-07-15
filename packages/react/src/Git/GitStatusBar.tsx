/**
 * GitStatusBar — slim sidebar row showing branch, ahead/behind, and dirty
 * count, with the repo actions menu (commit, sync, branches, history,
 * remote conveniences). Renders nothing unless the active workspace is a
 * git repository.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useGitContext } from './GitContext.js';
import { formatAheadBehind, summarizeDirty } from './git-status.js';
import { useMenuKeyboard } from './useMenuKeyboard.js';

export function GitStatusBar() {
  const git = useGitContext();
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { menuRef, triggerRef, handleMenuKeyDown, handleTriggerKeyDown, closeMenu } =
    useMenuKeyboard(menuOpen, setMenuOpen);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menuOpen]);

  const runItem = useCallback(
    (action: () => void) => {
      // The item is going away; don't yank focus back to the trigger.
      closeMenu(false);
      action();
    },
    [closeMenu],
  );

  if (!git || !git.repo || !git.status) return null;

  const { status } = git;
  const branchLabel = status.detached ? 'detached HEAD' : (status.branch ?? 'no branch');
  const aheadBehind = formatAheadBehind(status);
  const dirty = summarizeDirty(status);
  const merging = status.operation === 'merge';
  const chipLabelParts = [`Git: branch ${branchLabel}`];
  if (status.ahead > 0) chipLabelParts.push(`${status.ahead} ahead`);
  if (status.behind > 0) chipLabelParts.push(`${status.behind} behind`);
  if (dirty) chipLabelParts.push(dirty);
  if (merging) chipLabelParts.push('merge in progress');

  const canCreatePr =
    git.capabilities?.ghAvailable === true && git.remoteWeb?.host === 'github.com';

  return (
    <div ref={rootRef} className="db-git-statusbar">
      <button
        ref={triggerRef}
        type="button"
        className="db-git-statusbar-chip"
        onClick={() => setMenuOpen((open) => !open)}
        onKeyDown={handleTriggerKeyDown}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={chipLabelParts.join(', ')}
        title={chipLabelParts.join(', ')}
      >
        <span className="db-git-branch-glyph" aria-hidden="true">
          {'⎇'}
        </span>
        <span className="db-git-statusbar-branch">{branchLabel}</span>
        {aheadBehind && <span className="db-git-statusbar-counts">{aheadBehind}</span>}
        {dirty && <span className="db-git-statusbar-dirty">{dirty}</span>}
        {merging && <span className="db-git-statusbar-merge">merging</span>}
        {git.busy && (
          <span className="db-git-statusbar-busy" aria-hidden="true">
            {'…'}
          </span>
        )}
      </button>

      {menuOpen && (
        <div
          ref={menuRef}
          className="db-git-menu"
          role="menu"
          aria-label="Git actions"
          onKeyDown={handleMenuKeyDown}
        >
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="db-git-menu-item"
            disabled={status.changes.length === 0 && !merging}
            onClick={() => runItem(() => git.openDialog({ kind: 'commit' }))}
          >
            {merging ? 'Commit merge…' : 'Commit…'}
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="db-git-menu-item"
            disabled={git.busy !== null}
            onClick={() => runItem(() => void git.push())}
          >
            {status.upstream === null && !status.unborn ? 'Publish branch' : 'Push'}
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="db-git-menu-item"
            disabled={git.busy !== null}
            onClick={() => runItem(() => void git.pull())}
          >
            Pull
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="db-git-menu-item"
            disabled={git.busy !== null}
            onClick={() => runItem(() => void git.fetchRemote())}
          >
            Fetch
          </button>
          <div className="db-git-menu-divider" role="separator" />
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="db-git-menu-item"
            onClick={() => runItem(() => git.openDialog({ kind: 'branches' }))}
          >
            Branches…
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="db-git-menu-item"
            onClick={() => runItem(() => git.openDialog({ kind: 'history' }))}
          >
            Commit history…
          </button>
          {(git.remoteWeb || canCreatePr) && (
            <div className="db-git-menu-divider" role="separator" />
          )}
          {git.remoteWeb && (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="db-git-menu-item"
              onClick={() => runItem(() => git.openOnRemote())}
            >
              Open on {git.remoteWeb.host}
            </button>
          )}
          {canCreatePr && (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="db-git-menu-item"
              disabled={git.busy !== null}
              onClick={() => runItem(() => void git.createPullRequest())}
            >
              Create pull request
            </button>
          )}
        </div>
      )}
    </div>
  );
}
