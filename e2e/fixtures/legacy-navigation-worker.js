/* global fetch, self */

/* Test fixture for the production worker that incorrectly treated every
   navigation as a DocBlocks editor route. */
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch('/index.html'));
  }
});
