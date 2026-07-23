export interface ServiceWorkerActivationSource {
  readonly state: ServiceWorkerState;
  addEventListener(type: 'statechange', listener: EventListener): void;
  removeEventListener(type: 'statechange', listener: EventListener): void;
}

/**
 * Reload once a waiting service worker finishes activating.
 *
 * vite-plugin-pwa normally reloads from Workbox's `controlling` event. A
 * hard-refreshed page is deliberately uncontrolled, though, so Workbox
 * classifies the same transition as an initial install and does not reload.
 * Watching the worker itself keeps the user-requested update reliable in
 * both controlled and uncontrolled clients.
 */
export function reloadOnServiceWorkerActivation(
  worker: ServiceWorkerActivationSource,
  reload: () => void,
): () => void {
  let listening = true;

  const stopListening = (): void => {
    if (!listening) return;
    listening = false;
    worker.removeEventListener('statechange', handleStateChange);
  };

  const handleStateChange: EventListener = () => {
    if (!listening || worker.state !== 'activated') return;
    stopListening();
    reload();
  };

  worker.addEventListener('statechange', handleStateChange);
  handleStateChange(new Event('statechange'));
  return stopListening;
}
