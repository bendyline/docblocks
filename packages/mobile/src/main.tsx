import { Capacitor } from '@capacitor/core';
import './base.css';

/**
 * iPhone renders the shell at 1pt per CSS pixel, where it reads small; Android
 * already follows the system display size. With an initial scale and no width,
 * WebKit lays the page out at view width / scale in either orientation, so
 * everything grows and still fits. `width=device-width` would pin the layout
 * at full width and overflow, as `WKWebView.pageZoom` does. iPad keeps its layout.
 */
const IPHONE_SCALE = 1.175;

if (Capacitor.getPlatform() === 'ios' && /\biPhone\b/.test(navigator.userAgent)) {
  document
    .querySelector('meta[name="viewport"]')
    ?.setAttribute('content', `initial-scale=${IPHONE_SCALE}, viewport-fit=cover`);
  // Safe-area insets still arrive in points; base.css divides them back.
  document.documentElement.style.setProperty('--db-viewport-scale', String(IPHONE_SCALE));
  // base.css also fits the top and bottom bars to the iPhone's cutouts and corners.
  document.documentElement.dataset.dbDevice = 'iphone';
}

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
