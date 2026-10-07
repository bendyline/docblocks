/**
 * Cross-origin isolation headers shared by the site and Electron renderer dev
 * servers.
 *
 * These once existed to enable `SharedArrayBuffer` for the GPL-licensed
 * ffmpeg.wasm core. That core is no longer distributed by any surface, and no
 * remaining dependency needs `SharedArrayBuffer` — harper, IronCalc, Monaco,
 * and Squisq's WebCodecs encoder all run without it.
 *
 * They are retained deliberately as Spectre-class hardening. The cost is zero:
 * every surface ships a `default-src 'none'` CSP with same-origin subresources
 * only, so `credentialless` has nothing to block. Keeping the production
 * service worker and the dev servers agreed on one policy also keeps
 * `crossOriginIsolated` from differing between `npm run dev` and a real build.
 */
export const CROSS_ORIGIN_ISOLATION_HEADERS = Object.freeze({
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
});
