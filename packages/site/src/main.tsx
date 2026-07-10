import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// Wire Monaco's language-service workers before anything mounts.
import './setupMonacoWorkers';

import '@bendyline/squisq-react/styles';
import '@bendyline/docblocks-react/styles';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
