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

const monacoSlimEntry = path.resolve(__dirname, '../react/src/monaco-slim.ts');

function isDeferredFeatureAsset(fileName: string): boolean {
  const baseName = fileName.replace(/\\/g, '/').split('/').pop() ?? fileName;
  return baseName.startsWith('export-') || baseName.startsWith('monaco-slim');
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
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: /^monaco-editor$/, replacement: monacoSlimEntry },
      {
        find: /^monaco-editor\/esm\/vs\/editor\/editor\.main\.js$/,
        replacement: monacoSlimEntry,
      },
      {
        find: '@bendyline/docblocks-react/styles',
        replacement: path.resolve(__dirname, '../react/src/styles/docblocks.css'),
      },
      {
        find: '@bendyline/docblocks-react',
        replacement: path.resolve(__dirname, '../react/src/index.ts'),
      },
      {
        find: '@bendyline/docblocks/filesystem',
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
        find: '@bendyline/docblocks',
        replacement: path.resolve(__dirname, '../core/src/index.ts'),
      },
    ],
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    sourcemap: true,
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
