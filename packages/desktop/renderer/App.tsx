import { DocBlocksShell } from '@bendyline/docblocks-react';
import { UpdateStatusBanner } from './UpdateStatusBanner';
import logoUrl from './docblocks.webp';
import './update-banner.css';
import './titlebar.css';

export function App() {
  return (
    <div className="db-desktop-root">
      <UpdateStatusBanner />
      <DocBlocksShell theme="auto" logoUrl={logoUrl} />
    </div>
  );
}
