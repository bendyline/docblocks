import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

/**
 * Renderer Vite config. Mirrors packages/site/vite.config.ts but with:
 *   - base: './' so asset URLs resolve under the custom app:// protocol
 *   - outDir: dist/renderer so it sits alongside dist/main + dist/preload
 *   - dev server on port 5221 (site uses 5220)
 */
export default defineConfig({
  root: path.resolve(__dirname, 'renderer'),
  base: './',
  publicDir: path.resolve(__dirname, 'renderer/public'),
  plugins: [react()],
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
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5221,
    strictPort: true,
    open: false,
  },
  optimizeDeps: {
    include: [
      'monaco-editor',
      'localforage',
      'extend',
      'debug',
      'format',
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
      '@bendyline/squisq',
      '@bendyline/squisq-react',
      '@bendyline/squisq-editor-react',
      '@bendyline/squisq-formats',
      '@bendyline/squisq-video',
      '@bendyline/squisq-video-react',
    ],
  },
});
