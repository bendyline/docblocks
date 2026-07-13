import { useState } from 'react';

const UPDATE_PROMPT_ID = 'db-update-available-prompt';

export interface UpdateAvailableNoticeProps {
  available: boolean;
  onApplyUpdate?: () => void;
  blocked?: boolean;
  statusBarVisible: boolean;
}

/**
 * Keeps PWA updates unobtrusive until the user asks to review one. The
 * notice is positioned over the editor status bar by DocBlocksShell CSS;
 * the existing Reload/Later prompt remains a fixed shell-level card.
 */
export function UpdateAvailableNotice({
  available,
  onApplyUpdate,
  blocked = false,
  statusBarVisible,
}: UpdateAvailableNoticeProps) {
  const [promptOpen, setPromptOpen] = useState(false);

  if (!available || !onApplyUpdate) return null;

  const promptVisible = promptOpen && !blocked;

  return (
    <>
      <button
        type="button"
        className={`db-update-status-notice${
          statusBarVisible ? '' : ' db-update-status-notice--floating'
        }`}
        onClick={() => setPromptOpen(true)}
        disabled={blocked}
        aria-controls={UPDATE_PROMPT_ID}
        aria-expanded={promptVisible}
        aria-label="A new version of DocBlocks is available. Show update options."
        title="A new version of DocBlocks is available"
      >
        Update available
      </button>
      {promptVisible && (
        <div id={UPDATE_PROMPT_ID} className="db-update-banner" role="alert">
          <span>A new version of DocBlocks is available.</span>
          <div className="db-update-banner-actions">
            <button type="button" onClick={onApplyUpdate}>
              Reload
            </button>
            <button type="button" onClick={() => setPromptOpen(false)}>
              Later
            </button>
          </div>
        </div>
      )}
    </>
  );
}
