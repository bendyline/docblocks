export const SITE_PRECACHE_MAX_BYTES = 10 * 1024 * 1024;
/** Fail before one deploy grows into an unreasonable first-install cache. */
export const SITE_PRECACHE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export const SITE_PRECACHE_EXTENSIONS = Object.freeze([
  'html',
  'js',
  'css',
  'png',
  'webp',
  'ttf',
  'woff2',
  'webmanifest',
  'txt',
  'xml',
]);

export const SITE_PRECACHE_GLOB = `**/*.{${SITE_PRECACHE_EXTENSIONS.join(',')}}`;
