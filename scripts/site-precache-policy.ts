// The pinned ffmpeg.wasm core is ~31 MiB and must remain available offline.
export const SITE_PRECACHE_MAX_BYTES = 32 * 1024 * 1024;
/**
 * Fail before one deploy grows into an unreasonable first-install cache.
 *
 * Raised from 64 MiB when proofing shipped, then by 2 MiB for IronCalc's
 * formula engine. These optional features still have to work on a plane like
 * every other feature; the ceiling tracks their reviewed asset cost rather
 * than acting as general headroom.
 */
export const SITE_PRECACHE_MAX_TOTAL_BYTES = 98 * 1024 * 1024;

export const SITE_PRECACHE_EXTENSIONS = Object.freeze([
  'html',
  'json',
  'js',
  'css',
  'png',
  'webp',
  'ttf',
  'woff2',
  'webmanifest',
  'txt',
  'xml',
  'wasm',
]);

export const SITE_PRECACHE_GLOB = `**/*.{${SITE_PRECACHE_EXTENSIONS.join(',')}}`;
