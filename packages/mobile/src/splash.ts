/**
 * Retires the launch splash.
 *
 * index.html's splash covers the shell from the first frame until startup
 * settles, so the white page, the empty workspace and the half-loaded sidebar
 * that used to flash past on launch never show. It fades rather than cuts,
 * unless the user asked for reduced motion.
 *
 * On Android the native splash (LaunchSplash.java) normally still covers all of
 * it: the page's splash is then taken away underneath, unseen, before the
 * native one lets go, so the first frame drawn is the app itself. Once the
 * native splash has gone early — for the first-run storage question — the
 * page's splash is the one in view and fades as it does on iOS.
 *
 * Calling it again, or with no splash, does nothing more.
 */

import { Capacitor } from '@capacitor/core';
import { native } from './native';

export const SPLASH_ID = 'db-splash';
const LEAVING = 'db-splash--leaving';
/** Longer than the CSS fade, for a hidden page where `transitionend` never fires. */
const FADE_FALLBACK_MS = 400;

export function dismissSplash(): void {
  const splash = document.getElementById(SPLASH_ID);
  if (Capacitor.getPlatform() === 'android') {
    void handOffToNative(splash);
    return;
  }
  fadeOut(splash);
}

async function handOffToNative(splash: HTMLElement | null): Promise<void> {
  let nativeInView = false;
  try {
    nativeInView = (await native.splashHeld()).held === true;
  } catch {
    // Unknown: treat the page's splash as the visible one.
  }
  if (nativeInView) splash?.remove();
  else fadeOut(splash);
  await native.releaseSplash().catch(() => undefined);
}

function fadeOut(splash: HTMLElement | null): void {
  if (!splash || splash.classList.contains(LEAVING)) return;
  const remove = () => splash.remove();
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    remove();
    return;
  }
  splash.classList.add(LEAVING);
  splash.addEventListener('transitionend', remove, { once: true });
  window.setTimeout(remove, FADE_FALLBACK_MS);
}
