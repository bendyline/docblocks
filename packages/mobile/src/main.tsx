import { Capacitor } from '@capacitor/core';
import './base.css';

async function start() {
  if (Capacitor.isNativePlatform()) {
    const { installMobileHost } = await import('./host');
    await installMobileHost();
  }
  // Browser preview intentionally has no native bridge and uses IndexedDB.
  await import('./App');
}

void start().catch((error: unknown) => {
  const root = document.getElementById('root')!;
  root.setAttribute('role', 'alert');
  root.textContent = `DocBlocks could not open its storage. ${error instanceof Error ? error.message : 'Please try again.'}`;
  const retry = document.createElement('button');
  retry.textContent = 'Try again';
  retry.onclick = () => location.reload();
  root.append(retry);
});
