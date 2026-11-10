import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DocBlocksShell } from '@bendyline/docblocks-react';
import { SITE_CALC_ENGINE_FACTORY } from './calculationConfig';
import { SITE_PROOFING_PROVIDER } from './proofingConfig';
import { dismissSplash } from './splash';
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
      // Camera and screen recording are not qualified on native WebViews.
      // Dictation is: it records only between taps of the microphone button,
      // under the app's declared microphone permission, and transcribes on
      // the device.
      allowRecording={false}
      allowDictation
      // index.html's launch splash covers the shell until it has restored the
      // last document, so its interim states never flash past.
      onStartupSettled={dismissSplash}
    />
  </StrictMode>,
);
