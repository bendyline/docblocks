// The pinned ffmpeg.wasm core is ~31 MiB and must remain available offline.
export const SITE_PRECACHE_MAX_BYTES = 32 * 1024 * 1024;
/** Fail before one deploy grows into an unreasonable first-install cache. */
export const SITE_PRECACHE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

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
