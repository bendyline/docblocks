/**
 * Keep the screen on while long work runs: generating narration, exporting
 * audio, reading aloud, downloading a model.
 *
 * On a phone, auto-lock does more than darken the screen. The app leaves the
 * foreground and the host stops its speech and downloads, so the work fails
 * partway. This uses the standard Screen Wake Lock API, which Chromium
 * provides on the site and desktop, and which the mobile app provides
 * natively (packages/mobile/src/wake-lock.ts) because its web views lack it.
 *
 * Best effort: where the API is missing or denied, the work runs as before.
 * The platform drops a wake lock whenever the page is hidden, so the lock is
 * requested again each time the page becomes visible.
 */

import { useEffect } from 'react';

/** Hold a screen wake lock until the returned function is called. */
export function holdScreenWakeLock(doc: Document | undefined = globalThis.document): () => void {
  const wakeLock =
    typeof navigator === 'undefined'
      ? undefined
      : (navigator as Partial<Pick<Navigator, 'wakeLock'>>).wakeLock;
  if (!doc || !wakeLock) return () => {};
  let released = false;
  let requesting = false;
  let sentinel: WakeLockSentinel | null = null;

  const request = (): void => {
    if (released || requesting || sentinel || doc.visibilityState !== 'visible') return;
    requesting = true;
    wakeLock.request('screen').then(
      (lock) => {
        requesting = false;
        if (released) {
          void lock.release().catch(() => {});
          return;
        }
        sentinel = lock;
        lock.addEventListener('release', () => {
          if (sentinel === lock) sentinel = null;
        });
      },
      () => {
        // Denied or unsupported here; the work does not depend on it.
        requesting = false;
      },
    );
  };
  doc.addEventListener('visibilitychange', request);
  request();

  return () => {
    if (released) return;
    released = true;
    doc.removeEventListener('visibilitychange', request);
    const lock = sentinel;
    sentinel = null;
    if (lock) void lock.release().catch(() => {});
  };
}

/** Keep the screen on while `active` is true. */
export function useScreenWakeLock(active: boolean): void {
  useEffect(() => (active ? holdScreenWakeLock() : undefined), [active]);
}
