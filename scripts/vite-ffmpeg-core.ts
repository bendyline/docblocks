import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Connect, Plugin } from 'vite';

export const CROSS_ORIGIN_ISOLATION_HEADERS = Object.freeze({
  // ffmpeg.wasm uses SharedArrayBuffer. `credentialless` keeps same-origin
  // isolation without blocking the blob-backed media used during capture.
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Publish the pinned ffmpeg.wasm core used by Squisq's browser GIF encoder.
 * The core stays a deferred, same-origin runtime asset instead of entering a
 * JavaScript bundle. Its GPL notice, license, and source pointers travel with
 * both the site and Electron renderer distributions.
 */
export function ffmpegCorePlugin(): Plugin {
  const coreDir = path.join(repoRoot, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm');
  const noticeDir = path.join(repoRoot, 'node_modules', '@bendyline', 'squisq-video-react');
  const publishedFiles = new Map<string, string>([
    ['ffmpeg-core.js', path.join(coreDir, 'ffmpeg-core.js')],
    ['ffmpeg-core.wasm', path.join(coreDir, 'ffmpeg-core.wasm')],
    ['NOTICE.txt', path.join(noticeDir, 'NOTICE.md')],
    ['COPYING.GPL-2.0.txt', path.join(noticeDir, 'COPYING.GPL-2.0.txt')],
    ['THIRD_PARTY_LICENSES.txt', path.join(noticeDir, 'THIRD_PARTY_LICENSES.txt')],
  ]);

  const servePublishedFile: Connect.NextHandleFunction = (request, response, next) => {
    const pathname = request.url?.split('?', 1)[0] ?? '';
    const match = /(?:^|\/)ffmpeg-core\/([^/]+)$/u.exec(pathname);
    const sourcePath = match?.[1] ? publishedFiles.get(match[1]) : undefined;
    if (!sourcePath || !fs.existsSync(sourcePath)) return next();

    const stat = fs.statSync(sourcePath);
    response.setHeader('Content-Length', stat.size);
    response.setHeader(
      'Content-Type',
      pathname.endsWith('.wasm')
        ? 'application/wasm'
        : pathname.endsWith('.js')
          ? 'text/javascript; charset=utf-8'
          : 'text/plain; charset=utf-8',
    );
    fs.createReadStream(sourcePath).pipe(response);
  };

  return {
    name: 'docblocks-ffmpeg-core',
    configureServer(server) {
      server.middlewares.use(servePublishedFile);
    },
    configurePreviewServer(server) {
      server.middlewares.use(servePublishedFile);
    },
    writeBundle(options) {
      const outDir = options.dir;
      if (!outDir) throw new Error('ffmpeg core publishing requires a directory build output.');

      const destinationDir = path.join(outDir, 'ffmpeg-core');
      fs.mkdirSync(destinationDir, { recursive: true });
      for (const [fileName, sourcePath] of publishedFiles) {
        fs.copyFileSync(sourcePath, path.join(destinationDir, fileName));
      }
    },
  };
}
