import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  base: process.env.VITE_BASE || '/',
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
      '@bendyline/docblocks': path.resolve(__dirname, '../core/src/index.ts'),
    },
  },
  server: {
    port: 5220,
    strictPort: true,
    open: true,
  },
  optimizeDeps: {
    include: [
      'monaco-editor',
      // CJS transitive deps that need pre-bundling for ESM compat
      'localforage',
      'extend',
      'debug',
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
