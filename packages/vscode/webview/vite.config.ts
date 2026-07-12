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
    // Force a single monaco-editor copy — see packages/site/vite.config.ts for
    // the rationale (the editor comes from linked squisq, the language-service
    // `?worker` imports from this package's copy; they must be one version).
    dedupe: ['react', 'react-dom', 'monaco-editor'],
    alias: [
      // No monaco-editor alias: the webview gets Monaco straight from squisq's
      // canonical entry (`@bendyline/squisq-editor-react/monaco`, via its
      // useMonacoLoader). squisq owns which slice of Monaco ships — no local
      // slim build to maintain (or to silently drop the suggest widget).
      {
        find: '@bendyline/docblocks-react/styles',
        replacement: path.resolve(__dirname, '../../react/src/styles/docblocks.css'),
      },
      {
        find: '@bendyline/docblocks-react/export',
        replacement: path.resolve(__dirname, '../../react/src/Export/public-api.ts'),
      },
      {
        find: /^@bendyline\/docblocks-react$/,
        replacement: path.resolve(__dirname, '../../react/src/index.ts'),
      },
      {
        find: '@bendyline/docblocks/filesystem/indexeddb',
        replacement: path.resolve(__dirname, '../../core/src/filesystem/indexeddb.ts'),
      },
      {
        find: '@bendyline/docblocks/filesystem/memory',
        replacement: path.resolve(__dirname, '../../core/src/filesystem/memory.ts'),
      },
      {
        find: '@bendyline/docblocks/filesystem/native',
        replacement: path.resolve(__dirname, '../../core/src/filesystem/native.ts'),
      },
      {
        find: '@bendyline/docblocks/filesystem/electron',
        replacement: path.resolve(__dirname, '../../core/src/filesystem/electron.ts'),
      },
      {
        find: /^@bendyline\/docblocks\/filesystem$/,
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
        find: '@bendyline/docblocks/document',
        replacement: path.resolve(__dirname, '../../core/src/document/index.ts'),
      },
      {
        find: '@bendyline/docblocks/vscode',
        replacement: path.resolve(__dirname, '../../core/src/vscode/index.ts'),
      },
      {
        find: /^@bendyline\/docblocks$/,
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
