import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { thirdPartyComponentManifestPlugin } from '../../../scripts/vite-third-party-manifest.js';

export default defineConfig({
  base: './',
  plugins: [thirdPartyComponentManifestPlugin(), react()],
  root: path.resolve(__dirname),
  build: {
    outDir: path.resolve(__dirname, '../dist/webview'),
    emptyOutDir: true,
    // Known large chunks have surface-specific limits in
    // scripts/check-bundle-size.ts; keep Vite's generic warning aligned.
    chunkSizeWarningLimit: 8_000,
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
        find: '@bendyline/docblocks-react/settings',
        replacement: path.resolve(__dirname, '../../react/src/Settings/public-api.ts'),
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
    // The editor is loaded dynamically from linked Squisq, outside Vite's
    // startup scan. Pre-optimize its direct Tiptap entries so the first opened
    // document does not trigger dependency discovery and a webview reload.
    // Use Monaco's API-only entry here: optimizing the package root pulls the
    // complete editor.main contribution set into VS Code development loads.
    // Mermaid remains explicit for CommonJS dependency interop.
    include: [
      'monaco-editor/esm/vs/editor/editor.api.js',
      '@tiptap/core',
      '@tiptap/react',
      '@tiptap/starter-kit',
      '@tiptap/extension-document',
      '@tiptap/extension-heading',
      '@tiptap/extension-table',
      '@tiptap/extension-table-row',
      '@tiptap/extension-table-cell',
      '@tiptap/extension-table-header',
      '@tiptap/extension-task-list',
      '@tiptap/extension-task-item',
      '@tiptap/extension-list-item',
      '@tiptap/extension-ordered-list',
      '@tiptap/extension-paragraph',
      '@tiptap/extension-placeholder',
      '@tiptap/extension-link',
      '@tiptap/extension-image',
      '@tiptap/extension-mention',
      '@tiptap/extension-text',
      '@tiptap/suggestion',
      '@tiptap/pm/state',
      '@tiptap/pm/view',
      '@tiptap/pm/keymap',
      '@tiptap/pm/model',
      '@tiptap/pm/transform',
      '@tiptap/pm/commands',
      '@tiptap/pm/schema-list',
      'mermaid',
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
