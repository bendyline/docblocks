// The two harper proofing binaries are the largest precached assets at ~15.1
// and ~14.9 MiB; Monaco's ts.worker is a distant third at ~5.7 MiB. Ratcheted
// down from 32 MiB when the GPL-licensed ffmpeg.wasm core (~30.9 MiB) stopped
// being distributed.
export const SITE_PRECACHE_MAX_BYTES = 18 * 1024 * 1024;
/**
 * Fail before one deploy grows into an unreasonable first-install cache.
 *
 * Raised from 64 MiB when proofing shipped, then by 2 MiB for IronCalc's
 * formula engine, then lowered from 98 MiB when ffmpeg.wasm was removed from
 * every surface — the eligible total measured 91.0 MiB before and 60.1 MiB
 * after. These optional features still have to work on a plane like every
 * other feature; the ceiling tracks their reviewed asset cost rather than
 * acting as general headroom.
 */
export const SITE_PRECACHE_MAX_TOTAL_BYTES = 66 * 1024 * 1024;

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
