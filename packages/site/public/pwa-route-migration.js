/* global Response, caches, self */

/*
 * One-time recovery from the legacy service worker that routed every
 * navigation to the editor shell. The marker lives outside Workbox's cache
 * namespace, so cleanupOutdatedCaches cannot erase it.
 *
 * On the first worker containing this hook, skip the waiting phase and claim
 * existing clients so /docs/, /privacy/, and the product pages immediately
 * use the corrected root-only navigation rule. Activation records completion;
 * every later worker sees the marker and keeps DocBlocks' normal prompt-based
 * update lifecycle.
 */
(function migrateLegacyNavigationWorker() {
  const markerCacheName = 'docblocks-pwa-migrations';
  const markerUrl = '/__docblocks-pwa-migrations__/root-only-navigation-v1';

  async function migrationComplete() {
    try {
      const cache = await caches.open(markerCacheName);
      return Boolean(await cache.match(markerUrl));
    } catch {
      return false;
    }
  }

  self.addEventListener('install', (event) => {
    event.waitUntil(
      migrationComplete().then((complete) => (complete ? undefined : self.skipWaiting())),
    );
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil(
      (async () => {
        if (await migrationComplete()) return;
        const cache = await caches.open(markerCacheName);
        await cache.put(
          markerUrl,
          new Response('complete', {
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          }),
        );
        await self.clients.claim();
      })(),
    );
  });
})();
