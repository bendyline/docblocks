import {
  addPlugins,
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

function withCrossOriginIsolationHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// GitHub Pages cannot emit COOP/COEP itself. Once this PWA controls a page,
// every cached response carries them. These originally enabled
// SharedArrayBuffer for ffmpeg.wasm; that core is no longer distributed and
// nothing shipped needs SharedArrayBuffer, but the headers are retained as
// Spectre-class hardening. The site loads only same-origin subresources under
// a `default-src 'none'` CSP, so `credentialless` has nothing to block.
addPlugins([
  {
    handlerWillRespond: async ({ response }) => withCrossOriginIsolationHeaders(response),
  },
]);

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
