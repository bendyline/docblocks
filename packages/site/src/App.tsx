import { useSyncExternalStore } from 'react';
import { DocBlocksShell } from '@bendyline/docblocks-react';
import { applyPwaUpdate, getPwaState, subscribePwa } from './pwa';
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
            <span
              className="squisq-status-item db-pwa-offline-unavailable"
              role="status"
              aria-live="polite"
              title="Offline mode is currently unavailable. Online editing is unaffected."
            >
              Offline unavailable
            </span>
          ) : undefined
        }
      />
    </>
  );
}
