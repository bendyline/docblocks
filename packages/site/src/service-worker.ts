import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

interface ServiceWorkerRuntime {
  __WB_MANIFEST: Array<string | { revision?: string; url: string }>;
  addEventListener: (type: 'message', listener: (event: MessageEvent<unknown>) => void) => void;
  importScripts: (...urls: string[]) => void;
  skipWaiting: () => Promise<void>;
}

const serviceWorker = self as unknown as ServiceWorkerRuntime;

// Preserve the durable, one-time recovery from the legacy catch-all worker.
// It runs before Workbox installs its own lifecycle listeners.
serviceWorker.importScripts('pwa-route-migration.js');

precacheAndRoute((self as unknown as ServiceWorkerRuntime).__WB_MANIFEST);
cleanupOutdatedCaches();

// Only the root editor is an app-shell route. Static product pages, crawl
// files, and custom 404s must resolve to their own precached responses.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    allowlist: [/^\/(\?.*)?$/],
  }),
);

function isSkipWaitingMessage(value: unknown): value is { type: 'SKIP_WAITING' } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 && record.type === 'SKIP_WAITING';
}

serviceWorker.addEventListener('message', (event) => {
  if (isSkipWaitingMessage(event.data)) {
    void (self as unknown as ServiceWorkerRuntime).skipWaiting();
  }
});
