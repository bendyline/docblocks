export const DESKTOP_DEVELOPMENT_SERVER_URL = 'http://localhost:5221';

/**
 * Renderer CSP for both the packaged app:// origin and the trusted Vite
 * development origin. Recorded and attached audio/video is exposed to the
 * renderer through object URLs. Playback needs `blob:` in `media-src`, while
 * video export reads those same URLs back into bounded byte arrays and
 * therefore needs `blob:` in `connect-src`.
 *
 * `script-src` must carry `'wasm-unsafe-eval'`: Chromium gates
 * WebAssembly.compile/instantiate on `script-src`, so a bare `'self' app:`
 * policy makes every WebAssembly call throw a CompileError. Squisq's GIF and
 * video encoders run ffmpeg.wasm (which is why `main.ts` sends the COOP/COEP
 * headers that turn on SharedArrayBuffer), and their workers inherit this same
 * policy — omitting the token silently disables encoding in packaged builds
 * while leaving it working in development, where `'unsafe-eval'` happens to
 * permit WebAssembly as a side effect. Prefer `'wasm-unsafe-eval'` over
 * `'unsafe-eval'` here: it unblocks WebAssembly without re-enabling JavaScript
 * `eval` in the production renderer.
 */
export function desktopContentSecurityPolicy(isDevelopment: boolean): string {
  if (isDevelopment) {
    return (
      "default-src 'self' app: http://localhost:5221 ws://localhost:5221; " +
      "script-src 'self' app: http://localhost:5221 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; " +
      "style-src 'self' app: http://localhost:5221 'unsafe-inline'; " +
      "img-src 'self' app: http://localhost:5221 data: blob:; " +
      "media-src 'self' app: http://localhost:5221 blob: data:; " +
      "font-src 'self' app: http://localhost:5221 data:; " +
      "connect-src 'self' app: http://localhost:5221 ws://localhost:5221 blob:; " +
      "worker-src 'self' app: http://localhost:5221 blob:; " +
      "object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none';"
    );
  }

  return (
    "default-src 'self' app:; " +
    "script-src 'self' app: 'wasm-unsafe-eval'; " +
    "style-src 'self' app: 'unsafe-inline'; " +
    "img-src 'self' app: data: blob:; " +
    "media-src 'self' app: blob: data:; " +
    "font-src 'self' app: data:; " +
    "connect-src 'self' app: blob:; " +
    "worker-src 'self' app: blob:; " +
    "object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none';"
  );
}
