import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  base: './',
  plugins: [react()],
  root: path.resolve(__dirname),
  build: {
    outDir: path.resolve(__dirname, '../dist/webview'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'index.js',
        assetFileNames: '[name][extname]',
      },
    },
  },
  resolve: {
    preserveSymlinks: false,
    dedupe: ['react', 'react-dom'],
    alias: [
      // Slim Monaco — only markdown + common fenced-code-block languages.
      // Exact match on bare 'monaco-editor' (not subpath imports like 'monaco-editor/esm/...')
      {
        find: /^monaco-editor$/,
        replacement: path.resolve(__dirname, 'src/monaco-slim.ts'),
      },
      {
        find: '@bendyline/docblocks-react/styles',
        replacement: path.resolve(__dirname, '../../react/src/styles/docblocks.css'),
      },
      {
        find: '@bendyline/docblocks-react',
        replacement: path.resolve(__dirname, '../../react/src/index.ts'),
      },
      {
        find: '@bendyline/docblocks/filesystem',
        replacement: path.resolve(__dirname, '../../core/src/filesystem/index.ts'),
      },
      {
        find: '@bendyline/docblocks/workspace',
        replacement: path.resolve(__dirname, '../../core/src/workspace/index.ts'),
      },
      {
        find: '@bendyline/docblocks/host',
        replacement: path.resolve(__dirname, '../../core/src/host/index.ts'),
      },
      {
        find: '@bendyline/docblocks',
        replacement: path.resolve(__dirname, '../../core/src/index.ts'),
      },
    ],
  },
  optimizeDeps: {
    include: ['monaco-editor'],
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
