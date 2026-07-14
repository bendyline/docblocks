/**
 * GitUI — single mount point for the git status bar, the aria-live
 * operation result line, and every git dialog. Dialog visibility lives in
 * GitContext so the file tree, toolbar, and native menu can all open them.
 */

import type { ElectronWorkspaceInfo } from '@bendyline/docblocks/host';
import { useGitContext } from './GitContext.js';
import { GitStatusBar } from './GitStatusBar.js';
import { GitCommitDialog } from './GitCommitDialog.js';
import { GitBranchesDialog } from './GitBranchesDialog.js';
import { GitHistoryDialog } from './GitHistoryDialog.js';
import { GitDiffDialog } from './GitDiffDialog.js';
import { GitCloneDialog } from './GitCloneDialog.js';
import { GitAuthGuidanceDialog } from './GitAuthGuidanceDialog.js';
import { GitConflictsDialog } from './GitConflictsDialog.js';

export interface GitUIProps {
  /** Open a workspace file in the editor (from conflicts/history dialogs). */
  onOpenFile: (path: string) => void;
  /** A clone finished and its folder is registered — open the workspace. */
  onWorkspaceCloned?: (info: ElectronWorkspaceInfo) => void;
}

export function GitUI({ onOpenFile, onWorkspaceCloned }: GitUIProps) {
  const git = useGitContext();
  if (!git || !git.available) return null;

  const { dialog, closeDialog } = git;

  return (
    <>
      <GitStatusBar />
      {git.repo && (
        <span className="db-git-inline-status" role="status" aria-live="polite">
          {git.lastResult?.message ?? ''}
        </span>
      )}
      {dialog.kind === 'commit' && <GitCommitDialog onClose={closeDialog} />}
      {dialog.kind === 'branches' && (
        <GitBranchesDialog createFocus={dialog.createFocus} onClose={closeDialog} />
      )}
      {dialog.kind === 'history' && <GitHistoryDialog path={dialog.path} onClose={closeDialog} />}
      {dialog.kind === 'diff' && (
        <GitDiffDialog path={dialog.path} revision={dialog.revision} onClose={closeDialog} />
      )}
      {dialog.kind === 'clone' && (
        <GitCloneDialog
          onClose={closeDialog}
          onCloned={(info) => {
            closeDialog();
            onWorkspaceCloned?.(info);
          }}
        />
      )}
      {dialog.kind === 'auth-guidance' && (
        <GitAuthGuidanceDialog
          operation={dialog.operation}
          detail={dialog.detail}
          onClose={closeDialog}
        />
      )}
      {dialog.kind === 'conflicts' && (
        <GitConflictsDialog paths={dialog.paths} onOpenFile={onOpenFile} onClose={closeDialog} />
      )}
    </>
  );
}
