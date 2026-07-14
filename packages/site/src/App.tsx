import { useSyncExternalStore } from 'react';
import { DocBlocksShell } from '@bendyline/docblocks-react';
import { applyPwaUpdate, getPwaState, subscribePwa } from './pwa';

export function App() {
  const pwa = useSyncExternalStore(subscribePwa, getPwaState);
  return (
    <DocBlocksShell
      theme="auto"
      logoUrl="/_res/siteimages/docblocks.webp"
      issueReportVersion={`${__DOCBLOCKS_VERSION__} web`}
      updateAvailable={pwa.updateAvailable}
      onApplyUpdate={applyPwaUpdate}
      offlineReady={pwa.offlineReady}
    />
  );
}
