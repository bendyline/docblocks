import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// Start host worker wiring immediately, but keep the editor package behind
// the same deferred boundary as EditorShell. DocBlocksShell awaits this
// promise before publishing the lazy editor component.
(globalThis as { docBlocksMonacoWorkersReady?: Promise<unknown> }).docBlocksMonacoWorkersReady =
  import('./setupMonacoWorkers');

// Register the service worker (production builds only) and start the
// update-available store consumed by <App>.
import './pwa';

import '@bendyline/squisq-react/styles';
import '@bendyline/docblocks-react/styles';
// Site-owned chrome that renders outside `.db-shell` and so cannot rely on
// the shell's `--db-*` tokens. Loaded last to keep the cascade explicit.
import './pwa-banner.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
