import { DocBlocksShell } from '@bendyline/docblocks-react';
import { getDocBlocksHost } from '@bendyline/docblocks/host';
import { UpdateStatusItem, useUpdaterStatus } from './UpdateStatusBanner';
import { DESKTOP_FFMPEG_WASM_CONFIG } from './ffmpegWasmConfig';
import logoUrl from './docblocks.webp';
import './update-banner.css';
import './titlebar.css';

export function App() {
  const updaterStatus = useUpdaterStatus();

  return (
    <div className="db-desktop-root">
      {/* Electron intentionally denies every popup. Keep the editor's
          impossible synchronized-window presentation target out of the UI. */}
      <DocBlocksShell
        theme="auto"
        logoUrl={logoUrl}
        ffmpegWasm={DESKTOP_FFMPEG_WASM_CONFIG}
        statusBarSlotRight={<UpdateStatusItem status={updaterStatus} />}
        onCopyCode={(code) => getDocBlocksHost().clipboard.writeText(code)}
        allowPresentationWindow={false}
      />
    </div>
  );
}
