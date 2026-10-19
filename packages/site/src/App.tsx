import { useSyncExternalStore } from 'react';
import { DocBlocksShell } from '@bendyline/docblocks-react';
import { applyPwaUpdate, getPwaState, retryOfflineSetup, subscribePwa } from './pwa';
import { SITE_CALC_ENGINE_FACTORY } from './calculationConfig';
import { SITE_PROOFING_PROVIDER } from './proofingConfig';
// pdf.js parses PDFs only with a worker, and only the bundler can give its URL.
// pdfjs-dist is pinned to the version Squisq's formats package loads.
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

export function App() {
  const pwa = useSyncExternalStore(subscribePwa, getPwaState);
  return (
    <>
      <DocBlocksShell
        theme="auto"
        logoUrl="/_res/siteimages/docblocks.svg"
        logoDarkUrl="/_res/siteimages/docblocks-dark.svg"
        issueReportVersion={`${__DOCBLOCKS_VERSION__} web`}
        appBuildDate={__DOCBLOCKS_BUILD_DATE__}
        calcEngineFactory={SITE_CALC_ENGINE_FACTORY}
        pdfWorkerSrc={pdfWorkerUrl}
        proofing={SITE_PROOFING_PROVIDER}
        homeDocumentPath="/Welcome.md"
        homeDocumentTitle="DocBlocks — Local-First Markdown Editor"
        updateAvailable={pwa.updateAvailable}
        onApplyUpdate={applyPwaUpdate}
        offlineReady={pwa.offlineReady}
        statusBarSlotRight={
          pwa.installFailed ? (
            <button
              type="button"
              className="squisq-status-item db-pwa-offline-unavailable"
              onClick={() => void retryOfflineSetup()}
              aria-label="Offline unavailable. Retry offline setup"
              title="Offline mode is unavailable. Click to retry; online editing is unaffected."
            >
              Offline unavailable
            </button>
          ) : import.meta.env.PROD && !pwa.offlineReady ? (
            <span
              className="squisq-status-item"
              role="status"
              title="Downloading the full app so every feature works offline. Editing is available now."
            >
              Preparing offline…
            </span>
          ) : undefined
        }
      />
    </>
  );
}
