import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DocBlocksShell } from '@bendyline/docblocks-react';
import { SITE_CALC_ENGINE_FACTORY } from './calculationConfig';
import { SITE_PROOFING_PROVIDER } from './proofingConfig';
// pdf.js parses PDFs only with a worker, and only the bundler can give its URL.
// pdfjs-dist is pinned to the version Squisq's formats package loads.
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import '@bendyline/squisq-react/styles';
import '@bendyline/docblocks-react/styles';

(globalThis as { docBlocksMonacoWorkersReady?: Promise<unknown> }).docBlocksMonacoWorkersReady =
  import('./setupMonacoWorkers');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DocBlocksShell
      theme="auto"
      logoUrl="./_res/siteimages/docblocks.svg"
      logoDarkUrl="./_res/siteimages/docblocks-dark.svg"
      appBuildDate={__DOCBLOCKS_BUILD_DATE__}
      calcEngineFactory={SITE_CALC_ENGINE_FACTORY}
      pdfWorkerSrc={pdfWorkerUrl}
      proofing={SITE_PROOFING_PROVIDER}
      // Native listings re-read every file beneath each folder, so index
      // only once quick-open, search, or the link picker asks for it.
      workspaceIndex="on-demand"
      // Microphone, camera, and screen recording are not qualified on native
      // WebViews, and the app declares no capture permissions for them.
      allowRecording={false}
    />
  </StrictMode>,
);
