import { DocBlocksShell } from '@bendyline/docblocks-react';
import { getDocBlocksHost } from '@bendyline/docblocks/host';
import { UpdateStatusItem, useUpdaterStatus } from './UpdateStatusBanner';
import { DESKTOP_CALC_ENGINE_FACTORY } from './calculationConfig';
import { DESKTOP_PROOFING_PROVIDER } from './proofingConfig';
// pdf.js parses PDFs only with a worker, and only the bundler can give its URL.
// pdfjs-dist is pinned to the version Squisq's formats package loads.
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import logoUrl from './docblocks.svg';
import logoDarkUrl from './docblocks-dark.svg';
import './update-banner.css';
import './titlebar.css';

export function App() {
  const updaterStatus = useUpdaterStatus();

  return (
    <div className="db-desktop-root">
      {/* Electron intentionally denies every popup. Keep the editor's
          impossible synchronized-window presentation target out of the UI. */}
      <DocBlocksShell
        theme="auto"
        logoUrl={logoUrl}
        logoDarkUrl={logoDarkUrl}
        calcEngineFactory={DESKTOP_CALC_ENGINE_FACTORY}
        pdfWorkerSrc={pdfWorkerUrl}
        proofing={DESKTOP_PROOFING_PROVIDER}
        statusBarSlotRight={<UpdateStatusItem status={updaterStatus} />}
        onCopyCode={(code) => getDocBlocksHost().clipboard?.writeText(code)}
        allowPresentationWindow={false}
      />
    </div>
  );
}
