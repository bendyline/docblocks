import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// Start host worker wiring immediately, but keep the editor package behind
// the same deferred boundary as EditorShell. DocBlocksShell awaits this
// promise before publishing the lazy editor component.
(globalThis as { docBlocksMonacoWorkersReady?: Promise<unknown> }).docBlocksMonacoWorkersReady =
  import('./setupMonacoWorkers');

import '@bendyline/squisq-react/styles';
import '@bendyline/docblocks-react/styles';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
