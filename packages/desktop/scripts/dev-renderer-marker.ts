import type { Plugin } from 'vite';

/** The port the desktop renderer's Vite dev server binds, with `strictPort`. */
export const DESKTOP_DEV_SERVER_PORT = 5221;

/**
 * A path that only the desktop renderer's dev server answers.
 *
 * `dev:electron` waits for this path, not just for something listening on the
 * port. The site's dev server moves to the next free port when 5220 is busy, so
 * a leftover `npm run site` can hold 5221. The desktop server then fails to
 * bind, but a bare `wait-on http://localhost:5221` was satisfied by the site,
 * and Electron loaded the site's renderer. That renderer has no
 * `.db-desktop-root` and no titlebar.css, so the window had no inset for the
 * macOS traffic lights and no drag grip. A site server answers this path with
 * 404, and wait-on accepts only a 2xx response.
 */
export const DESKTOP_RENDERER_MARKER_PATH = '/__docblocks/desktop-renderer.json';

export const DESKTOP_RENDERER_MARKER_URL = `http://localhost:${DESKTOP_DEV_SERVER_PORT}${DESKTOP_RENDERER_MARKER_PATH}`;

export function desktopRendererMarker(): Plugin {
  return {
    name: 'docblocks-desktop-renderer-marker',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== DESKTOP_RENDERER_MARKER_PATH) {
          next();
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end('{"renderer":"docblocks-desktop"}');
      });
    },
  };
}
