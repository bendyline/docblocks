import { registerSW } from 'virtual:pwa-register';
import { PwaStateStore, type PwaState } from './pwa-state';
import { reloadOnServiceWorkerActivation } from './pwa-update';

export type { PwaState } from './pwa-state';

const store = new PwaStateStore();

export function subscribePwa(listener: () => void): () => void {
  return store.subscribe(listener);
}

export function getPwaState(): PwaState {
  return store.getSnapshot();
}

/** Dismiss the install-failure alert. */
export function dismissPwaInstallError(): void {
  store.dismissInstallError();
}

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

let registeredServiceWorker: ServiceWorkerRegistration | undefined;
let resolveServiceWorkerRegistration:
  | ((registration: ServiceWorkerRegistration | undefined) => void)
  | undefined;
const serviceWorkerRegistration = new Promise<ServiceWorkerRegistration | undefined>((resolve) => {
  resolveServiceWorkerRegistration = resolve;
});
let updateReloadStarted = false;

function reloadForUpdate(): void {
  if (updateReloadStarted) return;
  updateReloadStarted = true;
  window.location.reload();
}

// Registration happens at module scope on purpose: the site renders under
// <StrictMode>, whose double-invoked effects would otherwise register twice
// in dev. With devOptions disabled the virtual module is a no-op outside
// production builds, so importing this file is always safe.
const updateSW = registerSW({
  onNeedReload() {
    reloadForUpdate();
  },
  onNeedRefresh() {
    store.markUpdateAvailable();
  },
  onOfflineReady() {
    store.markOfflineReady();
  },
  onRegisteredSW(_swScriptUrl, registration) {
    registeredServiceWorker = registration;
    resolveServiceWorkerRegistration?.(registration);
    resolveServiceWorkerRegistration = undefined;
    if (!registration) return;
    observeInstallFailures(registration);
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
  onRegisterError() {
    resolveServiceWorkerRegistration?.(undefined);
    resolveServiceWorkerRegistration = undefined;
    store.markInstallFailed();
  },
});

/** Activate the waiting service worker and reload onto the new version. */
export function applyPwaUpdate(): void {
  void applyPwaUpdateAfterRegistration();
}

async function applyPwaUpdateAfterRegistration(): Promise<void> {
  const registration = registeredServiceWorker ?? (await serviceWorkerRegistration);
  const waitingWorker = registration?.waiting;

  // The prompt can outlive the waiting state when the worker activates during
  // a hard refresh. In that race there is nothing left to message; reloading is
  // exactly the remaining operation the user requested.
  if (!waitingWorker) {
    reloadForUpdate();
    return;
  }

  reloadOnServiceWorkerActivation(waitingWorker, reloadForUpdate);
  // The dependency's boolean parameter does not affect prompt-mode reloads;
  // our idempotent onNeedReload callback handles controlled pages, while the
  // worker-state listener above handles uncontrolled hard-refresh pages.
  await updateSW(false);
}

const observedWorkers = new WeakSet<ServiceWorker>();

function observeInstallFailures(registration: ServiceWorkerRegistration): void {
  const observe = (worker: ServiceWorker | null): void => {
    if (!worker || observedWorkers.has(worker)) return;
    observedWorkers.add(worker);
    const handleStateChange = (): void => {
      if (worker.state !== 'redundant') return;
      worker.removeEventListener('statechange', handleStateChange);
      // A failed update leaves the current active version intact. Only a
      // first-install failure means this client was promised offline support
      // but received none.
      if (!registration.active) store.markInstallFailed();
    };
    worker.addEventListener('statechange', handleStateChange);
    handleStateChange();
  };

  observe(registration.installing);
  registration.addEventListener('updatefound', () => observe(registration.installing));
}
