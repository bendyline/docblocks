import { DocBlocksShell } from '@bendyline/docblocks-react';
import { UpdateStatusBanner } from './UpdateStatusBanner';
import './update-banner.css';

export function App() {
  return (
    <div className="db-desktop-root">
      <UpdateStatusBanner />
      <DocBlocksShell theme="auto" />
    </div>
  );
}
