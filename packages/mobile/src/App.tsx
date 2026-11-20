import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DocBlocksShell } from '@bendyline/docblocks-react';
import { SITE_CALC_ENGINE_FACTORY } from './calculationConfig';
import { SITE_PROOFING_PROVIDER } from './proofingConfig';
import { dismissSplash } from './splash';
import { firstRunGreeting } from './storage-welcome';
import { MOBILE_WORKSPACE_INDEX_WORKER } from './workspaceIndexConfig';
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
      // Analysis and storage run in a worker whose store survives relaunches.
      workspaceIndexWorker={MOBILE_WORKSPACE_INDEX_WORKER}
      // Recording, document narration and dictation use the microphone and
      // camera under the app's declared permissions, and capture only while
      // the person records. Both WebViews lack a screen picker, so Squisq's
      // recorder offers no Screen source here. Recordings stay in the
      // document's folder; dictation transcribes on the device.
      allowRecording
      // Present fills the app canvas and nothing else. Neither WebView opens
      // the synchronized audience window (window.open returns null), and the
      // app already owns the whole screen, so Full screen only does harm:
      // Android cancels element fullscreen as it starts, and iOS shows WebKit's
      // "capacitor://localhost… is in full screen" banner, then leaves the
      // shell inset by stale safe areas after it exits. It is the only
      // fullscreen request in the app. With one destination left, the split
      // button's menu disappears.
      allowPresentationWindow={false}
      allowPresentationFullscreen={false}
      // Narrate's Pop out has no float to offer either: neither WebView opens
      // popups, and the prompter stops drawing once the app is backgrounded,
      // so a picture-in-picture video goes blank.
      allowNarratePopOut={false}
      // index.html's launch splash covers the shell until it has restored the
      // last document, so its interim states never flash past.
      onStartupSettled={dismissSplash}
      // Android's welcome screen has just greeted a user who picked a folder.
      firstRunGreeting={firstRunGreeting()}
    />
  </StrictMode>,
);
