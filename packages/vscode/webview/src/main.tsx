import React from 'react';
import { createRoot } from 'react-dom/client';
import { VscodeEditor } from './VscodeEditor.js';

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <VscodeEditor />
  </React.StrictMode>,
);
