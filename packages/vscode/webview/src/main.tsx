import React from 'react';
import { createRoot } from 'react-dom/client';

// Wire Monaco's language-service workers before anything mounts.
import './setupMonacoWorkers.js';

import { VscodeEditor } from './VscodeEditor.js';

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <VscodeEditor />
  </React.StrictMode>,
);
