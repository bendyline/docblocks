/**
 * GitConflictsDialog — lists conflicted files after a pull hits a merge
 * conflict. Each row opens the file in the editor so the user can resolve
 * the markers; the primary action hands off to the commit dialog, which
 * concludes the merge.
 */

import { Dialog } from '../components/Dialog.js';
import { useGitContext } from './GitContext.js';

export function GitConflictsDialog({
  paths,
  onOpenFile,
  onClose,
}: {
  paths: string[];
  onOpenFile: (path: string) => void;
  onClose: () => void;
}) {
  const git = useGitContext();

  return (
    <Dialog
      title="Merge conflicts"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="db-git-secondary-btn" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="db-git-primary-btn"
            onClick={() => git?.openDialog({ kind: 'commit' })}
          >
            Open commit dialog
          </button>
        </>
      }
    >
      <p className="db-settings-hint">
        These files contain conflict markers. Edit each one to resolve the conflicts, then commit to
        complete the merge.
      </p>
      <ul className="db-git-file-list">
        {paths.map((path) => (
          <li key={path} className="db-git-file-row">
            <button
              type="button"
              onClick={() => {
                onOpenFile(path);
                onClose();
              }}
            >
              {path.replace(/^\/+/, '')}
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
