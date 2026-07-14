import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Mirror of the same helper in packages/site/vite.config.ts — see there for
// the rationale.
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

function isDeferredFeatureAsset(fileName: string): boolean {
  const baseName = fileName.replace(/\\/g, '/').split('/').pop() ?? fileName;
  // Keep lazy chunks out of the initial modulePreload: the export pipeline
  // and Monaco (loaded on first editor mount via squisq's canonical
  // `@bendyline/squisq-editor-react/monaco` entry) should not be prefetched
  // up front. Vite names the dynamic-import chunk after `monaco.js`.
  return baseName.startsWith('export-') || baseName.startsWith('monaco');
}

function resolveModulePreloadDependencies(_filename: string, deps: string[]): string[] {
  return deps.filter((dep) => !isDeferredFeatureAsset(dep));
}

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
  plugins: [stripBrokenSourcemapPragmas(), react()],
  resolve: {
    preserveSymlinks: false,
    // Force a single monaco-editor copy — see packages/site/vite.config.ts for
    // the full rationale (linked-dev squisq otherwise pulls a different
    // monaco-editor version for the editor than this app's `?worker` imports
    // use, and the language workers must match the editor's version).
    dedupe: ['react', 'react-dom', 'monaco-editor'],
    alias: [
      // No monaco-editor alias: DocBlocks gets Monaco straight from squisq's
      // canonical entry (`@bendyline/squisq-editor-react/monaco`, loaded by its
      // useMonacoLoader). squisq owns which slice of Monaco ships — DocBlocks no
      // longer maintains its own slim build (an easy way to silently drop the
      // suggest widget, as it did before).
      {
        find: '@bendyline/docblocks-react/styles',
        replacement: path.resolve(__dirname, '../react/src/styles/docblocks.css'),
      },
      {
        find: /^@bendyline\/docblocks-react$/,
        replacement: path.resolve(__dirname, '../react/src/index.ts'),
      },
      {
        find: '@bendyline/docblocks/filesystem/indexeddb',
        replacement: path.resolve(__dirname, '../core/src/filesystem/indexeddb.ts'),
      },
      {
        find: '@bendyline/docblocks/filesystem/memory',
        replacement: path.resolve(__dirname, '../core/src/filesystem/memory.ts'),
      },
      {
        find: '@bendyline/docblocks/filesystem/native',
        replacement: path.resolve(__dirname, '../core/src/filesystem/native.ts'),
      },
      {
        find: '@bendyline/docblocks/filesystem/electron',
        replacement: path.resolve(__dirname, '../core/src/filesystem/electron.ts'),
      },
      {
        find: /^@bendyline\/docblocks\/filesystem$/,
        replacement: path.resolve(__dirname, '../core/src/filesystem/index.ts'),
      },
      {
        find: '@bendyline/docblocks/workspace',
        replacement: path.resolve(__dirname, '../core/src/workspace/index.ts'),
      },
      {
        find: '@bendyline/docblocks/host',
        replacement: path.resolve(__dirname, '../core/src/host/index.ts'),
      },
      {
        find: '@bendyline/docblocks/document',
        replacement: path.resolve(__dirname, '../core/src/document/index.ts'),
      },
      {
        find: /^@bendyline\/docblocks$/,
        replacement: path.resolve(__dirname, '../core/src/index.ts'),
      },
    ],
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    sourcemap: true,
    // Known large chunks have surface-specific limits in
    // scripts/check-bundle-size.ts; keep Vite's generic warning aligned.
    chunkSizeWarningLimit: 4_000,
    modulePreload: {
      resolveDependencies: resolveModulePreloadDependencies,
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5221,
    strictPort: true,
    open: false,
    fs: {
      // Local Squisq development uses package symlinks into ../squisq.
      // Its editor CSS imports Font Awesome, whose relative webfont URLs
      // resolve through that real path and must be served by Vite.
      allow: [path.resolve(__dirname, '../..'), path.resolve(__dirname, '../../../squisq')],
    },
  },
  optimizeDeps: {
    include: [
      'monaco-editor',
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
      '@bendyline/squisq',
      '@bendyline/squisq-react',
      '@bendyline/squisq-editor-react',
      '@bendyline/squisq-formats',
      '@bendyline/squisq-video',
      '@bendyline/squisq-video-react',
    ],
  },
});
