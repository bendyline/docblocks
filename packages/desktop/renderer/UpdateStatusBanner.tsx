import { useEffect, useState } from 'react';
import type { UpdaterStatus } from '@bendyline/docblocks/host';
import { getDocBlocksHost, isElectronHost } from '@bendyline/docblocks/host';

/** Subscribe once at the desktop root so progress survives editor remounts. */
export function useUpdaterStatus(): UpdaterStatus {
  const [status, setStatus] = useState<UpdaterStatus>({ kind: 'not-available' });

  useEffect(() => {
    if (!isElectronHost()) return;
    return getDocBlocksHost().updater.onStatus(setStatus);
  }, []);

  return status;
}

export interface UpdateStatusItemProps {
  status: UpdaterStatus;
}

/** Compact updater state and actions for the editor's bottom status bar. */
export function UpdateStatusItem({ status }: UpdateStatusItemProps) {
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  const restartToInstall = async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      const result = await getDocBlocksHost().updater.quitAndInstall();
      if (result === 'installing') return;
      setInstalling(false);
      setInstallError(
        result === 'cancelled'
          ? 'Restart cancelled because the document was not ready to close.'
          : 'The update is no longer ready to install.',
      );
    } catch (error) {
      setInstalling(false);
      setInstallError(error instanceof Error ? error.message : 'Could not start the update.');
    }
  };

  switch (status.kind) {
    case 'available':
      return (
        <span
          className="squisq-status-item db-desktop-update-status"
          role="progressbar"
          aria-label={`Downloading DocBlocks ${status.version}`}
        >
          Downloading update&hellip;
        </span>
      );

    case 'downloading': {
      const percent = Math.round(status.percent);
      return (
        <span
          className="squisq-status-item db-desktop-update-status"
          role="progressbar"
          aria-label="Downloading DocBlocks update"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          Downloading update&hellip; {percent}%
        </span>
      );
    }

    case 'downloaded':
      return (
        <span
          className="squisq-status-item db-desktop-update-status db-desktop-update-status--ready"
          role="status"
          aria-live="polite"
        >
          <span>
            {installError ??
              (installing
                ? 'Saving documents before restart…'
                : `DocBlocks ${status.version} is ready to install.`)}
          </span>
          {status.releaseUrl && (
            <button
              type="button"
              className="db-desktop-update-link"
              onClick={() =>
                status.releaseUrl && getDocBlocksHost().shell.openExternal(status.releaseUrl)
              }
            >
              What's new
            </button>
          )}
          <button
            type="button"
            className="db-desktop-update-action"
            onClick={() => void restartToInstall()}
            disabled={installing}
          >
            {installing ? 'Preparing restart…' : 'Restart to install'}
          </button>
        </span>
      );

    case 'error':
      if (dismissedError === status.message) return null;
      return (
        <span
          className="squisq-status-item db-desktop-update-status db-desktop-update-status--error"
          role="alert"
          aria-live="assertive"
        >
          <span>{status.message}</span>
          <button
            type="button"
            className="db-desktop-update-dismiss"
            onClick={() => setDismissedError(status.message)}
            aria-label="Dismiss update error"
          >
            ×
          </button>
        </span>
      );

    default:
      return null;
  }
}
