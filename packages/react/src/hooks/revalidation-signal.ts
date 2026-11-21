import { subscribeFileSystemChangeHints } from '@bendyline/docblocks/filesystem';
import { maybeGetDocBlocksHost } from '@bendyline/docblocks/host';

/**
 * A moment when durable state may have changed while this surface was not
 * looking: the window or tab came back, the app resumed, the network
 * returned, or the user touched the app after a quiet spell.
 *
 * This is the safety net under every provider, watching or not. A watcher can
 * miss changes (a sync client still downloading, a suspended tab, a native
 * observer that stopped), and several providers cannot watch at all.
 *
 * `storage` is different in kind: something reported that storage did change
 * (another tab wrote, a phone's native layer saw a file arrive). It says
 * nothing about which file, so it is handled the same way, only cheaper: it
 * can arrive often, including for this app's own saves.
 */
export type RevalidationReason = 'focus' | 'visible' | 'resume' | 'online' | 'input' | 'storage';

export interface RevalidationSignalOptions {
  /** Minimum spacing between two signals. Returning to an app fires several events at once. */
  minIntervalMs?: number;
  /** Quiet time after which the next key or pointer press counts as coming back. */
  idleMs?: number;
  now?: () => number;
}

export const REVALIDATION_MIN_INTERVAL_MS = 2_000;
export const REVALIDATION_IDLE_MS = 10_000;

/** Subscribe to revalidation moments. Returns an idempotent unsubscribe. */
export function subscribeRevalidationSignal(
  listener: (reason: RevalidationReason) => void,
  options: RevalidationSignalOptions = {},
): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  const minIntervalMs = options.minIntervalMs ?? REVALIDATION_MIN_INTERVAL_MS;
  const idleMs = options.idleMs ?? REVALIDATION_IDLE_MS;
  const now = options.now ?? Date.now;
  let lastSignalAt = Number.NEGATIVE_INFINITY;
  let lastInputAt = now();
  let stopped = false;
  let deferred: ReturnType<typeof setTimeout> | null = null;

  const signal = (reason: RevalidationReason) => {
    if (stopped) return;
    const at = now();
    if (at - lastSignalAt < minIntervalMs) return;
    lastSignalAt = at;
    if (deferred) {
      clearTimeout(deferred);
      deferred = null;
    }
    listener(reason);
  };
  // A reported change must not be dropped for arriving just after another
  // signal: the look that signal caused may have happened before the change.
  // It waits out the spacing instead, and a burst of reports becomes one look.
  const onStorage = () => {
    // A hidden tab looks again when it is shown, which covers what it missed.
    if (stopped || deferred || document.visibilityState !== 'visible') return;
    const wait = lastSignalAt + minIntervalMs - now();
    if (wait <= 0) {
      signal('storage');
      return;
    }
    deferred = setTimeout(() => {
      deferred = null;
      signal('storage');
    }, wait);
  };
  const onFocus = () => signal('focus');
  const onVisible = () => {
    if (document.visibilityState === 'visible') signal('visible');
  };
  const onOnline = () => signal('online');
  const onInput = () => {
    const at = now();
    const quiet = at - lastInputAt >= idleMs;
    lastInputAt = at;
    if (quiet) signal('input');
  };
  const inputOptions = { capture: true, passive: true } as const;

  window.addEventListener('focus', onFocus);
  window.addEventListener('pageshow', onVisible);
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pointerdown', onInput, inputOptions);
  window.addEventListener('keydown', onInput, inputOptions);
  const stopResume = maybeGetDocBlocksHost()?.lifecycle?.onResume?.(() => signal('resume'));
  const stopHints = subscribeFileSystemChangeHints(onStorage);

  return () => {
    if (stopped) return;
    stopped = true;
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('pageshow', onVisible);
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('pointerdown', onInput, inputOptions);
    window.removeEventListener('keydown', onInput, inputOptions);
    stopResume?.();
    stopHints();
    if (deferred) clearTimeout(deferred);
  };
}
