import { registerSW } from 'virtual:pwa-register';

export interface PwaState {
  /** A new deploy is waiting; applying it reloads onto the new version. */
  updateAvailable: boolean;
  /** First-time precache finished; the full app now works offline. */
  offlineReady: boolean;
}

let state: PwaState = { updateAvailable: false, offlineReady: false };
const listeners = new Set<() => void>();

function setState(patch: Partial<PwaState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function subscribePwa(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPwaState(): PwaState {
  return state;
}

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

// Registration happens at module scope on purpose: the site renders under
// <StrictMode>, whose double-invoked effects would otherwise register twice
// in dev. With devOptions disabled the virtual module is a no-op outside
// production builds, so importing this file is always safe.
const updateSW = registerSW({
  onNeedRefresh() {
    setState({ updateAvailable: true });
  },
  onOfflineReady() {
    setState({ offlineReady: true });
  },
  onRegisteredSW(_swScriptUrl, registration) {
    if (!registration) return;
    // A local-first editor can sit open for days; without a periodic check
    // the update prompt would only ever appear on a fresh page load. The
    // browser bypasses the HTTP cache for SW update checks, so this stays
    // correct even behind GitHub Pages' caching.
    setInterval(() => {
      registration.update().catch(() => {
        // Offline or transient network failure — try again next interval.
      });
    }, UPDATE_CHECK_INTERVAL_MS);
  },
});

/** Activate the waiting service worker and reload onto the new version. */
export function applyPwaUpdate(): void {
  void updateSW(true);
}
