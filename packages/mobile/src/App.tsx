import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DocBlocksShell } from '@bendyline/docblocks-react';
import { SITE_CALC_ENGINE_FACTORY } from './calculationConfig';
import { SITE_PROOFING_PROVIDER } from './proofingConfig';
import '@bendyline/squisq-react/styles';
import '@bendyline/docblocks-react/styles';

(globalThis as { docBlocksMonacoWorkersReady?: Promise<unknown> }).docBlocksMonacoWorkersReady =
  import('./setupMonacoWorkers');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DocBlocksShell
      theme="auto"
      logoUrl="./_res/siteimages/docblocks.webp"
      appBuildDate={__DOCBLOCKS_BUILD_DATE__}
      calcEngineFactory={SITE_CALC_ENGINE_FACTORY}
      proofing={SITE_PROOFING_PROVIDER}
    />
  </StrictMode>,
);
