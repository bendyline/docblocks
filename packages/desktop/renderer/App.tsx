import { DocBlocksShell } from '@bendyline/docblocks-react';
import { UpdateStatusItem, useUpdaterStatus } from './UpdateStatusBanner';
import { DESKTOP_FFMPEG_WASM_CONFIG } from './ffmpegWasmConfig';
import logoUrl from './docblocks.webp';
import './update-banner.css';
import './titlebar.css';

export function App() {
  const updaterStatus = useUpdaterStatus();

  return (
    <div className="db-desktop-root">
      <DocBlocksShell
        theme="auto"
        logoUrl={logoUrl}
        ffmpegWasm={DESKTOP_FFMPEG_WASM_CONFIG}
        statusBarSlotRight={<UpdateStatusItem status={updaterStatus} />}
      />
    </div>
  );
}
