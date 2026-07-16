import { useSyncExternalStore } from 'react';
import { DocBlocksShell } from '@bendyline/docblocks-react';
import { applyPwaUpdate, dismissPwaInstallError, getPwaState, subscribePwa } from './pwa';

export function App() {
  const pwa = useSyncExternalStore(subscribePwa, getPwaState);
  return (
    <>
      <DocBlocksShell
        theme="auto"
        logoUrl="/_res/siteimages/docblocks.webp"
        issueReportVersion={`${__DOCBLOCKS_VERSION__} web`}
        homeDocumentPath="/aboutDocBlocks.md"
        homeDocumentTitle="DocBlocks — Local-First Markdown Editor"
        updateAvailable={pwa.updateAvailable}
        onApplyUpdate={applyPwaUpdate}
        offlineReady={pwa.offlineReady}
      />
      {/* Rendered outside the shell, so it is styled entirely by
          src/pwa-banner.css — the shell's `--db-*` tokens do not reach here.
          See that file's header. */}
      {pwa.installError && (
        <div className="db-pwa-install-error" role="alert">
          <span>{pwa.installError}</span>
          <button
            type="button"
            className="db-pwa-install-error-dismiss"
            onClick={dismissPwaInstallError}
          >
            Dismiss
          </button>
        </div>
      )}
    </>
  );
}
