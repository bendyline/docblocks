/**
 * GitAuthGuidanceDialog — shown when a git operation fails to authenticate.
 *
 * DocBlocks deliberately never collects or stores credentials, so this
 * dialog only explains the three supported sign-in routes (credential
 * helper, GitHub CLI, SSH key). The copy is exported as a standalone
 * component so the clone dialog can embed it after an auth failure.
 */

import { maybeGetDocBlocksHost } from '@bendyline/docblocks/host';
import { Dialog } from '../components/Dialog.js';

const LEARN_MORE_URL =
  'https://docs.github.com/en/get-started/getting-started-with-git/caching-your-github-credentials-in-git';

const OPERATION_LABELS: Record<'push' | 'pull' | 'fetch' | 'clone' | 'pr', string> = {
  push: 'push',
  pull: 'pull',
  fetch: 'fetch',
  clone: 'clone',
  pr: 'create the pull request',
};

/** The credential guidance copy, reusable outside this dialog (clone flow). */
export function GitCredentialGuidance({ detail }: { detail?: string }) {
  return (
    <>
      <p className="db-settings-hint">
        DocBlocks never stores Git credentials. Sign in with one of these, then try again:
      </p>
      <ul className="db-git-hint">
        <li>
          A git credential helper (<code>git config credential.helper</code>)
        </li>
        <li>
          The GitHub CLI (<code>gh auth login</code>)
        </li>
        <li>An SSH key registered with your remote</li>
      </ul>
      {detail && (
        <details>
          <summary>Details</summary>
          <p className="db-git-hint">{detail}</p>
        </details>
      )}
    </>
  );
}

export function GitAuthGuidanceDialog({
  operation,
  detail,
  onClose,
}: {
  operation: 'push' | 'pull' | 'fetch' | 'clone' | 'pr';
  detail?: string;
  onClose: () => void;
}) {
  return (
    <Dialog
      title="Git needs credentials"
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="db-git-secondary-btn"
            onClick={() => void maybeGetDocBlocksHost()?.shell.openExternal(LEARN_MORE_URL)}
          >
            Learn more
          </button>
          <button type="button" className="db-git-primary-btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <p className="db-settings-hint">
        Git could not authenticate with the remote while trying to {OPERATION_LABELS[operation]}.
      </p>
      <GitCredentialGuidance detail={detail} />
    </Dialog>
  );
}
