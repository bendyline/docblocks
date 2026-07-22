import React from 'react';
import { createRoot } from 'react-dom/client';

import { VscodeEditor } from './VscodeEditor.js';
// Self-hosted theme fonts so Write-canvas font schemes (PT Serif, Hanken
// Grotesk, …) render for real in the webview. Vite bundles the woff2 into
// dist/webview and rewrites the relative url()s; loads under the webview CSP.
import './fonts.css';
import './vscodeEditor.css';

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <VscodeEditor />
  </React.StrictMode>,
);
