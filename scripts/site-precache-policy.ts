// The pinned ffmpeg.wasm core is ~31 MiB and must remain available offline.
export const SITE_PRECACHE_MAX_BYTES = 32 * 1024 * 1024;
/**
 * Fail before one deploy grows into an unreasonable first-install cache.
 *
 * Raised from 64 MiB when proofing shipped: harper's engine is a ~15 MiB
 * binary plus a ~15 MiB slim sibling, and grammar and spellcheck have to keep
 * working on a plane like every other feature. The two files are the entire
 * increase — the ceiling is not headroom for the next thing that wants in.
 */
export const SITE_PRECACHE_MAX_TOTAL_BYTES = 96 * 1024 * 1024;

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
