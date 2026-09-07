import { useSyncExternalStore } from 'react';
import { DocBlocksShell } from '@bendyline/docblocks-react';
import { applyPwaUpdate, getPwaState, subscribePwa } from './pwa';
import { SITE_FFMPEG_WASM_CONFIG } from './ffmpegWasmConfig';
import { SITE_CALC_ENGINE_FACTORY } from './calculationConfig';
import { SITE_PROOFING_PROVIDER } from './proofingConfig';

export function App() {
  const pwa = useSyncExternalStore(subscribePwa, getPwaState);
  return (
    <>
      <DocBlocksShell
        theme="auto"
        logoUrl="/_res/siteimages/docblocks.webp"
        issueReportVersion={`${__DOCBLOCKS_VERSION__} web`}
        appBuildDate={__DOCBLOCKS_BUILD_DATE__}
        ffmpegWasm={SITE_FFMPEG_WASM_CONFIG}
        calcEngineFactory={SITE_CALC_ENGINE_FACTORY}
        proofing={SITE_PROOFING_PROVIDER}
        homeDocumentPath="/aboutDocBlocks.md"
        homeDocumentTitle="DocBlocks — Local-First Markdown Editor"
        updateAvailable={pwa.updateAvailable}
        onApplyUpdate={applyPwaUpdate}
        offlineReady={pwa.offlineReady}
        statusBarSlotRight={
          pwa.installFailed ? (
            <span
              className="squisq-status-item db-pwa-offline-unavailable"
              role="status"
              aria-live="polite"
              title="Offline mode is currently unavailable. Online editing is unaffected."
            >
              Offline unavailable
            </span>
          ) : undefined
        }
      />
    </>
  );
}
