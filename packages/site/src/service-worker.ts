import { cleanupOutdatedCaches, PrecacheController, PrecacheRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { installOfflineAssets } from './precache-install';

interface PrecacheLifecycleEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface ServiceWorkerRuntime {
  __WB_MANIFEST: Array<string | { revision?: string; url: string }>;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(
    type: 'install' | 'activate',
    listener: (event: PrecacheLifecycleEvent) => void,
  ): void;
  importScripts: (...urls: string[]) => void;
  skipWaiting: () => Promise<void>;
  registration: { active: object | null };
  clients: { claim: () => Promise<void> };
}

const serviceWorker = self as unknown as ServiceWorkerRuntime;

// Preserve the durable, one-time recovery from the legacy catch-all worker.
// It runs before Workbox installs its own lifecycle listeners.
serviceWorker.importScripts('pwa-route-migration.js');

const precache = new PrecacheController();
const firstInstallation = serviceWorker.registration.active === null;
precache.addToCacheList((self as unknown as ServiceWorkerRuntime).__WB_MANIFEST);
// Use Workbox's revision keys, integrity checks and cache strategy, but avoid
// waiting for each individual network round trip before starting the next.
serviceWorker.addEventListener('install', (event) => {
  event.waitUntil(
    installOfflineAssets([...precache.getURLsToCacheKeys()], async ([url, cacheKey]) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 90_000);
      const request = new Request(url, {
        signal: controller.signal,
        integrity: precache.getIntegrityForCacheKey(cacheKey),
        cache: cacheKey === url ? 'default' : 'reload',
        credentials: 'same-origin',
      });
      try {
        await Promise.all(precache.strategy.handleAll({ event, request, params: { cacheKey } }));
      } finally {
        clearTimeout(timeout);
      }
    }),
  );
});
serviceWorker.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await precache.activate(event);
      // Also cover a fresh install after unregistering a worker: the durable
      // migration marker may already exist, but the open editor still needs a
      // controller. Updates retain their prompt-based waiting lifecycle.
      if (firstInstallation) await serviceWorker.clients.claim();
    })(),
  );
});
registerRoute(new PrecacheRoute(precache));
cleanupOutdatedCaches();

// Only the root editor is an app-shell route. Static product pages, crawl
// files, and custom 404s must resolve to their own precached responses.
registerRoute(
  new NavigationRoute(precache.createHandlerBoundToURL('index.html'), {
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
