import { expect } from 'chai';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ViteDevServer } from 'vite';
import {
  DESKTOP_RENDERER_MARKER_PATH,
  DESKTOP_RENDERER_MARKER_URL,
  desktopRendererMarker,
} from '../scripts/dev-renderer-marker.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

const { portAcceptsConnections } = require('../scripts/dev.cjs') as {
  portAcceptsConnections: (port: number) => Promise<boolean>;
};

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Requests over node:http rather than the global fetch: the workspace Mocha
 * setup registers happy-dom, whose fetch applies browser CORS from
 * http://localhost/ and refuses to read a response from 127.0.0.1.
 */
function request(url: string, method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Serves the marker plugin's middleware the way Vite's connect stack would. */
async function serveMarker(): Promise<{ server: http.Server; origin: string }> {
  let middleware: Middleware | undefined;
  const devServer = {
    middlewares: {
      use: (handler: Middleware) => {
        middleware = handler;
      },
    },
  } as unknown as ViteDevServer;
  const hook = desktopRendererMarker().configureServer;
  const configure = typeof hook === 'function' ? hook : hook?.handler;
  await configure?.call({} as never, devServer);
  expect(middleware, 'plugin registered no middleware').not.to.equal(undefined);

  const server = http.createServer((req, res) =>
    middleware?.(req, res, () => {
      res.statusCode = 404;
      res.end();
    }),
  );
  const port = await listen(server);
  return { server, origin: `http://127.0.0.1:${port}` };
}

describe('desktop dev renderer marker', () => {
  it('makes dev:electron wait for the desktop renderer, not any server on its port', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };

    expect(manifest.scripts['dev:electron']).to.match(
      new RegExp(
        `^wait-on ${DESKTOP_RENDERER_MARKER_URL.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} && `,
        'u',
      ),
    );
  });

  it('answers the marker path and passes every other request through', async () => {
    const { server, origin } = await serveMarker();
    try {
      const marker = await request(`${origin}${DESKTOP_RENDERER_MARKER_PATH}`);
      expect(marker.status).to.equal(200);
      expect(JSON.parse(marker.body)).to.deep.equal({ renderer: 'docblocks-desktop' });
      // wait-on probes with HEAD.
      const head = await request(`${origin}${DESKTOP_RENDERER_MARKER_PATH}`, 'HEAD');
      expect(head.status).to.equal(200);

      expect((await request(`${origin}/`)).status).to.equal(404);
      expect((await request(`${origin}/__docblocks/desktop-renderer.jsonx`)).status).to.equal(404);
    } finally {
      await close(server);
    }
  });

  it('notices a server already holding the renderer port', async () => {
    const server = http.createServer((_req, res) => res.end());
    const port = await listen(server);
    try {
      expect(await portAcceptsConnections(port)).to.equal(true);
    } finally {
      await close(server);
    }
    expect(await portAcceptsConnections(port)).to.equal(false);
  });
});
