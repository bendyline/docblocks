import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Strips //# sourceMappingURL pragmas from upstream packages whose published
// tarballs reference sourcemaps or sources that aren't actually shipped, so
// Vite stops logging "missing source files" warnings on every dev request.
const stripBrokenSourcemapPragmas = (): Plugin => ({
  name: 'strip-broken-sourcemap-pragmas',
  enforce: 'pre',
  transform(code, id) {
    if (
      id.includes('/@bendyline/squisq-video/dist/') ||
      id.includes('\\@bendyline\\squisq-video\\dist\\') ||
      id.includes('/genson-js/dist/') ||
      id.includes('\\genson-js\\dist\\')
    ) {
      return {
        code: code.replace(/\n?\/\/# sourceMappingURL=.*$/m, ''),
        map: null,
      };
    }
    return null;
  },
});

export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [stripBrokenSourcemapPragmas(), react()],
  resolve: {
    preserveSymlinks: false,
    dedupe: ['react', 'react-dom'],
    alias: {
      '@bendyline/docblocks-react/styles': path.resolve(
        __dirname,
        '../react/src/styles/docblocks.css',
      ),
      '@bendyline/docblocks-react': path.resolve(__dirname, '../react/src/index.ts'),
      '@bendyline/docblocks/filesystem': path.resolve(__dirname, '../core/src/filesystem/index.ts'),
      '@bendyline/docblocks/workspace': path.resolve(__dirname, '../core/src/workspace/index.ts'),
      '@bendyline/docblocks/host': path.resolve(__dirname, '../core/src/host/index.ts'),
      '@bendyline/docblocks': path.resolve(__dirname, '../core/src/index.ts'),
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5220,
    strictPort: true,
    open: true,
    fs: {
      // Allow serving files from the symlinked squisq workspace —
      // its CSS @imports `@fortawesome/fontawesome-free/css/all.min.css`,
      // which then references woff2 webfonts via relative url(). With
      // preserveSymlinks: false those resolve through squisq's realpath,
      // so we need to whitelist it for Vite to serve the font assets.
      allow: [path.resolve(__dirname, '../..'), path.resolve(__dirname, '../../../squisq')],
    },
  },
  optimizeDeps: {
    include: [
      'monaco-editor',
      // CJS transitive deps of squisq packages that need pre-bundling.
      // The squisq packages themselves are excluded (served from source
      // via symlinks for live dev), but their CJS deps must be bundled.
      'localforage',
      'extend',
      'debug',
      'format',
      'genson-js',
      'jszip',
      'ngeohash',
      'pako',
      'lie',
      'immediate',
      'setimmediate',
      'readable-stream',
      'inherits',
      'core-util-is',
      'isarray',
      'safe-buffer',
      'string_decoder',
      'process-nextick-args',
      'util-deprecate',
    ],
    exclude: [
      // Symlinked squisq packages — serve from source for live dev
      '@bendyline/squisq',
      '@bendyline/squisq-react',
      '@bendyline/squisq-editor-react',
      '@bendyline/squisq-formats',
      '@bendyline/squisq-video',
      '@bendyline/squisq-video-react',
    ],
  },
});
