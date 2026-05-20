import { useEffect, useState } from 'react';
import type { UpdaterStatus } from '@bendyline/docblocks/host';
import { getDocBlocksHost, isElectronHost } from '@bendyline/docblocks/host';

/**
 * Thin banner across the top of the shell that reflects auto-updater
 * state. It only shows when there is something to tell the user:
 *
 *   • `available` / `downloading` → informational "update incoming" note
 *   • `downloaded` → prominent "Restart to install" CTA
 *   • `error` → dismissable warning
 *
 * Quiet otherwise (`checking` and `not-available` render nothing).
 */
export function UpdateStatusBanner() {
  const [status, setStatus] = useState<UpdaterStatus>({ kind: 'not-available' });
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  useEffect(() => {
    if (!isElectronHost()) return;
    return getDocBlocksHost().updater.onStatus(setStatus);
  }, []);

  if (!isElectronHost()) return null;

  switch (status.kind) {
    case 'available':
      return (
        <div className="db-update-banner db-update-banner--info">
          <span>
            Update available — DocBlocks {status.version} is downloading in the background.
          </span>
          {status.releaseUrl && (
            <button
              type="button"
              className="db-update-banner-link"
              onClick={() =>
                status.releaseUrl && getDocBlocksHost().shell.openExternal(status.releaseUrl)
              }
            >
              What's new
            </button>
          )}
        </div>
      );

    case 'downloading':
      return (
        <div className="db-update-banner db-update-banner--info">
          <span>Downloading update… {Math.round(status.percent)}%</span>
        </div>
      );

    case 'downloaded':
      return (
        <div className="db-update-banner db-update-banner--ready">
          <span>DocBlocks {status.version} is ready to install.</span>
          {status.releaseUrl && (
            <button
              type="button"
              className="db-update-banner-link"
              onClick={() =>
                status.releaseUrl && getDocBlocksHost().shell.openExternal(status.releaseUrl)
              }
            >
              What's new
            </button>
          )}
          <button
            type="button"
            className="db-update-banner-action"
            onClick={() => getDocBlocksHost().updater.quitAndInstall()}
          >
            Restart to install
          </button>
        </div>
      );

    case 'error':
      if (dismissedError === status.message) return null;
      return (
        <div className="db-update-banner db-update-banner--error">
          <span>Update check failed: {status.message}</span>
          <button
            type="button"
            className="db-update-banner-dismiss"
            onClick={() => setDismissedError(status.message)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      );

    default:
      return null;
  }
}
